/**
 * omp-auto-router — shared types (router-core contract).
 *
 * This file is the single cross-module contract. It MUST NOT import from any
 * other module in this package, and MUST NOT import any omp/@oh-my-pi types.
 * router-core is host-agnostic: the omp adapter implements HostPorts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Complexity tiers
// ─────────────────────────────────────────────────────────────────────────────

export const COMPLEXITY_TIERS = ["trivial", "simple", "standard", "complex"] as const;
export type ComplexityTier = (typeof COMPLEXITY_TIERS)[number];
/**
 * Human-facing names. YAML and persisted decisions keep stable tier keys.
 * `formatComplexityTier` is the sole UI translation point.
 */
export const COMPLEXITY_TIER_LABELS: Record<ComplexityTier, string> = {
	trivial: "问答",
	simple: "轻任务",
	standard: "常规开发",
	complex: "深度工程",
};

export function formatComplexityTier(tier: ComplexityTier): string {
	return `${COMPLEXITY_TIER_LABELS[tier]} (${tier})`;
}


export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Supported thinking range of a model, inclusive. Absent bound = unbounded. */
export interface ThinkingCap {
	/** Lowest supported thinking level. */
	min?: ThinkingLevel;
	/** Highest supported thinking level. */
	max?: ThinkingLevel;
}

export type Billing = "subscription" | "per-token";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (auto-router.yml)
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteTarget {
	provider: string;
	/** Model id under the provider. */
	model: string;
	label?: string;
	/** Default: "subscription". */
	billing?: Billing;
	/** Optional custom balance API URL for per-token providers. */
	balanceEndpoint?: string;
	/** Thinking level for this target; overrides the selected tier's thinking. */
	thinking?: ThinkingLevel;
	/** Thinking levels this model accepts; overrides the provider registry default. */
	thinkingCap?: ThinkingCap;
}

export interface TierConfig {
	/** Thinking level applied when this tier is selected. */
	thinking?: ThinkingLevel;
	/** Ordered candidates; first is preferred, rest are failover chain. */
	targets: RouteTarget[];
}

export interface BudgetLimit {
	/** USD limit. */
	amount: number;
	/** false/undefined = daily limit; true = monthly limit. */
	monthly?: boolean;
}

export type PolicyRuleType =
	| "force-tier"
	| "prefer-provider"
	| "exclude-provider"
	| "force-billing"
	| "force-constraint";

export interface PolicyRuleCondition {
	/** Local hour of day, inclusive start. 0-23. */
	hourStart?: number;
	/** Local hour of day, exclusive end. 0-23. Wraps midnight when hourStart > hourEnd. */
	hourEnd?: number;
	/** 0 = Sunday … 6 = Saturday. */
	weekdays?: number[];
}

export interface PolicyRuleConfig {
	type: PolicyRuleType;
	/** Higher runs first. Default 0. */
	priority?: number;
	/** Restrict rule to these profile names; undefined = all profiles. */
	profiles?: string[];
	when?: PolicyRuleCondition;
	/** force-tier */
	tier?: ComplexityTier;
	/** prefer-provider / exclude-provider */
	providers?: string[];
	/** force-billing */
	billing?: Billing;
	/** force-constraint */
	constraint?: Partial<CapabilityRequirement>;
}

/**
 * Per-role routing inside a profile (omp `modelRoles` → `auto-router/<profile>/<role>`).
 * Two forms, mutually exclusive:
 * - fixed chain: `targets` set → skip classification, route this role through
 *   the chain in order (failover applies). `tierFloor`/`tierCap` rejected.
 * - clamped: no `targets` → classify on the profile's tiers, then clamp the
 *   resolved tier into [tierFloor, tierCap].
 * Shortcut tier pins (@fast/@swe/@reasoning) always escape both forms.
 */
export interface RoleConfig {
	/** Fixed failover chain for this role; skips classification. */
	targets?: RouteTarget[];
	/** Thinking override for this role (wins over tier thinking, loses to target.thinking). */
	thinking?: ThinkingLevel;
	/** Raise the classified tier to at least this. */
	tierFloor?: ComplexityTier;
	/** Lower the classified tier to at most this. */
	tierCap?: ComplexityTier;
}

export interface ProfileConfig {
	description?: string;
	/** Fallback tier when the classifier is below confidence threshold. Default "standard". */
	defaultTier?: ComplexityTier;
	tiers: Partial<Record<ComplexityTier, TierConfig>>;
	/** Role-scoped routing. "default" entries clamp the main-session classification. */
	roles?: Record<string, RoleConfig>;
	budgets?: Record<string, BudgetLimit>;
	rules?: PolicyRuleConfig[];
}

export interface PathActivation {
	path: string;
	profile: string;
}

export interface RouterConfig {
	/** Active profile name. Must exist in `profiles`. */
	active?: string;
	profiles: Record<string, ProfileConfig>;
	/** alias → profile name (single) — kept as array for future multi-target aliases. */
	aliases?: Record<string, string[]>;
	/** Path-prefix scoped auto-activation; longest matching prefix wins. */
	activate?: PathActivation[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Model capabilities & candidates (fed by the host adapter)
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCapabilities {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens?: number;
	cost?: ModelCost;
}

export interface CapabilityRequirement {
	reasoning?: boolean;
	vision?: boolean;
	minContextWindow?: number;
}

/**
 * A route target enriched with host-resolved metadata.
 * `capabilities` is undefined when the host cannot resolve the model —
 * such candidates stay failover-eligible (chain keeps moving) but lose
 * capability-gated contests.
 */
export interface CandidateInfo {
	target: RouteTarget;
	/** Canonical "provider/model" key. */
	key: string;
	capabilities?: ModelCapabilities;
	/** Host auth/health check result. */
	healthy: boolean;
	/** Cooldown expiry (epoch ms); undefined = not cooling down. */
	cooldownUntil?: number;
	/** Why the cooldown was imposed (last failure, human-readable). */
	cooldownReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quota / UVI (host-agnostic; omp adapter maps AuthStorage UsageReport → this)
// ─────────────────────────────────────────────────────────────────────────────

export interface QuotaWindow {
	/** e.g. "5h", "7d", "monthly". */
	id: string;
	/** 0..1; >1 = overage. */
	usedFraction: number;
	/** Window length in seconds, when known. */
	windowSeconds?: number;
	/** Epoch ms when the window resets, when known. */
	resetsAt?: number;
}

export interface QuotaSnapshot {
	provider: string;
	/** Epoch ms. */
	fetchedAt: number;
	windows: QuotaWindow[];
	/** Set when the fetch failed; windows may be empty/stale. */
	error?: string;
}

export type UviStatus = "critical" | "stressed" | "ok" | "surplus" | "unknown";

export interface UviResult {
	provider: string;
	/** consumed_fraction / elapsed_fraction. NaN-safe: unknown windows yield status "unknown". */
	uvi: number;
	status: UviStatus;
	/** Window that drove the classification (highest UVI). */
	windowId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Budgets
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderUsageStats {
	inputTokens: number;
	outputTokens: number;
	/** Estimated USD. */
	cost: number;
	/** Epoch ms of last update. */
	updatedAt: number;
}

export interface BudgetUsage {
	/** YYYY-MM-DD (local) → per-provider stats. */
	daily: Record<string, Record<string, ProviderUsageStats>>;
	/** YYYY-MM → per-provider stats. */
	monthly: Record<string, Record<string, ProviderUsageStats>>;
}

export type BudgetAuditStatus = "ok" | "warning" | "blocked";

export interface BudgetAudit {
	status: BudgetAuditStatus;
	provider: string;
	/** spend / limit; 0 when no limit configured. */
	usedFraction: number;
	/** Configured limit when one applies. */
	limit?: BudgetLimit;
	/** Remaining USD when a limit applies. */
	remaining?: number;
	reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker
// ─────────────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

// ─────────────────────────────────────────────────────────────────────────────
// Shortcuts & classification
// ─────────────────────────────────────────────────────────────────────────────

export type ShortcutToken = "@reasoning" | "@swe" | "@long" | "@vision" | "@fast";

export interface ShortcutResult {
	/** Prompt with the shortcut token stripped. */
	cleanPrompt: string;
	token?: ShortcutToken;
	/** `@profile:<name>` override, when present (stripped like other tokens). */
	profileOverride?: string;
	/** Capability requirement derived from the token. */
	requirement: CapabilityRequirement;
}

export type Intent = "code" | "creative" | "analysis" | "general";

export interface IntentResult {
	intent: Intent;
	/** 0..1 heuristic confidence. */
	confidence: number;
}

export interface ComplexitySignals {
	estimatedTokens: number;
	/** Detected code-ish signals (code fence, file paths, diff, stack trace…). */
	codeSignals: string[];
	/** Repair / debug phrasing that demands reasoning over existing code. */
	repairDebug: boolean;
	/** Code-implementation phrasing; demotes soft planning words from complex. */
	implementation: boolean;
	/**
	 * Both planning and implementation phases detected (e.g. "设计并实现 X").
	 * Semantically ambiguous — the adapter may ask an LLM to adjudicate.
	 */
	mixedPhase: boolean;
	multiStep: boolean;
	/** Mechanical operation (commit/push/deploy/…) needing execution, not design. */
	mechanicalOp: boolean;
	shortQa: boolean;
	hasImages: boolean;
}

export interface ComplexityResult {
	tier: ComplexityTier;
	/** 0..1. Below threshold → caller falls back to profile.defaultTier. */
	confidence: number;
	signals: ComplexitySignals;
	reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface RoutingHints {
	shortcut?: ShortcutToken;
	profileOverride?: string;
	intent?: IntentResult;
	complexity: ComplexityResult;
	/** Human-readable rule application trace ("exclude-provider:google …"). */
	rulesTrace: string[];
	budget: Record<string, BudgetAudit>;
	uvi: Record<string, UviResult>;
}

export interface RoutingDecision {
	/** Profile actually used (after @profile override / path activation). */
	profile: string;
	/** Role within the profile ("default" when the virtual model carried none). */
	role: string;
	tier: ComplexityTier;
	confidence: number;
	/** First of orderedCandidates. */
	target: RouteTarget;
	/** Full failover order after partitioning. */
	orderedCandidates: RouteTarget[];
	/** Effective thinking for the selected target: target override, else chainThinking. */
	thinking?: ThinkingLevel;
	/**
	 * True when the role declared its own target chain: classification is
	 * bypassed and orderedCandidates stays in declared config order. Stamped
	 * by the pipeline — the single source for this rule (shortcut tier pins
	 * already escaped the fixed chain upstream, so consumers never re-derive it).
	 */
	fixedChain?: boolean;
	/**
	 * Chain-level thinking fallback for every target in orderedCandidates:
	 * role override, else tier config. Per-target `thinking` still wins.
	 */
	chainThinking?: ThinkingLevel;
	reasoning: string[];
	estimatedTokens: number;
	/** Remaining USD on the selected target's provider, when a limit applies. */
	budgetRemaining?: number;
	hints: RoutingHints;
	/** Epoch ms. */
	decidedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Failover engine
// ─────────────────────────────────────────────────────────────────────────────

/** Host-agnostic stream event: only `type` is relied upon by the engine. */
export interface StreamEventLike {
	type: string;
	[key: string]: unknown;
}

export type StreamFactory = (
	target: RouteTarget,
	attempt: { signal?: AbortSignal },
) => AsyncIterable<StreamEventLike> | Promise<AsyncIterable<StreamEventLike>>;

export interface FailoverHooks {
	/** Classify a thrown error / terminal error event as retryable-on-another-target. */
	isRetryable: (error: unknown) => boolean;
	/** True once the stream has emitted real content (text/tool calls); failover stops after this. */
	isSubstantive: (event: StreamEventLike) => boolean;
	onFailover?: (from: RouteTarget, to: RouteTarget, error: unknown) => void;
	/** Report a failing target so the caller can cool it down. */
	onTargetFailed?: (target: RouteTarget, error: unknown) => void;
	/** Report the target once substantive output escapes; failover is no longer safe. */
	onTargetOutput?: (target: RouteTarget) => void;
	/** Report a target only after its stream ends cleanly following substantive output. */
	onTargetSettled?: (target: RouteTarget) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

/** Append-only event log row (auto-router.events.jsonl). */
export interface RouterEvent {
	type:
		| "decision"
		| "failover"
		| "settled"
		| "error"
		| "warn"
		| "budget-warning"
		| "budget-blocked"
		| "uvi"
		| "rating"
		| "profile-switch";
	/** Epoch ms. */
	at: number;
	/** Session-correlatable id supplied by the adapter, when available. */
	sessionId?: string;
	[key: string]: unknown;
}

export type Rating = "good" | "bad";

export interface RatingEntry {
	rating: Rating;
	comment?: string;
	provider: string;
	model: string;
	profile: string;
	tier: ComplexityTier;
	at: number;
}
