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

import { defaultIsRetryable } from "../core/failover-engine";
import type { HostPorts } from "../core/host-ports";
import { clampThinking } from "../core/thinking-cap";
import type { QuotaSnapshot, RoutingDecision } from "../core/types";
import type { AdapterState } from "./state";
import { persistTrackers } from "./state";
import { enrichCandidates, createHostPorts } from "./host-ports";
import type { OmpExtensionApi, OmpExtensionContext } from "./omp-api";
import { fetchProviderBalance, resolveBalanceEndpoint, resolveThinkingCap } from "./provider-registry";
import { ROUTER_DECISION_ENTRY, RouterRuntime, RouterRuntimeError, type RouterRuntimeHost } from "../runtime/router-runtime";

/** Default transient exclusion window after a target fails within a failover chain. */
const DEFAULT_COOLDOWN_AFTER_FAILURE_MS = 60_000;

/**
 * Effective post-failure cooldown: `OMP_AUTO_ROUTER_COOLDOWN_MS` env override,
 * floored at 5s. Kept short by default — a cooled target with no fallback
 * leaves the profile with no eligible candidates.
 */
export function cooldownAfterFailureMs(): number {
	const raw = process.env.OMP_AUTO_ROUTER_COOLDOWN_MS;
	if (raw === undefined) return DEFAULT_COOLDOWN_AFTER_FAILURE_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : DEFAULT_COOLDOWN_AFTER_FAILURE_MS;
}


/**
 * How long a request waits for `session_start` to land on the state before
 * failing. Requests can reach the virtual provider before the boot event
 * (early prompts, subagent spawn races, extension hot-reload mid-session);
 * a bounded wait mirrors `waitForConfiguredModel` so a slow boot doesn't
 * fail the first request.
 */
const CTX_READY_WAIT_MS = 5_000;


function observedLatencySuffix(state: AdapterState, decision: RoutingDecision): string {
	const key = `${decision.target.provider}/${decision.target.model}`;
	const averageMs = state.latency.average(key);
	if (averageMs === undefined) return "";
	return ` | first output=${(averageMs / 1_000).toFixed(1)}s`;
}

/**
 * Compose the dashboard widget: decision line (when a decision exists) plus
 * live budget/circuit/UVI snapshots. UVI windows past their `resetsAt` are
 * shown as freshly reset — the cached fetch would otherwise keep displaying
 * the pre-reset usage until the next poll.
 */
export function buildWidgetLines(state: AdapterState, decision?: RoutingDecision): string[] {
	const lines: string[] = [];
	if (decision !== undefined) {
		const billing = decision.target.billing === "per-token" ? " (per-token)" : "";
		lines.push(
			`${decision.profile} | tier=${decision.tier} | ${decision.target.provider}/${decision.target.model}${billing}${decision.thinking !== undefined ? ` | ${decision.thinking}` : ""}${observedLatencySuffix(state, decision)}`,
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
	// UVI quota pacing: only the current provider's balance — the full
	// per-provider breakdown lives in `/auto-router usage`.
	const currentProvider = decision?.target.provider;
	if (state.uviEnabled && currentProvider !== undefined) {
		const nowMs = Date.now();
		const uviBits = state.quotaCache.data
			.filter((snapshot) => snapshot.provider === currentProvider)
			.map((snapshot) => {
				const worst = Math.max(
					0,
					...snapshot.windows.map((window) =>
						window.resetsAt !== undefined && window.resetsAt <= nowMs ? 0 : window.usedFraction,
					),
				);
				return `${snapshot.provider} ${(100 - worst * 100).toFixed(0)}% left`;
			});
		if (uviBits.length > 0) lines.push(`uvi: ${uviBits.join(" · ")}`);
		const balance = state.balanceCache[currentProvider];
		if (balance !== undefined) lines.push(`balance: ${currentProvider} ${balance.total} ${balance.currency}`);
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

/**
 * OMP's thin mapping onto the shared runtime. Credentials and the host stream
 * remain adapter-private; routing, failover and accounting live in RouterRuntime.
 */
export function createStreamHandler(
	state: AdapterState,
	pi: OmpExtensionApi,
	args: StreamArgs,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
	return (async function* () {
		const ctx = await waitForSessionContext(state, args.options?.signal);
		if (!ctx) {
			yield* failWith("auto-router: session context not ready — no session_start received before the request; restart the omp session or reload the extension");
			return;
		}
		if (!state.modelsReady) {
			const profileName = args.model.id.replace(/^auto-router\//, "");
			const profile = state.registry.profile(profileName);
			if (profile) await waitForConfiguredModel(ctx, Object.values(profile.tiers).flatMap((tier) => tier?.targets ?? []), args.options?.signal);
			state.modelsReady = true;
		}
		try {
			const runtime = new RouterRuntime(state, createOmpRuntimeHost(state, pi, ctx));
			for await (const event of runtime.stream({
				profile: args.model.id.replace(/^auto-router\//, ""),
				context: args.context,
				options: args.options,
				estimatedTokens: resolveEstimatedTokens(ctx, args.context),
			})) yield event;
			const decision = state.lastDecision?.decision;
			if (decision) {
				const profile = state.registry.profile(decision.profile);
				const targets = profile ? Object.values(profile.tiers).flatMap((tier) => tier?.targets ?? []) : [];
				const endpoint = resolveBalanceEndpoint(decision.target.provider, targets);
				if (endpoint) {
					const balance = await fetchProviderBalance(ctx, state, decision.target.provider, endpoint);
					if (balance) state.balanceCache[decision.target.provider] = balance;
				}
				renderWidget(state, createHostPorts(pi, ctx, state), decision);
			}
		} catch (error) {
			if (!(error instanceof RouterRuntimeError)) throw error;
			const message = error.message.replace("auto-router: no eligible candidates", "auto-router [constraint-solver]: no eligible candidates");
			yield* failWith(message);
		} finally {
			persistTrackers(state);
		}
	})();
}

function createOmpRuntimeHost(state: AdapterState, pi: OmpExtensionApi, ctx: OmpExtensionContext): RouterRuntimeHost {
	const ports = createHostPorts(pi, ctx, state);
	return {
		candidatesFor: (targets, cooldowns) => enrichCandidates(ports, targets, cooldowns),
		async *streamTarget(target, context, options, thinking) {
			const model = ctx.models.resolve(`${target.provider}/${target.model}`);
			if (!model) throw new Error(`auto-router: target not resolvable: ${target.provider}/${target.model}`);
			const apiKey = await ports.getApiKey(target);
			const priorThinking = thinking !== undefined && !state.shadowEnabled && typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;
			if (thinking !== undefined && !state.shadowEnabled) pi.setThinkingLevel(thinking);
			try {
				for await (const event of streamSimple(model as never, context as never, { ...options, ...(apiKey ? { apiKey } : {}) } as never)) yield event as never;
			} finally {
				if (priorThinking !== undefined) pi.setThinkingLevel(priorThinking);
			}
		},
		isRetryable: (error) => isProviderRetryableError(error) || defaultIsRetryable(error),
		clampThinking: (target, level) => clampThinking(level, resolveThinkingCap(target)),
		persistDecision: (_type, decision) => pi.appendEntry(ROUTER_DECISION_ENTRY, decision),
		setStatus: (text) => ports.setStatus(text),
		fetchQuota: (providers) => ports.fetchQuota(providers),
		now: () => Date.now(),
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
