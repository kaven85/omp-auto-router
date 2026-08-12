/**
 * Pipeline — wires the router-core modules into a single routing decision.
 *
 * Pure orchestration: no IO, no host imports. The adapter supplies enriched
 * candidates, quota snapshots, and latency data; the pipeline returns a
 * RoutingDecision plus the shortcut-stripped prompt to forward downstream.
 *
 * Flow (design doc §5):
 *   shortcut → context/intent/complexity → profile+tier resolution
 *   → policy pre-constraint → requirement merge → constraint solve
 *   → budget audit + UVI → partition → policy post-partition → decision
 */

import { auditBudget } from "./budget-auditor";
import type { BudgetTracker } from "./budget-tracker";
import { partitionCandidates } from "./candidate-partitioner";
import type { CircuitBreaker } from "./circuit-breaker";
import { classifyComplexity, type ClassifierOverrides } from "./complexity-classifier";
import { classifyIntent } from "./intent-classifier";
import type { LatencyTracker } from "./latency-tracker";
import { PolicyEngine } from "./policy-engine";
import type { ProfileRegistry } from "./profile-registry";
import { parseShortcut } from "./shortcut-parser";
import { solveConstraints } from "./constraint-solver";
import type {
	CandidateInfo,
	CapabilityRequirement,
	ComplexityTier,
	PolicyRuleConfig,
	QuotaSnapshot,
	RoutingDecision,
	RoutingHints,
	UviResult,
} from "./types";
import { classifyMonthlySpendUvi, computeAllUvi } from "./uvi";

export interface PipelineInput {
	/** Raw user prompt, shortcuts NOT yet stripped. */
	rawPrompt: string;
	/** Forced profile (from the selected virtual model, e.g. auto-router/economy). */
	profile?: string;
	hasImages: boolean;
	/** Consecutive turns on the same task (sticky escalation). 0 = fresh. */
	conversationDepth: number;
	/** Tier of the previous decision this session, if any. */
	priorTier?: ComplexityTier;
	/** Active-profile tier targets, pre-enriched by the adapter. */
	candidates: CandidateInfo[];
	/** provider → quota snapshot (adapter: AuthStorage.fetchUsageReports). */
	quota: Record<string, QuotaSnapshot>;
	/** Optional authoritative token estimate from the host. Falls back to chars/4 of the prompt. */
	estimatedTokens?: number;
	/**
	 * Tier adjudicated by the session's current LLM for a semantically
	 * ambiguous (mixed-phase) prompt. Precedence: shortcut pin > policy
	 * force-tier > adjudication > classifier > defaultTier.
	 */
	adjudicatedTier?: ComplexityTier;
	now: Date;
}

export interface PipelineDeps {
	registry: ProfileRegistry;
	circuit: CircuitBreaker;
	latency: LatencyTracker;
	budgets: BudgetTracker;
	/** Exclude stressed-UVI providers entirely (OMP_AUTO_ROUTER_UVI_HARD). */
	uviHardMode?: boolean;
	/** Below this, fall back to profile.defaultTier. Default 0.45. */
	confidenceThreshold?: number;
	/** Extra rules layered on top of the active profile's rules. */
	globalRules?: PolicyRuleConfig[];
	/** User-edited classifier keyword overrides (`/auto-router rules`). */
	classifierOverrides?: ClassifierOverrides;
}

export interface PipelineResult {
	decision: RoutingDecision;
	/** Prompt with router tokens stripped — this is what the model sees. */
	cleanPrompt: string;
}

/** Tier ladder rank used when reporting/escalating. */
const TIER_RANK: Record<ComplexityTier, number> = {
	trivial: 0,
	simple: 1,
	standard: 2,
	complex: 3,
};

/** Tiers strictly above `tier`, ascending (nearest higher tier first). */
const TIER_ORDER_FOR_ESC: readonly ComplexityTier[] = ["trivial", "simple", "standard", "complex"];
function higherTierOrder(tier: ComplexityTier): ComplexityTier[] {
	return TIER_ORDER_FOR_ESC.filter(t => TIER_RANK[t] > TIER_RANK[tier]);
}

export function route(input: PipelineInput, deps: PipelineDeps): PipelineResult {
	const now = input.now;
	const nowMs = now.getTime();
	const reasoning: string[] = [];

	// 1. Shortcut parsing (strip tokens the model must never see)
	const shortcut = parseShortcut(input.rawPrompt);
	if (shortcut.token) reasoning.push(`shortcut ${shortcut.token}`);
	if (shortcut.profileOverride) reasoning.push(`profile override @profile:${shortcut.profileOverride}`);

	// 2. Context + intent + complexity
	const estimatedTokens =
		input.estimatedTokens && Number.isFinite(input.estimatedTokens) && input.estimatedTokens > 0
			? Math.ceil(input.estimatedTokens)
			: Math.max(1, Math.ceil(shortcut.cleanPrompt.length / 4));
	const intent = classifyIntent(shortcut.cleanPrompt);
	const complexity = classifyComplexity({
		prompt: shortcut.cleanPrompt,
		estimatedTokens,
		hasImages: input.hasImages,
		conversationDepth: input.conversationDepth,
		intent,
		shortcut,
		...(input.priorTier !== undefined ? { priorTier: input.priorTier } : {}),
		...(deps.classifierOverrides !== undefined ? { overrides: deps.classifierOverrides } : {}),
	});
	reasoning.push(...complexity.reasons);

	// 3. Profile resolution: @profile override (per-request) > model-derived
	//    profile (input.profile, set by the selected virtual model) > active.
	const activeName = deps.registry.current();
	let profileName = input.profile ?? activeName;
	if (shortcut.profileOverride) {
		const resolved = deps.registry.resolveAlias(shortcut.profileOverride) ?? shortcut.profileOverride;
		if (deps.registry.profile(resolved)) {
			profileName = resolved;
		} else {
			reasoning.push(`@profile:${shortcut.profileOverride} unknown — staying on ${profileName}`);
		}
	}
	const effectiveProfile = deps.registry.profile(profileName) ?? deps.registry.active().profile;

	// 4. Policy engine pre-constraint (global rules + profile rules)
	const rules = [...(deps.globalRules ?? []), ...(effectiveProfile.rules ?? [])];
	const engine = new PolicyEngine(rules);
	const pre = engine.preConstraint({ profile: profileName, now });
	reasoning.push(...pre.trace);

	// 5. Tier resolution: shortcut pin > policy override > classifier (confidence-gated)
	const threshold = deps.confidenceThreshold ?? 0.45;
	let tier: ComplexityTier;
	let tierSource: string;
	if (shortcut.token === "@fast" || shortcut.token === "@swe" || shortcut.token === "@reasoning") {
		// Explicit per-request shortcut pin wins over any policy force-tier:
		// the user's request-scoped intent outranks config-level rules.
		tier = complexity.tier; // classifier already applied the shortcut pin
		tierSource = `shortcut ${shortcut.token}`;
	} else if (pre.tierOverride) {
		tier = pre.tierOverride;
		tierSource = "policy force-tier";
	} else if (input.adjudicatedTier !== undefined) {
		// LLM adjudication of a mixed-phase prompt outranks the keyword
		// heuristic but never the user's shortcut or a policy rule.
		tier = input.adjudicatedTier;
		tierSource = "llm adjudication";
	} else if (complexity.confidence >= threshold) {
		tier = complexity.tier;
		tierSource = `classifier (${complexity.confidence.toFixed(2)})`;
	} else {
		tier = effectiveProfile.defaultTier ?? "standard";
		tierSource = `defaultTier (confidence ${complexity.confidence.toFixed(2)} < ${threshold})`;
	}
	reasoning.push(`tier=${tier} ← ${tierSource}; profile=${profileName}`);

	// 6. Capability requirement merge
	const requirement: CapabilityRequirement = { ...shortcut.requirement, ...pre.extraConstraint };
	if (shortcut.token === "@long") {
		requirement.minContextWindow = Math.max(100_000, estimatedTokens);
	}
	if (input.hasImages) requirement.vision = true;

	// 7. Tier config + candidates (profile tier fallback ladder via registry)
	let tierCfg = deps.registry.tierConfig(profileName, tier);
	const wanted = new Set((tierCfg?.targets ?? []).map(t => `${t.provider}/${t.model}`));
	const tierCandidates = input.candidates.filter(c => wanted.has(c.key));

	// 8. Constraint solving (health, cooldown, circuit, capabilities, policy exclusions)
	const hardUviProviders = new Set<string>();
	const uvi = computeAllUvi(Object.values(input.quota), nowMs);
	if (deps.uviHardMode) {
		for (const [provider, result] of Object.entries(uvi)) {
			if (result.status === "stressed" || result.status === "critical") hardUviProviders.add(provider);
		}
	}
	const solved = solveConstraints(tierCandidates, requirement, {
		circuit: deps.circuit,
		nowMs,
		hardUviProviders,
	});
	let eligible = solved.eligible;
	for (const ex of solved.excluded) reasoning.push(`excluded ${ex.candidate.key}: ${ex.reason}`);
	if (pre.excludedProviders.size > 0) {
		eligible = eligible.filter(c => !pre.excludedProviders.has(c.target.provider));
	}
	if (pre.billingForce) {
		const forced = eligible.filter(c => (c.target.billing ?? "subscription") === pre.billingForce);
		if (forced.length > 0) eligible = forced;
	}

	// 8b. Reasoning-required guarantees: a task that demands reasoning must
	// never be served by a non-reasoning model, and must keep a reasoning
	// fallback even when the resolved tier's reasoning candidates all fail.
	// If the resolved tier yields no reasoning-eligible candidate, widen to the
	// nearest HIGHER tier that has one and escalate (precise: pick the least
	// expensive higher tier that satisfies the capability, not straight to
	// complex).
	const originalTier = tier;
	if (requirement.reasoning === true && !eligible.some(c => c.capabilities?.reasoning === true)) {
		for (const escTier of higherTierOrder(originalTier)) {
			// Read the tier's OWN targets (no ladder fallback — we must not
			// reach back down into a lower tier we are trying to leave).
			const escCfg = effectiveProfile.tiers[escTier];
			if (escCfg === undefined) continue;
			const escWanted = new Set(escCfg.targets.map(t => `${t.provider}/${t.model}`));
			const escPool = input.candidates.filter(c => escWanted.has(c.key));
			if (escPool.length === 0) continue;
			const solvedUp = solveConstraints(escPool, requirement, {
				circuit: deps.circuit,
				nowMs,
				hardUviProviders,
			});
			for (const ex of solvedUp.excluded) {
				reasoning.push(`excluded ${ex.candidate.key}: ${ex.reason}`);
			}
			if (solvedUp.eligible.length > 0) {
				eligible = solvedUp.eligible;
				tier = escTier;
				tierCfg = escCfg;
				reasoning.push(
					`reasoning required: no reasoning candidate in ${originalTier} tier → escalated to ${escTier} (${solvedUp.eligible
						.map(c => c.key)
						.join(", ")})`,
				);
				break;
			}
		}
	}

	// 9. Budget audit (+ synthetic monthly UVI for per-token providers with monthly limits)
	const budget: RoutingHints["budget"] = {};
	const limits = deps.budgets.limits();
	for (const c of eligible) {
		const provider = c.target.provider;
		if (budget[provider]) continue;
		const usage = deps.budgets.usage(provider, now);
		const limit = limits[provider];
		let providerUvi = uvi[provider];
		if (!providerUvi && limit?.monthly) {
			providerUvi = classifyMonthlySpendUvi(usage.monthly?.cost ?? 0, limit.amount, now);
			uvi[provider] = providerUvi;
		}
		budget[provider] = auditBudget(provider, usage, limit, providerUvi);
		if (budget[provider]?.status === "warning") {
			reasoning.push(`budget warning ${provider}: ${(budget[provider].usedFraction * 100).toFixed(0)}% of limit`);
		}
	}

	// 10. Partition (promoted/normal/demoted + latency/cost ordering)
	const { ordered, buckets } = partitionCandidates(eligible, {
		uvi,
		budget,
		latency: deps.latency.snapshot(),
		circuit: deps.circuit,
		nowMs,
		hardMode: deps.uviHardMode ?? false,
		now,
	});
	reasoning.push(
		`candidates: promoted=${buckets.promoted.length} normal=${buckets.normal.length} demoted=${buckets.demoted.length}`,
	);

	// 11. Policy post-partition (preferred providers boost)
	const finalOrder = engine.postPartition(ordered, { preferredProviders: pre.preferredProviders });

	// 12. Decision
	const selected = finalOrder[0];
	const selectedThinking = selected?.target.thinking ?? tierCfg?.thinking;
	const decision: RoutingDecision = {
		profile: profileName,
		tier,
		confidence: complexity.confidence,
		target: selected?.target ?? { provider: "none", model: "none" },
		orderedCandidates: finalOrder.map(c => c.target),
		...(selectedThinking !== undefined ? { thinking: selectedThinking } : {}),
		reasoning,
		estimatedTokens,
		hints: {
			...(shortcut.token !== undefined ? { shortcut: shortcut.token } : {}),
			...(shortcut.profileOverride !== undefined ? { profileOverride: shortcut.profileOverride } : {}),
			intent,
			complexity,
			rulesTrace: pre.trace,
			budget,
			uvi,
		},
		decidedAt: nowMs,
	};
	const selectedBudget = selected ? budget[selected.target.provider] : undefined;
	if (selectedBudget?.remaining !== undefined) decision.budgetRemaining = selectedBudget.remaining;

	return { decision, cleanPrompt: shortcut.cleanPrompt };
}
