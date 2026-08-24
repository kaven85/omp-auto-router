/**
 * Router stream handler.
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
import { DEFAULT_ROLE, profileTargets } from "../core/profile-registry";
import { clampThinking } from "../core/thinking-cap";
import type { AdapterState } from "./state";
import { persistRuntimeTrackers } from "../runtime/state";
import { enrichCandidates, createHostPorts } from "./host-ports";
import { fetchOmpBalance } from "./balance";
import { adjudicateTier } from "./llm-adjudicator";
import type { OmpExtensionApi, OmpExtensionContext } from "./omp-api";
import { resolveThinkingCap } from "../runtime/provider-dictionary";
import { refreshSettledBalanceAndWidget, routerErrorEvent } from "../runtime/adapter-kit";
import { ROUTER_DECISION_ENTRY, RouterRuntime, RouterRuntimeError, estimateContextTokens, type RouterRuntimeHost } from "../runtime/router-runtime";

/**
 * How long a request waits for `session_start` to land on the state before
 * failing. Requests can reach the virtual provider before the boot event
 * (early prompts, subagent spawn races, extension hot-reload mid-session);
 * a bounded wait mirrors `waitForConfiguredModel` so a slow boot doesn't
 * fail the first request.
 */
const CTX_READY_WAIT_MS = 5_000;

/** Process-wide because OMP's thinking level is host-global across config reloads. */
let streamLockHeld = false;
type StreamLockWaiter = { resolve: (release: () => void) => void; signal?: AbortSignal; onAbort?: () => void };
const streamLockWaiters: StreamLockWaiter[] = [];



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
		const requested = state.registry.parseVirtualModelId(args.model.id);
		const requestedProfile = state.registry.profile(requested.profile);
		if (requestedProfile) {
			// Readiness is tracked by target key. A model from another role/profile
			// must not suppress this chain's startup grace period, and a timeout or
			// abort must not mark anything ready.
			const roleTargets = requested.role !== DEFAULT_ROLE
				? requestedProfile.roles?.[requested.role]?.targets
				: undefined;
			const targets = roleTargets ?? profileTargets(requestedProfile);
			// A cached key is only a hint: host auth/model scopes can change during
			// a session, so prune stale keys and retry discovery when it vanished.
			const readyKey = targets
				.map((target) => `${target.provider}/${target.model}`)
				.find((key) => state.readyModelKeys.has(key) && ctx.models.resolve(key) !== undefined)
				?? await waitForConfiguredModel(ctx, targets, args.options?.signal);
			if (readyKey !== undefined) state.readyModelKeys.add(readyKey);
			for (const target of targets) {
				const key = `${target.provider}/${target.model}`;
				if (state.readyModelKeys.has(key) && ctx.models.resolve(key) === undefined) state.readyModelKeys.delete(key);
			}
		}
		try {
			const { profile: profileName, role } = state.registry.parseVirtualModelId(args.model.id);
			const runtime = new RouterRuntime(state, createOmpRuntimeHost(state, pi, ctx));
			for await (const event of runtime.stream({
				profile: profileName,
				role,
				context: args.context,
				options: args.options,
				estimatedTokens: resolveEstimatedTokens(ctx, args.context),
			})) yield event;
			const decision = state.lastDecision?.decision;
			const profile = decision ? state.registry.profile(decision.profile) : undefined;
			await refreshSettledBalanceAndWidget(
				state,
				profile ? profileTargets(profile) : [],
				(provider, endpoint) => fetchOmpBalance(ctx, state, provider, endpoint),
				(lines) => createHostPorts(ctx, state).setWidget(lines),
			);
		} catch (error) {
			if (!(error instanceof RouterRuntimeError)) throw error;
			const message = error.message.replace("auto-router: no eligible candidates", "auto-router [constraint-solver]: no eligible candidates");
			yield* failWith(message);
		} finally {
			persistRuntimeTrackers(state);
		}
	})();
}

function createOmpRuntimeHost(state: AdapterState, pi: OmpExtensionApi, ctx: OmpExtensionContext): RouterRuntimeHost {
	const ports = createHostPorts(ctx, state);
	return {
		candidatesFor: (targets, cooldowns) => enrichCandidates(ports, targets, cooldowns),
		async *streamTarget(target, context, options, thinking) {
			const model = ctx.models.resolve(`${target.provider}/${target.model}`);
			if (!model) throw new Error(`auto-router: target not resolvable: ${target.provider}/${target.model}`);
			const apiKey = await ports.getApiKey(target);
			// OMP exposes thinking as host-global mutable state. Serialize all
			// delegated streams (also across config reloads) so a concurrent
			// no-thinking stream cannot observe a temporary override.
			let release: (() => void) | undefined;
			try {
				release = await acquireStreamLock(options?.signal as AbortSignal | undefined);
				const canOverrideThinking = thinking !== undefined && !state.shadowEnabled && typeof pi.getThinkingLevel === "function";
				const priorThinking = canOverrideThinking ? pi.getThinkingLevel!() : undefined;
				if (canOverrideThinking) pi.setThinkingLevel(thinking!);
				try {
					for await (const event of streamSimple(model as never, context as never, { ...options, ...(apiKey ? { apiKey } : {}) } as never)) yield event as never;
				} finally {
					if (priorThinking !== undefined) pi.setThinkingLevel(priorThinking);
				}
			} finally {
				release?.();
			}
		},
		isRetryable: (error) => isProviderRetryableError(error) || defaultIsRetryable(error),
		clampThinking: (target, level) => clampThinking(level, resolveThinkingCap(target)),
		persistDecision: (_type, decision) => pi.appendEntry(ROUTER_DECISION_ENTRY, decision),
		adjudicate: (target, prompt, signal) => adjudicateTier(state, ports, target, prompt, signal),
		setStatus: (text) => ports.setStatus(text),
		fetchQuota: (providers) => ports.fetchQuota(providers),
		now: () => Date.now(),
	};
}

/** Abortable FIFO mutex for OMP's host-global thinking setting. */
function acquireStreamLock(signal?: AbortSignal): Promise<() => void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise<() => void>((resolve, reject) => {
		const waiter: StreamLockWaiter = { resolve, signal };
		if (signal) {
			waiter.onAbort = () => {
				const index = streamLockWaiters.indexOf(waiter);
				if (index >= 0) streamLockWaiters.splice(index, 1);
				reject(abortError());
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		if (!streamLockHeld) {
			streamLockHeld = true;
			grantStreamLock(waiter);
		} else {
			streamLockWaiters.push(waiter);
		}
	});
}

function grantStreamLock(waiter: StreamLockWaiter): void {
	if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
	waiter.resolve(() => {
		const next = streamLockWaiters.shift();
		if (next) grantStreamLock(next);
		else streamLockHeld = false;
	});
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted", "AbortError");
}

async function waitForConfiguredModel(
	ctx: OmpExtensionContext,
	targets: Array<{ provider: string; model: string }>,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const retryDelayMs = 50;
	const maxAttempts = 100;
	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		for (const target of targets) {
			const key = `${target.provider}/${target.model}`;
			if (ctx.models.resolve(key)) return key;
		}
		if (attempt === maxAttempts || signal?.aborted) return undefined;
		await new Promise<void>((resolve) => {
			ctx.setTimeout(resolve, retryDelayMs);
		});
	}
	return undefined;
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

/** Extract a usable token estimate from the host, or the shared chars/4 heuristic. */
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
	// Fallback: the shared chars/4 heuristic over all textual content.
	return estimateContextTokens(context);
}

async function* failWith(message: string): AsyncGenerator<{ type: string; [k: string]: unknown }> {
	yield routerErrorEvent({ api: "auto-router", provider: "auto-router", id: "auto-router" }, message);
}
