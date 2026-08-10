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
import type { FeedbackTracker } from "../core/feedback-tracker";
import type { HostPorts } from "../core/host-ports";
import { route } from "../core/pipeline";
import { clampThinking } from "../core/thinking-cap";
import type { QuotaSnapshot, RoutingDecision } from "../core/types";
import type { AdapterState } from "./state";
import { persistTrackers } from "./state";
import { enrichCandidates, createHostPorts, quotaRefreshMs } from "./host-ports";
import type { OmpExtensionApi, OmpExtensionContext } from "./omp-api";
import { resolveThinkingCap } from "./provider-registry";
import { redactSecrets } from "./redact";

/** Transient exclusion window after a target fails within a failover chain. */
const COOLDOWN_AFTER_FAILURE_MS = 5 * 60_000;

/**
 * Rating feedback loop (demote-only): candidates with enough ratings and a
 * low good fraction move behind the rest. Demotion is stable and never
 * removes a candidate — a badly rated target still serves as failover.
 */
function demotePoorlyRated<T extends { provider: string; model: string }>(
	order: readonly T[],
	ratings: FeedbackTracker,
): T[] {
	const poorly = (t: T): boolean => {
		const stats = ratings.statsFor(t.provider, t.model);
		return stats.total >= RATING_MIN_SAMPLES && stats.goodFraction < RATING_DEMOTE_BELOW;
	};
	const front = order.filter((t) => !poorly(t));
	const back = order.filter(poorly);
	return back.length === 0 ? [...order] : [...front, ...back];
}

/** Minimum ratings before a candidate's good fraction is trusted. */
const RATING_MIN_SAMPLES = 5;
/** Good fraction below which a candidate is demoted. */
const RATING_DEMOTE_BELOW = 0.4;

/** How long a failed test/build command keeps the tier floor raised. */
const TEST_FAILURE_ESCALATION_MS = 10 * 60_000;

/**
 * How long a request waits for `session_start` to land on the state before
 * failing. Requests can reach the virtual provider before the boot event
 * (early prompts, subagent spawn races, extension hot-reload mid-session);
 * a bounded wait mirrors `waitForConfiguredModel` so a slow boot doesn't
 * fail the first request.
 */
const CTX_READY_WAIT_MS = 5_000;

const TIER_LADDER = ["trivial", "simple", "standard", "complex"] as const;

/**
 * Compose the dashboard widget: decision line (when a decision exists) plus
 * live budget/circuit/UVI snapshots. UVI windows past their `resetsAt` are
 * shown as freshly reset — the cached fetch would otherwise keep displaying
 * the pre-reset usage until the next poll.
 */
export function buildWidgetLines(state: AdapterState, decision?: RoutingDecision): string[] {
	const lines: string[] = [];
	if (decision !== undefined) {
		lines.push(
			`${decision.profile} | tier=${decision.tier} | ${decision.target.provider}/${decision.target.model}${decision.thinking !== undefined ? ` | ${decision.thinking}` : ""}`,
		);
	}
	const budgetBits: string[] = [];
	for (const [provider, limit] of Object.entries(state.budgets.limits())) {
		const bucket = limit.monthly ? state.budgets.usage(provider).monthly : state.budgets.usage(provider).daily;
		const used = bucket?.cost ?? 0;
		const pct = limit.amount > 0 ? Math.round((used / limit.amount) * 100) : 0;
		budgetBits.push(`${provider} $${used.toFixed(2)}/$${limit.amount}${limit.monthly ? "/mo" : "/day"} (${pct}%)`);
	}
	if (budgetBits.length > 0) lines.push(`budgets: ${budgetBits.join(" · ")}`);
	const openCircuits = Object.entries(state.circuit.snapshot())
		.filter(([, rec]) => Date.now() - rec.openedAt < rec.cooldownMs)
		.map(([key, rec]) => `${key} (${rec.consecutiveFailures}x)`);
	if (openCircuits.length > 0) lines.push(`circuit open: ${openCircuits.join(" · ")}`);
	if (state.uviEnabled && state.quotaCache.data.length > 0) {
		const nowMs = Date.now();
		const uviBits = state.quotaCache.data.map((snapshot) => {
			const worst = Math.max(
				0,
				...snapshot.windows.map((window) =>
					window.resetsAt !== undefined && window.resetsAt <= nowMs ? 0 : window.usedFraction,
				),
			);
			return `${snapshot.provider} ${(100 - worst * 100).toFixed(0)}% left`;
		});
		lines.push(`uvi: ${uviBits.join(" · ")}`);
	}
	return lines;
}

/** Last rendered widget payload; identical re-renders are suppressed. */
let lastWidgetPayload: string | undefined;

/**
 * Render the dashboard widget, skipping no-op updates. Shared by the request
 * path (new decision) and the background quota refresh (fresh UVI data) so
 * the widget reflects cache changes within one refresh cadence without
 * re-rendering when nothing changed.
 */
export function renderWidget(
	state: AdapterState,
	host: Pick<HostPorts, "setWidget">,
	decision?: RoutingDecision,
): void {
	const lines = buildWidgetLines(state, decision);
	if (lines.length === 0) return;
	const payload = lines.join("\n");
	if (payload === lastWidgetPayload) return;
	lastWidgetPayload = payload;
	host.setWidget(lines);
}

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
	onTargetStart?: (target: { provider: string; model: string }) => void,
) {
	const host = createHostPorts(pi, state.ctx!, state);
	return async function* factory(target: { provider: string; model: string }) {
		onTargetStart?.(target);
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

/**
 * Wait for the host's `session_start` to land on this state before routing.
 * Polls `state.ctx` (bounded by `timeoutMs`, abortable) instead of failing
 * immediately — the first request of a session can stream before the boot
 * event handler runs. Returns undefined when the grace period elapses or the
 * request is aborted.
 */
export async function waitForSessionContext(
	state: AdapterState,
	signal?: AbortSignal,
	timeoutMs: number = CTX_READY_WAIT_MS,
): Promise<OmpExtensionContext | undefined> {
	if (state.ctx) return state.ctx;
	const deadline = Date.now() + timeoutMs;
	while (!signal?.aborted) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, Math.min(remaining, 50));
		});
		if (state.ctx) return state.ctx;
	}
	return undefined;
}

/** Read optional tuning flags from the environment; all are documented in README.md. */
function readEnvFlag(name: string): boolean {
	return process.env[name] === "1" || process.env[name] === "true";
}

function readEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function createPipelineFlags(): { uviHardMode: boolean; confidenceThreshold: number } {
	return {
		uviHardMode: readEnvFlag("OMP_AUTO_ROUTER_UVI_HARD"),
		confidenceThreshold: readEnvNumber("OMP_AUTO_ROUTER_CONFIDENCE_THRESHOLD", 0.45),
	};
}

/** Extract a usable token estimate from the host, or undefined if not available. */
function resolveEstimatedTokens(ctx: OmpExtensionContext, context: StreamArgs["context"]): number | undefined {
	try {
		const usage = ctx.getContextUsage();
		if (typeof usage === "number" && Number.isFinite(usage) && usage > 0) {
			return Math.ceil(usage);
		}
		if (typeof usage === "object" && usage !== null) {
			const u = usage as Record<string, unknown>;
			const tokenValue = u.totalTokens ?? u.tokens ?? u.contextTokens ?? u.inputTokens;
			if (typeof tokenValue === "number" && Number.isFinite(tokenValue) && tokenValue > 0) {
				return Math.ceil(tokenValue);
			}
		}
	} catch {
		// Host may not implement getContextUsage; fall through to heuristic.
	}
	// Fallback: sum all textual content (messages + system prompts).
	let chars = 0;
	for (const msg of context.messages) {
		if (typeof msg.content === "string") {
			chars += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
					chars += part.text.length;
				}
			}
		}
	}
	for (const text of context.systemPrompt ?? []) {
		chars += text.length;
	}
	const estimated = Math.ceil(chars / 4);
	return estimated > 0 ? estimated : undefined;
}

export function createStreamHandler(
	state: AdapterState,
	pi: OmpExtensionApi,
	args: StreamArgs,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
	return (async function* handler() {
		const ctx = await waitForSessionContext(state, args.options?.signal);
		if (!ctx) {
			yield* failWith(
				"auto-router: session context not ready — no session_start received before the request; restart the omp session or reload the extension",
			);
			return;
		}
		const profileName = args.model.id.replace(/^auto-router\//, "");
		const { text: rawPrompt, hasImages } = lastUserText(args.context);
		let priorTier = state.decisions.last()?.tier as "trivial" | "simple" | "standard" | "complex" | undefined;
		// Test/build failure escalation: for a short window after a failing test
		// command the tier floor rises one level — the next prompt is very likely
		// a debugging task that warrants a stronger model.
		if (
			state.testFailureAt !== undefined &&
			Date.now() - state.testFailureAt < TEST_FAILURE_ESCALATION_MS &&
			priorTier !== "complex"
		) {
			const floor = priorTier ?? "simple";
			priorTier = TIER_LADDER[Math.min(TIER_LADDER.indexOf(floor) + 1, TIER_LADDER.length - 1)];
		}

		const host =
			state.hostPorts?.ctx === ctx
				? state.hostPorts.host
				: (state.hostPorts = { ctx, host: createHostPorts(pi, ctx, state) }).host;
		const profile = state.registry.profile(profileName);
		if (!profile) {
			yield* failWith(`auto-router: unknown profile "${profileName}"`);
			return;
		}
		const allTargets = Object.values(profile.tiers).flatMap((t) => t.targets);
		const estimatedTokens = resolveEstimatedTokens(ctx, args.context);

		// Quota snapshots feed UVI; throttled to once per 30s.
		let quota: Record<string, QuotaSnapshot> = {};
		if (state.uviEnabled && state.ctx) {
			const providers = [...new Set(allTargets.map((t) => t.provider))];
			const nowMs = Date.now();
			if (nowMs - state.quotaCache.at >= quotaRefreshMs()) {
				const snapshots = await host.fetchQuota(providers);
				state.quotaCache = { at: nowMs, data: snapshots };
			}
			for (const snapshot of state.quotaCache.data) {
				quota[snapshot.provider] = snapshot;
			}
		}
		// Custom providers are discovered asynchronously during host startup.
		// Give the live registry a bounded grace period once per session; after
		// the first successful resolve we stop polling (modelsReady).
		if (!state.modelsReady) {
			await waitForConfiguredModel(ctx, allTargets, args.options?.signal);
			state.modelsReady = true;
		}
		// Candidates = active profile's tier targets enriched from the live host registry.
		// The pipeline resolves the tier internally; we feed it the full profile target set.
		const candidates = enrichCandidates(host, allTargets, state.cooldowns);

		const now = new Date();
		const flags = createPipelineFlags();
		const { decision, cleanPrompt } = route(
			{
				rawPrompt,
				profile: profileName,
				hasImages,
				conversationDepth: state.decisions.list().length,
				...(priorTier !== undefined ? { priorTier } : {}),
				candidates,
				quota,
				...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
				now,
			},
			{
				registry: state.registry,
				circuit: state.circuit,
				latency: state.latency,
				budgets: state.budgets,
				uviHardMode: flags.uviHardMode,
				confidenceThreshold: flags.confidenceThreshold,
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
		} else {
			// Rating feedback loop: candidates the user keeps rating badly are
			// demoted to the back of the chain (stable — relative order kept).
			finalOrder = demotePoorlyRated(finalOrder, state.ratings);
			decision.orderedCandidates = finalOrder;
			decision.target = finalOrder[0] ?? decision.target;
		}

		// No eligible candidate: failoverStream would throw a bare programmer
		// error, so fail with an actionable message instead. Exclusion reasons
		// from the pipeline (unhealthy / cooldown / circuit / UVI / capability)
		// explain what the user can fix.
		if (finalOrder.length === 0) {
			state.decisions.record(decision);
			state.lastDecision = { at: now.getTime(), decision, cleanPrompt };
			pi.appendEntry("com.omp.auto-router.decision", decision);
			state.eventLog.append({ type: "decision", at: now.getTime(), profile: decision.profile, tier: decision.tier, target: decision.target });
			const exclusions = decision.reasoning.filter((line) => line.startsWith("excluded "));
			const detail = exclusions.length > 0 ? ` — ${exclusions.join("; ")}` : "";
			yield* failWith(
				`auto-router: no eligible candidates for profile "${profileName}" tier=${decision.tier}${detail}`,
			);
			return;
		}

		// Record + persist the decision for /auto-router explain.
		state.decisions.record(decision);
		state.lastDecision = { at: now.getTime(), decision, cleanPrompt };
		pi.appendEntry("com.omp.auto-router.decision", decision);
		state.eventLog.append({
			type: "decision",
			at: now.getTime(),
			profile: decision.profile,
			tier: decision.tier,
			target: decision.target,
			...(decision.thinking !== undefined ? { thinking: decision.thinking } : {}),
		});
		host.setStatus(
			`auto-router ${decision.profile} | tier=${decision.tier} (${decision.confidence.toFixed(2)}) | ${decision.target.provider}/${decision.target.model}${decision.thinking !== undefined ? ` | thinking=${decision.thinking}` : ""}`,
		);
		renderWidget(state, host, decision);

		// Strip the router tokens before the model ever sees the prompt.
		rewriteLastUserText(args.context, cleanPrompt);

		// Failover across the ordered chain; thinking-only partials stay failover-eligible.
		const started = Date.now();
		const targetStarts = new Map<string, number>();
		let settledTarget: { provider: string; model: string } | undefined;
		const hooks = {
			// Fail over on transient provider errors (omp classifier) OR on
			// billing/quota/permission exhaustion (module wording classifier) —
			// an exhausted provider must never hard-stop the failover chain.
			isRetryable: (error: unknown) =>
				isProviderRetryableError(error) || defaultIsRetryable(error),
			isSubstantive: defaultIsSubstantive,
			onTargetFailed: (target: { provider: string; model: string }, error: unknown) => {
				const key = `${target.provider}/${target.model}`;
				state.circuit.recordFailure(key, Date.now());
				// Transient cooldown: the solver excludes the target for a few
				// minutes so subsequent requests skip it instead of rediscovering
				// the failure on every prompt.
				state.cooldowns.set(key, Date.now() + COOLDOWN_AFTER_FAILURE_MS);
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
				const key = `${target.provider}/${target.model}`;
				state.circuit.recordSuccess(key);
				state.cooldowns.delete(key);
				// Latency is measured from THIS target's stream start, not the
				// failover chain's — otherwise a slow dead first candidate would
				// poison the rolling mean of the fallback that actually answered.
				const targetStart = targetStarts.get(key) ?? started;
				state.latency.record(key, Date.now() - targetStart);
				if (!state.shadowEnabled) {
					const key = `${target.provider}/${target.model}`;
					state.sessionUsage.calls.set(key, (state.sessionUsage.calls.get(key) ?? 0) + 1);
					if (decision.thinking !== undefined) {
						let seen = state.sessionUsage.thinking.get(key);
						if (!seen) {
							seen = new Set<string>();
							state.sessionUsage.thinking.set(key, seen);
						}
						seen.add(decision.thinking);
					}
				}
			},
		};

		const factory = buildFactory(state, pi, args.context, args.options, (target) => {
			targetStarts.set(`${target.provider}/${target.model}`, Date.now());
		});

		// Apply the tier's thinking level to the real request: set before the
		// delegate stream starts, restore the session's previous level when the
		// stream ends (including abort/early-return of the generator). Skipped
		// in shadow mode, which must not mutate session behavior.
		//
		// The configured level is clamped into the target model's supported
		// range (registry default, overridable per-target) so a misconfigured
		// tier can never hand the provider an effort it rejects — e.g.
		// deepseek-v4-pro accepts only high/max, never low/medium.
		const thinkingCap = resolveThinkingCap(decision.target);
		const appliedThinking =
			decision.thinking !== undefined ? clampThinking(decision.thinking, thinkingCap) : undefined;
		if (decision.thinking !== undefined && appliedThinking !== decision.thinking) {
			state.eventLog.append({
				type: "warn",
				at: Date.now(),
				what: "thinking-clamped",
				target: `${decision.target.provider}/${decision.target.model}`,
				from: decision.thinking,
				to: appliedThinking,
			});
		}
		const canSteerThinking =
			appliedThinking !== undefined &&
			!state.shadowEnabled &&
			typeof pi.setThinkingLevel === "function";
		const priorThinking =
			canSteerThinking && typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
		if (canSteerThinking && appliedThinking !== undefined) {
			try {
				pi.setThinkingLevel(appliedThinking);
			} catch (error) {
				state.eventLog.append({
					type: "error",
					at: Date.now(),
					what: "setThinkingLevel",
					error: redactSecrets(String(error)),
				});
			}
		}

		try {
			for await (const event of failoverStream(finalOrder, factory, hooks, { signal: args.options?.signal })) {
				if (event.type === "done" && settledTarget && typeof event.message === "object" && event.message !== null) {
					recordUsage(state, settledTarget, (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage);
				}
				yield event;
			}
		} finally {
			if (canSteerThinking && priorThinking !== undefined) {
				try {
					pi.setThinkingLevel(priorThinking);
				} catch {
					// restore best-effort; the next request re-steers anyway
				}
			}
			// Warm-start persistence: keep circuit/latency snapshots across restarts.
			persistTrackers(state);
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
		state.sessionUsage.cost.set(key, (state.sessionUsage.cost.get(key) ?? 0) + estimatedCost);
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
