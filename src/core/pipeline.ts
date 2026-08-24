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
import { CONTEXT_SIZE_BOUNDARIES } from "./context-analyzer";
import { classifyIntent } from "./intent-classifier";
import type { LatencyTracker } from "./latency-tracker";
import { PolicyEngine } from "./policy-engine";
import { DEFAULT_ROLE, type ProfileRegistry } from "./profile-registry";
import { parseShortcut, TIER_PIN_SHORTCUTS } from "./shortcut-parser";
import { solveConstraints } from "./constraint-solver";
import type {
	CandidateInfo,
	CapabilityRequirement,
	ComplexityTier,
	PolicyRuleConfig,
	QuotaSnapshot,
	RouteTarget,
	RoutingDecision,
	RoutingHints,
	TierConfig,
} from "./types";
import { COMPLEXITY_TIERS } from "./types";
import { classifyMonthlySpendUvi, computeAllUvi } from "./uvi";

export interface PipelineInput {
	/** Raw user prompt, shortcuts NOT yet stripped. */
	rawPrompt: string;
	/** Forced profile (from the selected virtual model, e.g. auto-router/economy). */
	profile?: string;
	/**
	 * Role within the profile (from the virtual model `auto-router/<profile>/<role>`).
	 * Absent/"default" = main-session classification on the profile tiers.
	 */
	role?: string;
	hasImages: boolean;
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

	// 3b. Role resolution. A fixed-chain role replaces tier classification with
	//     its own targets; a clamped role bounds the classified tier. Shortcut
	//     tier pins escape both — the user's request-scoped intent outranks
	//     role config.
	const role = input.role ?? DEFAULT_ROLE;
	const roleCfg = effectiveProfile.roles?.[role];
	const isPinShortcut = shortcut.token !== undefined && TIER_PIN_SHORTCUTS.includes(shortcut.token);
	const fixedChain = roleCfg?.targets !== undefined && !isPinShortcut;
	if (roleCfg !== undefined) {
		reasoning.push(
			fixedChain
				? `role=${role} (fixed chain, classification bypassed)`
				: `role=${role} (tierFloor=${roleCfg.tierFloor ?? "-"}, tierCap=${roleCfg.tierCap ?? "-"})`,
		);
	} else if (role !== DEFAULT_ROLE) {
		reasoning.push(`role=${role} undeclared — routing as default`);
	}

	// 4. Policy engine pre-constraint (global rules + profile rules)
	const rules = [...(deps.globalRules ?? []), ...(effectiveProfile.rules ?? [])];
	const engine = new PolicyEngine(rules);
	const pre = engine.preConstraint({ profile: profileName, now });
	reasoning.push(...pre.trace);

	// 5. Tier resolution: shortcut pin > policy override > classifier (confidence-gated)
	const threshold = deps.confidenceThreshold ?? 0.45;
	let tier: ComplexityTier;
	let tierSource: string;
	if (fixedChain) {
		// Fixed-chain role: no tier semantics of its own; the profile default
		// tier is a display/escalation label, the chain comes from the role.
		tier = effectiveProfile.defaultTier ?? "standard";
		tierSource = `role ${role} fixed chain`;
	} else if (isPinShortcut) {
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
	// Role clamps bound every source except an explicit shortcut pin.
	if (!fixedChain && !isPinShortcut && roleCfg !== undefined) {
		if (roleCfg.tierFloor !== undefined && TIER_RANK[tier] < TIER_RANK[roleCfg.tierFloor]) {
			reasoning.push(`role ${role} tierFloor: ${tier} → ${roleCfg.tierFloor}`);
			tier = roleCfg.tierFloor;
			tierSource += ` + role tierFloor`;
		}
		if (roleCfg.tierCap !== undefined && TIER_RANK[tier] > TIER_RANK[roleCfg.tierCap]) {
			reasoning.push(`role ${role} tierCap: ${tier} → ${roleCfg.tierCap}`);
			tier = roleCfg.tierCap;
			tierSource += ` + role tierCap`;
		}
	}
	reasoning.push(`tier=${tier} ← ${tierSource}; profile=${profileName}`);

	// 6. Capability requirement merge
	const requirement: CapabilityRequirement = { ...shortcut.requirement, ...pre.extraConstraint };
	if (shortcut.token === "@long") {
		requirement.minContextWindow = Math.max(100_000, estimatedTokens);
	}
	// Epic contexts (≥100k tokens) need a model whose window fits: derive the
	// requirement from context size so small-window candidates are excluded
	// and step 8b can escalate to a tier whose models fit. Mirrors @long.
	if (estimatedTokens >= CONTEXT_SIZE_BOUNDARIES.long) {
		requirement.minContextWindow = Math.max(requirement.minContextWindow ?? 0, estimatedTokens);
	}
	if (input.hasImages) requirement.vision = true;

	// 7. Tier config + candidates (profile tier fallback ladder via registry;
	//    fixed-chain roles substitute their own targets as a synthetic tier).
	//    Candidates are built FROM the declared targets, in declared order:
	//    the enriched copy is looked up by key and the declared target object
	//    is kept, so a role/tier target's own billing/thinking/balanceEndpoint
	//    wins and duplicate keys (a model listed in both a tier and a role)
	//    never enter the chain twice.
	let tierCfg: TierConfig | undefined = fixedChain
		? { targets: roleCfg?.targets ?? [], ...(roleCfg?.thinking !== undefined ? { thinking: roleCfg.thinking } : {}) }
		: deps.registry.tierConfig(profileName, tier);
	const candidatesByKey = new Map(input.candidates.map(c => [c.key, c]));
	const declaredCandidates = (targets: readonly RouteTarget[]): CandidateInfo[] =>
		targets.flatMap(t => {
			const enriched = candidatesByKey.get(`${t.provider}/${t.model}`);
			return enriched === undefined ? [] : [{ ...enriched, target: t }];
		});
	const tierCandidates = declaredCandidates(tierCfg?.targets ?? []);

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

	// 8b. Capability-required guarantees: a task that demands a capability
	// (reasoning / context window) must never be served by a candidate that
	// lacks it, and must keep a capable fallback even when the resolved
	// tier's candidates all fail. If the resolved tier yields no capable
	// candidate, widen to the nearest HIGHER tier that has one and escalate
	// (precise: pick the least expensive higher tier that satisfies the
	// capability, not straight to complex).
	const originalTier = tier;
	// A candidate fits when it demonstrably satisfies every required
	// capability. Undefined capabilities count as a miss: a required
	// capability escalates to a tier that can prove it rather than risk a
	// provider-side failure (same contract as the reasoning path).
	const capabilityFits = (c: CandidateInfo): boolean =>
		(requirement.reasoning !== true || c.capabilities?.reasoning === true) &&
		(requirement.minContextWindow === undefined ||
			(c.capabilities?.contextWindow ?? 0) >= requirement.minContextWindow);
	const capabilityRequired = requirement.reasoning === true || requirement.minContextWindow !== undefined;
	// Fixed-chain roles never escalate: the declared chain is the contract.
	// Clamped roles bound escalation by tierCap — only shortcut pins escape.
	const escalationCap = !fixedChain && !isPinShortcut ? roleCfg?.tierCap : undefined;
	if (!fixedChain && capabilityRequired && !eligible.some(capabilityFits)) {
		const missingCapability = requirement.reasoning === true ? "reasoning" : "context window";
		// Tiers strictly above the resolved tier, ascending (nearest first).
		for (const escTier of COMPLEXITY_TIERS.filter(t => TIER_RANK[t] > TIER_RANK[originalTier])) {
			if (escalationCap !== undefined && TIER_RANK[escTier] > TIER_RANK[escalationCap]) break;
			// Read the tier's OWN targets (no ladder fallback — we must not
			// reach back down into a lower tier we are trying to leave).
			const escCfg = effectiveProfile.tiers[escTier];
			if (escCfg === undefined) continue;
			const escPool = declaredCandidates(escCfg.targets);
			if (escPool.length === 0) continue;
			const solvedUp = solveConstraints(escPool, requirement, {
				circuit: deps.circuit,
				nowMs,
				hardUviProviders,
			});
			for (const ex of solvedUp.excluded) {
				reasoning.push(`excluded ${ex.candidate.key}: ${ex.reason}`);
			}
			// The escalated pool must satisfy the same provider/billing
			// policies as the original tier — escalation widens the tier,
			// never the policy envelope.
			let escEligible = solvedUp.eligible;
			if (pre.excludedProviders.size > 0) {
				escEligible = escEligible.filter(c => !pre.excludedProviders.has(c.target.provider));
			}
			if (pre.billingForce) {
				const forced = escEligible.filter(c => (c.target.billing ?? "subscription") === pre.billingForce);
				if (forced.length > 0) escEligible = forced;
			}
			if (escEligible.some(capabilityFits)) {
				eligible = escEligible;
				tier = escTier;
				tierCfg = escCfg;
				reasoning.push(
					`${missingCapability} required: no ${missingCapability}-capable candidate in ${originalTier} tier → escalated to ${escTier} (${escEligible
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

	// 11. Policy post-partition (preferred providers boost). Fixed-chain
	//     roles keep their declared order: the operator's chain is the
	//     contract, so neither the partitioner nor provider boosts reorder it
	//     (eligible stayed in declared order through solver and filters).
	const finalOrder = fixedChain ? eligible : engine.postPartition(ordered, { preferredProviders: pre.preferredProviders });

	// 12. Decision. Thinking precedence (single source — the runtime consumes
	//     these stamps instead of re-deriving them): chainThinking is the
	//     chain-level fallback (role override, else tier config; for a fixed
	//     chain tierCfg IS the synthetic role tier); the effective level adds
	//     the per-target override on top.
	const selected = finalOrder[0];
	const chainThinking = roleCfg?.thinking ?? (fixedChain ? undefined : tierCfg?.thinking);
	const selectedThinking = selected?.target.thinking ?? chainThinking;
	const decision: RoutingDecision = {
		profile: profileName,
		role,
		tier,
		confidence: complexity.confidence,
		target: selected?.target ?? { provider: "none", model: "none" },
		orderedCandidates: finalOrder.map(c => c.target),
		...(selectedThinking !== undefined ? { thinking: selectedThinking } : {}),
		...(fixedChain ? { fixedChain: true } : {}),
		...(chainThinking !== undefined ? { chainThinking } : {}),
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
