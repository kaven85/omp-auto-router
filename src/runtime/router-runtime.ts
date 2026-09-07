import { BudgetTracker } from "../core/budget-tracker";
import { CircuitBreaker } from "../core/circuit-breaker";
import { classifyComplexity, type ClassifierOverrides } from "../core/complexity-classifier";
import { classifyIntent } from "../core/intent-classifier";
import { DecisionStore } from "../core/decision-store";
import { EventLog } from "../core/event-log";
import { defaultIsRetryable, defaultIsSubstantive, failoverStream, formatError } from "../core/failover-engine";
import { FeedbackTracker } from "../core/feedback-tracker";
import { LatencyTracker } from "../core/latency-tracker";
import { route } from "../core/pipeline";
import { DEFAULT_ROLE, ProfileRegistry, profileTargets } from "../core/profile-registry";
import { parseShortcut } from "../core/shortcut-parser";
import { confidenceThreshold, llmAdjudicationEnabled, uviHardMode } from "./env";
import type { ProviderBalance } from "./provider-dictionary";
import type {
	CandidateInfo,
	ComplexityTier,
	ModelCost,
	QuotaSnapshot,
	RouteTarget,
	RoutingDecision,
	StreamEventLike,
	ThinkingLevel,
} from "../core/types";
import { COMPLEXITY_TIERS, formatComplexityTier } from "../core/types";

export const ROUTER_DECISION_ENTRY = "com.auto-router.v1.decision";
export const LEGACY_OMP_DECISION_ENTRY = "com.omp.auto-router.decision";

export interface RouterRuntimeState {
	registry: ProfileRegistry;
	circuit: CircuitBreaker;
	latency: LatencyTracker;
	budgets: BudgetTracker;
	decisions: DecisionStore;
	eventLog: EventLog;
	cooldowns: Map<string, { until: number; reason: string }>;
	ratings: FeedbackTracker;
	sessionUsage: {
		calls: Map<string, number>;
		cost: Map<string, number>;
		thinking: Map<string, Set<string>>;
		/** Prompt tokens processed per target, split fresh / cache-hit / cache-write. */
		inputTokens: Map<string, number>;
		cacheRead: Map<string, number>;
		cacheWrite: Map<string, number>;
	};
	lastDecision?: { at: number; decision: RoutingDecision; cleanPrompt: string };
	uviEnabled?: boolean;
	shadowEnabled?: boolean;
	classifierOverrides?: ClassifierOverrides;
	/** A recent failing test/build raises the next request's tier floor. */
	testFailureAt?: number;
	/** Non-fatal configuration errors surfaced by `/auto-router doctor`. */
	configErrors?: string[];
	/** Post-failure target exclusion window; adapters set it from the env chain. */
	cooldownAfterFailureMs?: number;
	/** Throttled quota snapshot cache; only populated when the host exposes quota reports. */
	quotaCache?: { at: number; data: QuotaSnapshot[] };
	/** Last fetched prepaid balances (balance-capable providers only). */
	balanceCache?: Record<string, ProviderBalance>;
	/**
	 * Last rendered widget payload for duplicate suppression. Instance-local on
	 * purpose: one session must never suppress another session's first render.
	 */
	widgetPayload?: string;
}

export interface RouterRuntimeHost {
	/** Resolve target eligibility against the host's effective model scope. */
	candidatesFor(
		targets: RouteTarget[],
		cooldowns: ReadonlyMap<string, { until: number; reason: string }>,
	): CandidateInfo[] | Promise<CandidateInfo[]>;
	/** Stream a target with host-owned credentials and provider options. */
	streamTarget(
		target: RouteTarget,
		context: RouterRequestContext,
		options: Record<string, unknown> | undefined,
		thinking: ThinkingLevel | undefined,
		/** Called immediately before the host starts the provider request. */
		onStreamStart?: () => void,
	): AsyncIterable<StreamEventLike> | Promise<AsyncIterable<StreamEventLike>>;
	/** True when `streamTarget` calls onStreamStart after its own stream lock. */
	deferTrialReservation?: boolean;
	/** Host-specific retry classification may supplement generic transient errors. */
	isRetryable?(error: unknown): boolean;
	/** Clamp a router-selected thinking level to a target's public capabilities. */
	clampThinking?(target: RouteTarget, level: ThinkingLevel): ThinkingLevel;
	/**
	 * Optional LLM adjudication of mixed-phase prompts (fail-open: undefined
	 * keeps the heuristic decision). The adapter streams the target through
	 * host-owned credentials; the runtime never sees them.
	 */
	adjudicate?(target: RouteTarget, prompt: string, signal?: AbortSignal): Promise<{ tier: ComplexityTier; model: string } | undefined>;
	/** Persist a host-neutral decision entry in the active session branch. */
	persistDecision(type: typeof ROUTER_DECISION_ENTRY, decision: RoutingDecision): void;
	setStatus?(text: string): void;
	fetchQuota?(providers: string[]): Promise<QuotaSnapshot[]>;
	now?(): number;
}

export interface RouterRequestContext {
	systemPrompt?: string | string[];
	messages: Array<{ role: string; content: unknown }>;
	tools?: unknown[];
}

export interface RouterRequest {
	profile: string;
	/** Role within the profile (virtual model `<profile>/<role>`). Default: "default". */
	role?: string;
	context: RouterRequestContext;
	options?: Record<string, unknown>;
	estimatedTokens?: number;
	hasImages?: boolean;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const RATING_MIN_SAMPLES = 5;
const RATING_DEMOTE_BELOW = 0.4;
const TEST_FAILURE_ESCALATION_MS = 10 * 60_000;

/**
 * Shared host-neutral stream-delegation orchestrator. The interface deliberately exposes
 * target streaming rather than credentials: adapters retain all auth details.
 */
export class RouterRuntime {
	/** One bounded availability wait per request; persistent 429s still surface. */
	private readonly availabilityRetries = new WeakSet<RouterRequest>();

	constructor(
		private readonly state: RouterRuntimeState,
		private readonly host: RouterRuntimeHost,
	) {}

	async *stream(request: RouterRequest): AsyncGenerator<StreamEventLike> {
		const { text: rawPrompt, hasImages } = lastUserText(request.context);
		const shortcut = parseShortcut(rawPrompt);
		// @profile override: resolve aliases and ignore unknown names —
		// route() records a "staying on" reasoning note for the unknown case;
		// a bad override must never fail the request.
		let requestedProfile = request.profile;
		if (shortcut.profileOverride !== undefined) {
			const resolved = this.state.registry.resolveAlias(shortcut.profileOverride) ?? shortcut.profileOverride;
			if (this.state.registry.profile(resolved) !== undefined) requestedProfile = resolved;
		}
		const profile = this.state.registry.profile(requestedProfile);
		if (!profile) throw new RouterRuntimeError(`unknown profile: ${requestedProfile}`);
		const role = request.role ?? DEFAULT_ROLE;
		const roleCfg = profile.roles?.[role];
		const allTargets = profileTargets(profile);
		const quota = await this.fetchQuota(allTargets);
		const candidates = await this.host.candidatesFor(allTargets, this.state.cooldowns);
		const estimatedTokens = request.estimatedTokens ?? estimateContextTokens(request.context);
		let priorTier = this.state.decisions.last()?.tier;
		if (this.state.testFailureAt !== undefined && this.now() - this.state.testFailureAt < TEST_FAILURE_ESCALATION_MS && priorTier !== "complex") {
			const floor = priorTier ?? "simple";
			priorTier = COMPLEXITY_TIERS[Math.min(COMPLEXITY_TIERS.indexOf(floor) + 1, COMPLEXITY_TIERS.length - 1)];
		}

		// LLM adjudication: mixed-phase prompts ("设计并实现 X") are
		// semantically ambiguous for keyword heuristics — ask the session's
		// current LLM to pick the tier. Fail-open: errors/timeouts keep the
		// heuristic decision. Runs before route() so the adjudicated tier
		// flows through the normal precedence (shortcut > policy > adjudication).
		let adjudicatedTier: ComplexityTier | undefined;
		let adjudicatorModel: string | undefined;
		// Adjudication spends an LLM call on tier ambiguity — only worth it for
		// the main-session (default) role on a classified (non-fixed) chain.
		if (this.host.adjudicate && llmAdjudicationEnabled() && role === DEFAULT_ROLE && roleCfg?.targets === undefined) {
			const pre = classifyComplexity({
				prompt: shortcut.cleanPrompt,
				estimatedTokens,
				hasImages: request.hasImages ?? hasImages,
				intent: classifyIntent(shortcut.cleanPrompt),
				shortcut,
				...(priorTier !== undefined ? { priorTier } : {}),
				overrides: this.state.classifierOverrides,
			});
			if (pre.signals.mixedPhase) {
				const adjudicatorTarget = this.state.decisions.last()?.target
					?? this.state.registry.tierConfig(requestedProfile, "standard")?.targets[0];
				if (adjudicatorTarget) {
					try {
						const adjudicated = await this.host.adjudicate(
							adjudicatorTarget,
							shortcut.cleanPrompt,
							request.options?.signal as AbortSignal | undefined,
						);
						if (adjudicated) {
							adjudicatedTier = adjudicated.tier;
							adjudicatorModel = adjudicated.model;
						}
					} catch {
						// fail-open: a broken adjudicator never breaks routing
					}
				}
			}
		}

		const { decision, cleanPrompt } = route(
			{
				rawPrompt,
				profile: requestedProfile,
				role,
				hasImages: request.hasImages ?? hasImages,
				...(priorTier ? { priorTier } : {}),
				candidates,
				quota,
				estimatedTokens,
				...(adjudicatedTier !== undefined ? { adjudicatedTier } : {}),
				now: new Date(this.now()),
			},
			{
				registry: this.state.registry,
				circuit: this.state.circuit,
				latency: this.state.latency,
				budgets: this.state.budgets,
				uviHardMode: uviHardMode(),
				confidenceThreshold: confidenceThreshold(),
				classifierOverrides: this.state.classifierOverrides,
			},
		);
		if (adjudicatedTier !== undefined && adjudicatorModel !== undefined) {
			decision.reasoning.push(`llm adjudication by ${adjudicatorModel} → ${adjudicatedTier}`);
		}

		const tier = this.state.registry.tierConfig(decision.profile, decision.tier);
		// Fixed-chain roles route their own target list (config order in shadow
		// mode). The pipeline is the single source for the fixed-chain rule and
		// the thinking precedence (shortcut pins already escaped there) — the
		// runtime consumes the stamps and never re-derives them.
		const fixedChain = decision.fixedChain === true;
		const chainTargets = fixedChain ? roleCfg?.targets : tier?.targets;
		const order = this.state.shadowEnabled
			? chainTargets?.filter((target) => candidates.some((candidate) => candidate.key === targetKey(target) && candidate.healthy)) ?? []
			: fixedChain
				// The pipeline already emitted the declared chain order; rating
				// demotion is for adaptive tier chains, not an operator-fixed one.
				? decision.orderedCandidates
				: demotePoorlyRated(decision.orderedCandidates, this.state.ratings);
		// A half-open trial is reserved immediately before the host opens its
		// provider stream (inside `factory`), not while this request may still be
		// queued behind OMP's global thinking lock. Reserving here caused a queued
		// request to look like an in-flight model call forever.
		const acquiredTrials: string[] = [];
		const admittedOrder = order;
		decision.orderedCandidates = admittedOrder;
		if (admittedOrder[0]) decision.target = admittedOrder[0];
		// Per-target thinking: target override > chain-level stamp (role > tier).
		const chainThinking = decision.chainThinking;
		const configuredThinking = decision.target.thinking ?? chainThinking;
		const selectedThinking = configuredThinking && this.host.clampThinking
			? this.host.clampThinking(decision.target, configuredThinking)
			: configuredThinking;
		if (configuredThinking && selectedThinking !== configuredThinking) {
			this.state.eventLog.append({ type: "warn", at: this.now(), what: "thinking-clamped", target: targetKey(decision.target), from: configuredThinking, to: selectedThinking });
		}
		if (selectedThinking) decision.thinking = selectedThinking;
		else delete decision.thinking;

		this.recordDecision(decision, cleanPrompt);
		if (admittedOrder.length === 0) {
			const exclusions = decision.reasoning.filter((line) => line.startsWith("excluded "));
			const candidateKeys = new Set((chainTargets ?? tier?.targets ?? []).map(targetKey));
			const retryAt = transientRetryAt(
				candidates.filter(candidate => candidateKeys.has(candidate.key)),
				this.state.circuit,
				this.now(),
			);
			// OMP's core retry can fire before the router's provider cooldown ends.
			// When every target is temporarily gated, wait once for the earliest
			// retry time instead of turning that recoverable state into a terminal
			// no-candidate error. Abort remains responsive and persistent 429s
			// still surface after the bounded retry.
			const retrySignal = request.options?.signal as AbortSignal | undefined;
			// Only wait when the host supplied cancellation. A command invocation
			// without a signal must retain the immediate, actionable error rather
			// than creating an uninterruptible background timer.
			if (retryAt !== undefined && retrySignal !== undefined && !this.availabilityRetries.has(request)) {
				this.availabilityRetries.add(request);
				try {
					const delayMs = retryAt - this.now();
					this.state.eventLog.append({ type: "warn", at: this.now(), what: "availability-retry-wait", profile: decision.profile, tier: decision.tier, retryAt, exclusions });
					this.host.setStatus?.(`auto-router waiting ${Math.ceil(delayMs / 1000)}s to retry ${decision.profile}/${decision.tier}`);
					if (await waitForRetry(delayMs, retrySignal)) {
						yield* this.stream(request);
					}
					return;
				} finally {
					this.availabilityRetries.delete(request);
				}
			}
			const primary = exclusions[0]?.replace(/^excluded\s+/, "");
			// Log the full evidence even when the host truncates the rendered error.
			// This is the diagnostic seam for a model that streams directly but is
			// rejected by routing: the exact gate must be observable after the fact.
			this.state.eventLog.append({
				type: "error",
				at: this.now(),
				what: "no-eligible-candidates",
				profile: decision.profile,
				tier: decision.tier,
				exclusions,
			});
			const detail = primary ? ` — ${primary}` : "";
			throw new RouterRuntimeError(`no eligible candidates${detail} (profile "${decision.profile}" tier=${decision.tier})`);
		}
		this.host.setStatus?.(
			`auto-router ${decision.profile}${decision.role !== DEFAULT_ROLE ? `/${decision.role}` : ""} | tier=${formatComplexityTier(decision.tier)} (${decision.confidence.toFixed(2)}) | ${decision.target.provider}/${decision.target.model}`,
		);
		rewriteLastUserText(request.context, cleanPrompt);

		const targetStarts = new Map<string, number>();
		const firstOutputs = new Map<string, number>();
		let settledTarget: RouteTarget | undefined;
		const costs = new Map(candidates.map((candidate) => [candidate.key, candidate.capabilities?.cost]));
		const runtime = this;
		const factory = async function* (target: RouteTarget): AsyncGenerator<StreamEventLike> {
			const key = targetKey(target);
			const reserveTrial = () => {
				if (runtime.state.circuit.state(key, runtime.now()) !== "half-open") return;
				if (!runtime.state.circuit.tryAcquireTrial(key, runtime.now())) {
					// OMP already serializes provider calls behind its host-global
					// thinking lock. A revived/re-entrant request may observe the first
					// request's lease after obtaining that lock; treating it as fatal
					// leaves the UI Working with no provider request. For deferred OMP
					// hosts the lease is advisory — continue in lock order.
					if (runtime.host.deferTrialReservation) return;
					throw new HalfOpenTrialBusyError(key);
				}
				acquiredTrials.push(key);
			};
			// Pi and test hosts start immediately, so reserve at the factory seam.
			// OMP defers this until after its host-global thinking lock is granted.
			if (!runtime.host.deferTrialReservation) reserveTrial();
			targetStarts.set(key, runtime.now());
			const configuredThinking = target.thinking ?? chainThinking;
			const thinking = configuredThinking && runtime.host.clampThinking
				? runtime.host.clampThinking(target, configuredThinking)
				: configuredThinking;
			const stream = await runtime.host.streamTarget(
				target,
				request.context,
				request.options,
				thinking,
				runtime.host.deferTrialReservation ? reserveTrial : undefined,
			);
			for await (const event of stream) {
				if (!firstOutputs.has(key) && isVisibleResponseEvent(event)) {
					firstOutputs.set(key, runtime.now() - (targetStarts.get(key) ?? runtime.now()));
				}
				yield event;
			}
		};

		const hooks = {
			isRetryable: (error: unknown) => this.host.isRetryable?.(error) === true || defaultIsRetryable(error),
			isSubstantive: defaultIsSubstantive,
			onTargetFailed: (target: RouteTarget, error: unknown) => {
				const key = targetKey(target);
				const now = this.now();
				// A busy half-open lease is router-internal concurrency control, not a
				// provider failure. Counting it reopens the circuit and doubles the
				// cooldown even though no backend request was sent.
				if (error instanceof HalfOpenTrialBusyError) {
					this.state.eventLog.append({ type: "warn", at: now, what: "half-open-trial-busy", provider: target.provider, model: target.model });
					return;
				}
				const configuredCooldownMs = this.state.cooldownAfterFailureMs ?? DEFAULT_COOLDOWN_MS;
				// CircuitBreaker owns the effective retry deadline, including its
				// exponential backoff and cap. The adapter-facing map is only a
				// reason-carrying projection, so it must never calculate a second one.
				const backoff = this.state.circuit.recordFailure(key, now, { cooldownMs: configuredCooldownMs });
				this.state.cooldowns.set(key, { until: backoff.retryAt, reason: formatError(error) });
				this.state.eventLog.append({ type: "error", at: now, provider: target.provider, model: target.model, error: formatError(error) });
			},
			onFailover: (from: RouteTarget, to: RouteTarget, error: unknown) => {
				this.state.eventLog.append({ type: "failover", at: this.now(), from: targetKey(from), to: targetKey(to), error: formatError(error) });
			},
			onTargetOutput: (target: RouteTarget) => {
				// Needed immediately for done-event usage attribution; do not mark
				// the target healthy until the stream finishes cleanly.
				settledTarget = target;
			},
			onTargetSettled: (target: RouteTarget) => {
				const key = targetKey(target);
				this.state.circuit.recordSuccess(key, this.now());
				this.state.cooldowns.delete(key);
				const firstOutput = firstOutputs.get(key);
				if (firstOutput !== undefined) this.state.latency.record(key, firstOutput);
				if (!this.state.shadowEnabled) {
					this.state.sessionUsage.calls.set(key, (this.state.sessionUsage.calls.get(key) ?? 0) + 1);
					if (target.thinking ?? chainThinking) {
						const levels = this.state.sessionUsage.thinking.get(key) ?? new Set<string>();
						levels.add((target.thinking ?? chainThinking)!);
						this.state.sessionUsage.thinking.set(key, levels);
					}
				}
			},
		};

		try {
			for await (const event of failoverStream(admittedOrder, factory, hooks, { signal: request.options?.signal as AbortSignal | undefined })) {
				if (event.type === "done" && settledTarget) {
					this.recordUsage(settledTarget, usageFromEvent(event), costs.get(targetKey(settledTarget)));
				}
				yield event;
			}
		} finally {
			for (const key of acquiredTrials) this.state.circuit.releaseTrial(key);
		}
	}

	private recordDecision(decision: RoutingDecision, cleanPrompt: string): void {
		this.state.decisions.record(decision);
		this.state.lastDecision = { at: this.now(), decision, cleanPrompt };
		this.host.persistDecision(ROUTER_DECISION_ENTRY, decision);
		this.state.eventLog.append({ type: "decision", at: this.now(), profile: decision.profile, role: decision.role, tier: decision.tier, target: decision.target });
	}

	private async fetchQuota(targets: RouteTarget[]): Promise<Record<string, QuotaSnapshot>> {
		if (this.state.uviEnabled === false || !this.host.fetchQuota) return {};
		const snapshots = await this.host.fetchQuota([...new Set(targets.map((target) => target.provider))]);
		return Object.fromEntries(snapshots.map((snapshot) => [snapshot.provider, snapshot]));
	}

	private recordUsage(target: RouteTarget, usage: TokenUsage | undefined, cost: ModelCost | undefined): void {
		if (!usage) return;
		const inputTokens = usage.input ?? 0;
		const outputTokens = usage.output ?? 0;
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		const estimatedCost = cost
			? (inputTokens * cost.input + outputTokens * cost.output + cacheRead * cost.cacheRead + cacheWrite * cost.cacheWrite) / 1_000_000
			: 0;
		this.state.budgets.record(target.provider, { inputTokens, outputTokens, cost: estimatedCost }, new Date(this.now()));
		if (!this.state.shadowEnabled) {
			const key = targetKey(target);
			this.state.sessionUsage.cost.set(key, (this.state.sessionUsage.cost.get(key) ?? 0) + estimatedCost);
			this.state.sessionUsage.inputTokens.set(key, (this.state.sessionUsage.inputTokens.get(key) ?? 0) + inputTokens);
			this.state.sessionUsage.cacheRead.set(key, (this.state.sessionUsage.cacheRead.get(key) ?? 0) + cacheRead);
			this.state.sessionUsage.cacheWrite.set(key, (this.state.sessionUsage.cacheWrite.get(key) ?? 0) + cacheWrite);
		}
		this.state.eventLog.append({ type: "settled", at: this.now(), provider: target.provider, model: target.model, inputTokens, outputTokens, estimatedCost });
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}
}

class HalfOpenTrialBusyError extends Error {
	constructor(key: string) {
		super(`half-open trial already in progress for ${key}`);
		this.name = "HalfOpenTrialBusyError";
	}
}

export class RouterRuntimeError extends Error {
	constructor(message: string) {
		super(`auto-router: ${message}`);
		this.name = "RouterRuntimeError";
	}
}

interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

function usageFromEvent(event: StreamEventLike): TokenUsage | undefined {
	if (typeof event.message !== "object" || event.message === null) return undefined;
	const usage = (event.message as { usage?: unknown }).usage;
	return typeof usage === "object" && usage !== null ? usage as TokenUsage : undefined;
}

function targetKey(target: Pick<RouteTarget, "provider" | "model">): string {
	return `${target.provider}/${target.model}`;
}

function demotePoorlyRated(order: readonly RouteTarget[], ratings: FeedbackTracker): RouteTarget[] {
	const poor = (target: RouteTarget) => {
		const stats = ratings.statsFor(target.provider, target.model);
		return stats.total >= RATING_MIN_SAMPLES && stats.goodFraction < RATING_DEMOTE_BELOW;
	};
	return [...order.filter((target) => !poor(target)), ...order.filter(poor)];
}

function lastUserText(context: RouterRequestContext): { text: string; hasImages: boolean } {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		return {
			text: parts.filter(isTextPart).map((part) => part.text).join(""),
			hasImages: parts.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image"),
		};
	}
	return { text: "", hasImages: false };
}

function rewriteLastUserText(context: RouterRequestContext, text: string): void {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (Array.isArray(message.content)) {
			message.content.splice(0, message.content.length, { type: "text", text }, ...message.content.filter((part) => !isTextPart(part)));
		}
		return;
	}
}

/** Estimate the token count of a request context (chars/4 heuristic over all text parts). */
export function estimateContextTokens(context: RouterRequestContext): number {
	let chars = 0;
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			chars += message.content.length;
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (isTextPart(part)) chars += part.text.length;
			}
		}
	}
	const systemPrompt = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("") : context.systemPrompt ?? "";
	return Math.max(1, Math.ceil((chars + systemPrompt.length) / 4));
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string";
}

function isVisibleResponseEvent(event: StreamEventLike): boolean {
	if (event.type === "thinking_delta" || event.type === "text_delta" || event.type === "toolcall_delta") return typeof event.delta === "string" && event.delta.length > 0;
	return event.type === "image_end" || event.type === "toolcall_start" || event.type === "toolcall_end" || event.type === "done";
}

/** Return a retry deadline only when every configured target is transiently gated. */
function transientRetryAt(candidates: CandidateInfo[], circuit: CircuitBreaker, nowMs: number): number | undefined {
	if (candidates.length === 0) return undefined;
	const retryAts = candidates.map(candidate => {
		if (candidate.cooldownUntil !== undefined && candidate.cooldownUntil > nowMs) return candidate.cooldownUntil;
		if (circuit.state(candidate.key, nowMs) === "open") return circuit.retryAt(candidate.key);
		return undefined;
	});
	return retryAts.every((retryAt): retryAt is number => retryAt !== undefined)
		? Math.min(...retryAts)
		: undefined;
}

/** Sleep until a transient availability gate expires; abort resolves cleanly. */
function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise(resolve => {
		const timer = setTimeout(done, Math.max(0, delayMs));
		function done(): void {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}
		function onAbort(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
