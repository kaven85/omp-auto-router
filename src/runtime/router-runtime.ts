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
import { ProfileRegistry } from "../core/profile-registry";
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
	): AsyncIterable<StreamEventLike> | Promise<AsyncIterable<StreamEventLike>>;
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
	context: RouterRequestContext;
	options?: Record<string, unknown>;
	estimatedTokens?: number;
	hasImages?: boolean;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const RATING_MIN_SAMPLES = 5;
const RATING_DEMOTE_BELOW = 0.4;
const TEST_FAILURE_ESCALATION_MS = 10 * 60_000;
const TIER_LADDER = ["trivial", "simple", "standard", "complex"] as const;

/**
 * Shared host-neutral Mode A orchestrator. The interface deliberately exposes
 * target streaming rather than credentials: adapters retain all auth details.
 */
export class RouterRuntime {
	constructor(
		private readonly state: RouterRuntimeState,
		private readonly host: RouterRuntimeHost,
	) {}

	async *stream(request: RouterRequest): AsyncGenerator<StreamEventLike> {
		const { text: rawPrompt, hasImages } = lastUserText(request.context);
		const requestedProfile = parseShortcut(rawPrompt).profileOverride ?? request.profile;
		const profile = this.state.registry.profile(requestedProfile);
		if (!profile) throw new RouterRuntimeError(`unknown profile: ${requestedProfile}`);
		const allTargets = Object.values(profile.tiers).flatMap((tier) => tier?.targets ?? []);
		const quota = await this.fetchQuota(allTargets);
		const candidates = await this.host.candidatesFor(allTargets, this.state.cooldowns);
		const estimatedTokens = request.estimatedTokens ?? estimateContextTokens(request.context);
		let priorTier = this.state.decisions.last()?.tier;
		if (this.state.testFailureAt !== undefined && this.now() - this.state.testFailureAt < TEST_FAILURE_ESCALATION_MS && priorTier !== "complex") {
			const floor = priorTier ?? "simple";
			priorTier = TIER_LADDER[Math.min(TIER_LADDER.indexOf(floor) + 1, TIER_LADDER.length - 1)];
		}

		// LLM adjudication: mixed-phase prompts ("设计并实现 X") are
		// semantically ambiguous for keyword heuristics — ask the session's
		// current LLM to pick the tier. Fail-open: errors/timeouts keep the
		// heuristic decision. Runs before route() so the adjudicated tier
		// flows through the normal precedence (shortcut > policy > adjudication).
		const shortcut = parseShortcut(rawPrompt);
		let adjudicatedTier: ComplexityTier | undefined;
		let adjudicatorModel: string | undefined;
		if (this.host.adjudicate && llmAdjudicationEnabled()) {
			const pre = classifyComplexity({
				prompt: shortcut.cleanPrompt,
				estimatedTokens,
				hasImages: request.hasImages ?? hasImages,
				conversationDepth: this.state.decisions.list().length,
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
				hasImages: request.hasImages ?? hasImages,
				conversationDepth: this.state.decisions.list().length,
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
		const tierThinking = tier?.thinking;
		const order = this.state.shadowEnabled
			? tier?.targets.filter((target) => candidates.some((candidate) => candidate.key === targetKey(target) && candidate.healthy)) ?? []
			: demotePoorlyRated(decision.orderedCandidates, this.state.ratings);
		decision.orderedCandidates = order;
		if (order[0]) decision.target = order[0];
		const configuredThinking = decision.target.thinking ?? tierThinking;
		const selectedThinking = configuredThinking && this.host.clampThinking
			? this.host.clampThinking(decision.target, configuredThinking)
			: configuredThinking;
		if (configuredThinking && selectedThinking !== configuredThinking) {
			this.state.eventLog.append({ type: "warn", at: this.now(), what: "thinking-clamped", target: targetKey(decision.target), from: configuredThinking, to: selectedThinking });
		}
		if (selectedThinking) decision.thinking = selectedThinking;
		else delete decision.thinking;

		this.recordDecision(decision, cleanPrompt);
		if (order.length === 0) {
			const exclusions = decision.reasoning.filter((line) => line.startsWith("excluded "));
			const detail = exclusions.length ? ` — ${exclusions.join("; ")}` : "";
			throw new RouterRuntimeError(`no eligible candidates for profile "${decision.profile}" tier=${decision.tier}${detail}`);
		}
		this.host.setStatus?.(
			`auto-router ${decision.profile} | tier=${decision.tier} (${decision.confidence.toFixed(2)}) | ${decision.target.provider}/${decision.target.model}`,
		);
		rewriteLastUserText(request.context, cleanPrompt);

		const targetStarts = new Map<string, number>();
		const firstOutputs = new Map<string, number>();
		let settledTarget: RouteTarget | undefined;
		const costs = new Map(candidates.map((candidate) => [candidate.key, candidate.capabilities?.cost]));
		const runtime = this;
		const factory = async function* (target: RouteTarget): AsyncGenerator<StreamEventLike> {
			const key = targetKey(target);
			targetStarts.set(key, runtime.now());
			const configuredThinking = target.thinking ?? tierThinking;
			const thinking = configuredThinking && runtime.host.clampThinking
				? runtime.host.clampThinking(target, configuredThinking)
				: configuredThinking;
			const stream = await runtime.host.streamTarget(target, request.context, request.options, thinking);
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
				this.state.circuit.recordFailure(key, this.now());
				this.state.cooldowns.set(key, { until: this.now() + (this.state.cooldownAfterFailureMs ?? DEFAULT_COOLDOWN_MS), reason: formatError(error) });
				this.state.eventLog.append({ type: "error", at: this.now(), provider: target.provider, model: target.model, error: formatError(error) });
			},
			onFailover: (from: RouteTarget, to: RouteTarget, error: unknown) => {
				this.state.eventLog.append({ type: "failover", at: this.now(), from: targetKey(from), to: targetKey(to), error: formatError(error) });
			},
			onTargetSettled: (target: RouteTarget) => {
				settledTarget = target;
				const key = targetKey(target);
				this.state.circuit.recordSuccess(key);
				this.state.cooldowns.delete(key);
				const firstOutput = firstOutputs.get(key);
				if (firstOutput !== undefined) this.state.latency.record(key, firstOutput);
				if (!this.state.shadowEnabled) {
					this.state.sessionUsage.calls.set(key, (this.state.sessionUsage.calls.get(key) ?? 0) + 1);
					if (target.thinking ?? tierThinking) {
						const levels = this.state.sessionUsage.thinking.get(key) ?? new Set<string>();
						levels.add(target.thinking ?? tierThinking!);
						this.state.sessionUsage.thinking.set(key, levels);
					}
				}
			},
		};

		for await (const event of failoverStream(order, factory, hooks, { signal: request.options?.signal as AbortSignal | undefined })) {
			if (event.type === "done" && settledTarget) {
				this.recordUsage(settledTarget, usageFromEvent(event), costs.get(targetKey(settledTarget)));
			}
			yield event;
		}
	}

	private recordDecision(decision: RoutingDecision, cleanPrompt: string): void {
		this.state.decisions.record(decision);
		this.state.lastDecision = { at: this.now(), decision, cleanPrompt };
		this.host.persistDecision(ROUTER_DECISION_ENTRY, decision);
		this.state.eventLog.append({ type: "decision", at: this.now(), profile: decision.profile, tier: decision.tier, target: decision.target });
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
		}
		this.state.eventLog.append({ type: "settled", at: this.now(), provider: target.provider, model: target.model, inputTokens, outputTokens, estimatedCost });
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
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

function estimateContextTokens(context: RouterRequestContext): number {
	const body = context.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter(isTextPart).map((part) => part.text).join("");
	const systemPrompt = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("") : context.systemPrompt ?? "";
	return Math.max(1, Math.ceil((body + systemPrompt).length / 4));
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string";
}

function isVisibleResponseEvent(event: StreamEventLike): boolean {
	if (event.type === "thinking_delta" || event.type === "text_delta" || event.type === "toolcall_delta") return typeof event.delta === "string" && event.delta.length > 0;
	return event.type === "image_end" || event.type === "toolcall_start" || event.type === "toolcall_end" || event.type === "done";
}
