/**
 * PolicyEngine — applies declarative policy rules around the routing pipeline.
 *
 * `preConstraint` runs BEFORE constraint solving: it evaluates rule conditions
 * (local hour window incl. midnight wrap, weekdays) and `profiles` scoping,
 * then folds every applicable rule into routing overrides. Rules run sorted by
 * priority (desc), ties broken by config order. Scalar effects (force-tier,
 * force-billing) are first-wins: the highest-priority rule decides and later
 * conflicting rules are traced as ignored. Set/list effects accumulate.
 * Every applied rule appends a human-readable trace line.
 *
 * `postPartition` runs AFTER candidate partitioning: it stably boosts
 * preferred providers within the already-computed order — the partitioner is
 * never re-run, and relative order inside both the boosted and the remaining
 * group is preserved.
 */

import type {
	Billing,
	CapabilityRequirement,
	ComplexityTier,
	PolicyRuleCondition,
	PolicyRuleConfig,
	RouteTarget,
} from "./types";

/** Input for {@link PolicyEngine.preConstraint}. */
export interface PreConstraintInput {
	/** Active profile name (rules may scope to specific profiles). */
	profile: string;
	/** Local-time basis for `when` conditions. */
	now: Date;
}

/** Output of {@link PolicyEngine.preConstraint}. */
export interface PreConstraintResult {
	/** Forced complexity tier from the highest-priority force-tier rule. */
	tierOverride?: ComplexityTier;
	/** Providers to exclude from candidacy (accumulated). */
	excludedProviders: Set<string>;
	/** Providers to boost post-partition, in rule application order, deduped. */
	preferredProviders: string[];
	/** Forced billing mode from the highest-priority force-billing rule. */
	billingForce?: Billing;
	/** Merged capability requirement (reasoning/vision OR-ed, window max-ed). */
	extraConstraint: Partial<CapabilityRequirement>;
	/** One human-readable line per applied rule, in application order. */
	trace: string[];
}

/**
 * Ordered policy rule set. The engine holds no state beyond the rules; all
 * evaluation inputs are injected per call.
 */
export class PolicyEngine {
	private readonly rules: PolicyRuleConfig[];

	constructor(rules: PolicyRuleConfig[]) {
		this.rules = [...rules];
	}

	/**
	 * Evaluate rules for `input.profile` at `input.now` and fold them into
	 * routing overrides. See module doc for ordering and first-wins semantics.
	 */
	preConstraint(input: PreConstraintInput): PreConstraintResult {
		const applicable = this.rules
			.map((rule, index) => ({ rule, index }))
			.filter(
				({ rule }) =>
					(rule.profiles === undefined || rule.profiles.includes(input.profile)) &&
					matchesWhen(rule.when, input.now),
			)
			.sort(
				(a, b) =>
					(b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index,
			);

		const result: PreConstraintResult = {
			excludedProviders: new Set<string>(),
			preferredProviders: [],
			extraConstraint: {},
			trace: [],
		};
		let tierForced = false;
		let billingForced = false;

		for (const { rule } of applicable) {
			const priority = rule.priority ?? 0;
			switch (rule.type) {
				case "force-tier": {
					if (rule.tier === undefined) break;
					if (tierForced) {
						result.trace.push(
							`force-tier:${rule.tier} ignored (already forced by higher-priority rule; priority=${priority})`,
						);
						break;
					}
					result.tierOverride = rule.tier;
					tierForced = true;
					result.trace.push(`force-tier:${rule.tier} (priority=${priority})`);
					break;
				}
				case "prefer-provider": {
					const providers = rule.providers ?? [];
					if (providers.length === 0) break;
					for (const provider of providers) {
						if (!result.preferredProviders.includes(provider)) {
							result.preferredProviders.push(provider);
						}
					}
					result.trace.push(
						`prefer-provider:${providers.join(",")} (priority=${priority})`,
					);
					break;
				}
				case "exclude-provider": {
					const providers = rule.providers ?? [];
					if (providers.length === 0) break;
					for (const provider of providers) result.excludedProviders.add(provider);
					result.trace.push(
						`exclude-provider:${providers.join(",")} (priority=${priority})`,
					);
					break;
				}
				case "force-billing": {
					if (rule.billing === undefined) break;
					if (billingForced) {
						result.trace.push(
							`force-billing:${rule.billing} ignored (already forced by higher-priority rule; priority=${priority})`,
						);
						break;
					}
					result.billingForce = rule.billing;
					billingForced = true;
					result.trace.push(`force-billing:${rule.billing} (priority=${priority})`);
					break;
				}
				case "force-constraint": {
					const constraint = rule.constraint;
					if (!constraint) break;
					if (constraint.reasoning === true) result.extraConstraint.reasoning = true;
					if (constraint.vision === true) result.extraConstraint.vision = true;
					if (constraint.minContextWindow !== undefined) {
						result.extraConstraint.minContextWindow = Math.max(
							result.extraConstraint.minContextWindow ?? 0,
							constraint.minContextWindow,
						);
					}
					result.trace.push(
						`force-constraint:${describeConstraint(constraint)} (priority=${priority})`,
					);
					break;
				}
			}
		}
		return result;
	}

	/**
	 * Stably boost candidates whose provider is preferred: they move ahead of
	 * non-preferred ones while the relative order inside each group is kept
	 * exactly as the partitioner produced it. Call AFTER partitioning; the
	 * partitioner is never re-run. Returns a new array.
	 */
	postPartition<T extends { target: RouteTarget }>(
		ordered: T[],
		prefs: { preferredProviders: string[] },
	): T[] {
		if (prefs.preferredProviders.length === 0) return [...ordered];
		const preferred = new Set(prefs.preferredProviders);
		const boosted: T[] = [];
		const rest: T[] = [];
		for (const candidate of ordered) {
			(preferred.has(candidate.target.provider) ? boosted : rest).push(candidate);
		}
		return [...boosted, ...rest];
	}
}

/**
 * Evaluate a `when` condition against local time. Absent condition matches
 * always; present fields are AND-ed. The hour window is [hourStart, hourEnd)
 * in local hours and wraps midnight when hourStart > hourEnd. An empty window
 * (hourStart === hourEnd) never matches. A missing bound is open: only
 * hourStart means "from hourStart on", only hourEnd means "before hourEnd".
 */
function matchesWhen(when: PolicyRuleCondition | undefined, now: Date): boolean {
	if (!when) return true;
	if (when.weekdays !== undefined && !when.weekdays.includes(now.getDay())) {
		return false;
	}
	const hasStart = when.hourStart !== undefined;
	const hasEnd = when.hourEnd !== undefined;
	if (!hasStart && !hasEnd) return true;
	const hour = now.getHours();
	if (hasStart && hasEnd) {
		const start = when.hourStart as number;
		const end = when.hourEnd as number;
		if (start === end) return false;
		if (start < end) return hour >= start && hour < end;
		return hour >= start || hour < end;
	}
	if (hasStart) return hour >= (when.hourStart as number);
	return hour < (when.hourEnd as number);
}

/** Compact human-readable rendering of a forced constraint for the trace. */
function describeConstraint(constraint: Partial<CapabilityRequirement>): string {
	const parts: string[] = [];
	if (constraint.reasoning === true) parts.push("reasoning");
	if (constraint.vision === true) parts.push("vision");
	if (constraint.minContextWindow !== undefined) {
		parts.push(`minContextWindow>=${constraint.minContextWindow}`);
	}
	return parts.length > 0 ? parts.join(",") : "empty";
}
