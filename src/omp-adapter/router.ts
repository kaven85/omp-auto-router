/**
 * Router stream handler — Mode A.
 *
 * Registered as the `auto-router` provider's custom stream function. For each
 * request: runs the core pipeline over the request's profile (derived from the
 * selected virtual model `auto-router/<profile>`), rewrites the shortcut token
 * out of the last user message, then streams the decision's ordered candidate
 * chain through failoverStream, delegating each candidate to the host's
 * pi-ai `streamSimple` with host-resolved credentials.
 *
 * Host-bundled imports (`@oh-my-pi/pi-ai`) are resolved by the omp loader at
 * runtime; the ambient shims in omp-api.ts satisfy local tsc only.
 */

import { streamSimple } from "@oh-my-pi/pi-ai";
import { isProviderRetryableError } from "@oh-my-pi/pi-ai/error";

import { failoverStream, defaultIsRetryable, defaultIsSubstantive } from "../core/failover-engine";
import { route } from "../core/pipeline";
import type { QuotaSnapshot } from "../core/types";
import type { AdapterState } from "./state";
import { enrichCandidates, createHostPorts } from "./host-ports";
import type { OmpExtensionApi, OmpExtensionContext } from "./omp-api";
import { redactSecrets } from "./redact";

export interface StreamArgs {
	model: { provider: string; id: string };
	context: {
		systemPrompt?: string[];
		messages: Array<{ role: string; content: unknown }>;
		tools?: unknown[];
	};
	options?: { signal?: AbortSignal; [k: string]: unknown };
}

/** Extract the last user message's text and whether it carries images. */
function lastUserText(context: StreamArgs["context"]): { text: string; hasImages: boolean } {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (!message || message.role !== "user") continue;
		const content = message.content;
		const parts = Array.isArray(content) ? content : [];
		const text = parts
			.filter((p): p is { type: string; text?: string } => typeof p === "object" && p !== null && "text" in p)
			.map((p) => p.text ?? "")
			.join("");
		const hasImages = parts.some((p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "image");
		return { text, hasImages };
	}
	return { text: "", hasImages: false };
}

/** Replace the text parts of the last user message with `text`, keeping non-text parts (images, files) in place. */
function rewriteLastUserText(context: StreamArgs["context"], text: string): void {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (!message || message.role !== "user") continue;
		const content = message.content;
		if (Array.isArray(content)) {
			const kept: unknown[] = [];
			for (const part of content) {
				if (typeof part === "object" && part !== null && "type" in part && part.type !== "text") {
					kept.push(part);
				}
			}
			content.length = 0;
			content.push({ type: "text", text }, ...kept);
		}
		return;
	}
}

/** Build the delegate factory: each candidate → host streamSimple with its key. */
function buildFactory(
	state: AdapterState,
	pi: OmpExtensionApi,
	context: StreamArgs["context"],
	options: StreamArgs["options"],
) {
	const host = createHostPorts(pi, state.ctx!, state);
	return async function* factory(target: { provider: string; model: string }) {
		const model = state.ctx?.models.resolve(`${target.provider}/${target.model}`);
		if (!model) {
			throw new Error(`auto-router: target not resolvable: ${target.provider}/${target.model}`);
		}
		const apiKey = await host.getApiKey(target);
		const stream = streamSimple(model as never, context as never, {
			...(options ?? {}),
			...(apiKey !== undefined ? { apiKey } : {}),
		} as never);
		for await (const event of stream) {
			yield event as never;
		}
	};
}
async function waitForConfiguredModel(
	ctx: OmpExtensionContext,
	targets: Array<{ provider: string; model: string }>,
	signal?: AbortSignal,
): Promise<void> {
	const retryDelayMs = 50;
	const maxAttempts = 100;
	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		for (const target of targets) {
			if (ctx.models.resolve(`${target.provider}/${target.model}`)) return;
		}
		if (attempt === maxAttempts || signal?.aborted) return;
		await new Promise<void>((resolve) => {
			ctx.setTimeout(resolve, retryDelayMs);
		});
	}
}

export function createStreamHandler(
	state: AdapterState,
	pi: OmpExtensionApi,
	args: StreamArgs,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
	return (async function* handler() {
		const ctx = state.ctx;
		if (!ctx) {
			yield* failWith("auto-router: session context not ready (stream before session_start)");
			return;
		}
		const profileName = args.model.id.replace(/^auto-router\//, "");
		const { text: rawPrompt, hasImages } = lastUserText(args.context);
		const priorTier = state.decisions.last()?.tier as "trivial" | "simple" | "standard" | "complex" | undefined;

		const host = createHostPorts(pi, ctx, state);
		const profile = state.registry.profile(profileName);
		if (!profile) {
			yield* failWith(`auto-router: unknown profile "${profileName}"`);
			return;
		}
		const allTargets = Object.values(profile.tiers).flatMap((t) => t.targets);

		// Quota snapshots feed UVI; throttled to once per 30s.
		let quota: Record<string, QuotaSnapshot> = {};
		if (state.uviEnabled && state.ctx) {
			const providers = [...new Set(allTargets.map((t) => t.provider))];
			const nowMs = Date.now();
			if (nowMs - state.quotaCache.at >= 30_000) {
				const snapshots = await host.fetchQuota(providers);
				state.quotaCache = { at: nowMs, data: snapshots };
			}
			for (const snapshot of state.quotaCache.data) {
				quota[snapshot.provider] = snapshot;
			}
		}
		// Custom providers are discovered asynchronously during host startup.
		// Give the live registry a bounded grace period before excluding them.
		await waitForConfiguredModel(ctx, allTargets, args.options?.signal);
		// Candidates = active profile's tier targets enriched from the live host registry.
		// The pipeline resolves the tier internally; we feed it the full profile target set.
		const candidates = enrichCandidates(host, allTargets);

		const now = new Date();
		const { decision, cleanPrompt } = route(
			{
				rawPrompt,
				profile: profileName,
				hasImages,
				conversationDepth: state.decisions.list().length,
				...(priorTier !== undefined ? { priorTier } : {}),
				candidates,
				quota,
				now,
			},
			{
				registry: state.registry,
				circuit: state.circuit,
				latency: state.latency,
				budgets: state.budgets,
			},
		);

		// Shadow mode: keep the decision for explain/stats, but actually route
		// in the selected tier's literal config order (no partition reordering).
		let finalOrder = decision.orderedCandidates;
		if (state.shadowEnabled) {
			const tierCfg = state.registry.tierConfig(profileName, decision.tier);
			finalOrder =
				tierCfg?.targets.filter((t) => host.isHealthy(t)) ?? [];
			decision.orderedCandidates = finalOrder;
			decision.target = finalOrder[0] ?? decision.target;
		}

		// Record + persist the decision for /auto-router explain.
		state.decisions.record(decision);
		state.lastDecision = { at: now.getTime(), decision, cleanPrompt };
		pi.appendEntry("com.omp.auto-router.decision", decision);
		state.eventLog.append({ type: "decision", at: now.getTime(), profile: decision.profile, tier: decision.tier, target: decision.target });
		host.setStatus(
			`auto-router ${decision.profile} | tier=${decision.tier} (${decision.confidence.toFixed(2)}) | ${decision.target.provider}/${decision.target.model}${decision.thinking !== undefined ? ` | thinking=${decision.thinking}` : ""}`,
		);

		// Strip the router tokens before the model ever sees the prompt.
		rewriteLastUserText(args.context, cleanPrompt);

		// Failover across the ordered chain; thinking-only partials stay failover-eligible.
		const started = Date.now();
		let settledTarget: { provider: string; model: string } | undefined;
		const hooks = {
			// Fail over on transient provider errors (omp classifier) OR on
			// billing/quota/permission exhaustion (module wording classifier) —
			// an exhausted provider must never hard-stop the failover chain.
			isRetryable: (error: unknown) =>
				isProviderRetryableError(error) || defaultIsRetryable(error),
			isSubstantive: defaultIsSubstantive,
			onTargetFailed: (target: { provider: string; model: string }, error: unknown) => {
				state.circuit.recordFailure(`${target.provider}/${target.model}`, Date.now());
				state.eventLog.append({
					type: "error",
					at: Date.now(),
					provider: target.provider,
					model: target.model,
					error: redactSecrets(String(error)),
				});
			},
			onFailover: (from: { provider: string; model: string }, to: { provider: string; model: string }, error: unknown) => {
				state.eventLog.append({
					type: "failover",
					at: Date.now(),
					from: `${from.provider}/${from.model}`,
					to: `${to.provider}/${to.model}`,
					error: redactSecrets(String(error)),
				});
			},
			onTargetSettled: (target: { provider: string; model: string }) => {
				settledTarget = target;
				state.circuit.recordSuccess(`${target.provider}/${target.model}`);
				state.latency.record(`${target.provider}/${target.model}`, Date.now() - started);
				if (!state.shadowEnabled) {
					const key = `${target.provider}/${target.model}`;
					state.sessionUseage.calls.set(key, (state.sessionUseage.calls.get(key) ?? 0) + 1);
					if (decision.thinking !== undefined) {
						let seen = state.sessionUseage.thinking.get(key);
						if (!seen) {
							seen = new Set<string>();
							state.sessionUseage.thinking.set(key, seen);
						}
						seen.add(decision.thinking);
					}
				}
			},
		};

		const factory = buildFactory(state, pi, args.context, args.options);
		for await (const event of failoverStream(finalOrder, factory, hooks, { signal: args.options?.signal })) {
			if (event.type === "done" && settledTarget && typeof event.message === "object" && event.message !== null) {
				recordUsage(state, settledTarget, (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage);
			}
			yield event;
		}
	})();
}

/** Estimate USD from provider-reported token usage × the target model's pricing. */
function recordUsage(
	state: AdapterState,
	target: { provider: string; model: string },
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
): void {
	if (!usage) return;
	const model = state.ctx?.models.resolve(`${target.provider}/${target.model}`);
	const cost = model?.cost;
	const inputTokens = usage.input ?? 0;
	const outputTokens = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const estimatedCost = cost
		? (inputTokens * cost.input + outputTokens * cost.output + cacheRead * cost.cacheRead + cacheWrite * cost.cacheWrite) / 1_000_000
		: 0;
	state.budgets.record(
		target.provider,
		{ inputTokens, outputTokens, cost: estimatedCost },
		new Date(),
	);
	if (!state.shadowEnabled) {
		const key = `${target.provider}/${target.model}`;
		state.sessionUseage.cost.set(key, (state.sessionUseage.cost.get(key) ?? 0) + estimatedCost);
	}
	state.eventLog.append({
		type: "settled",
		at: Date.now(),
		provider: target.provider,
		model: target.model,
		inputTokens,
		outputTokens,
		estimatedCost,
	});
}

async function* failWith(message: string): AsyncGenerator<{ type: string; [k: string]: unknown }> {
	// OMP clones terminal messages by reading `message.usage.cost`
	// unconditionally. Adapter-generated errors must therefore satisfy the
	// same AssistantMessage contract as provider-generated stream events.
	yield {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [{ type: "text", text: message }],
			api: "auto-router",
			provider: "auto-router",
			model: "auto-router",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
		},
	};
}
