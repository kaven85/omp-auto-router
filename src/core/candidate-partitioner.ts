/**
 * Candidate partitioner — orders eligible candidates into a failover chain.
 *
 * Bucketing per candidate (by provider-level UVI / budget signals):
 *  - promoted: surplus UVI (plenty of quota headroom);
 *  - demoted: stressed UVI, budget warning, or half-open circuit;
 *  - normal: everything else (incl. unknown/missing signals).
 *
 * Exclusions (candidate is dropped entirely — returned nowhere):
 *  - budget blocked;
 *  - critical UVI;
 *  - stressed UVI under `hardMode`;
 *  - circuit open.
 * Safety net: if EVERY candidate would be excluded, exclusions are suppressed
 * and all candidates fall back to the normal bucket — the user is never fully
 * blocked. (Circuit-open exclusion is defense in depth; the constraint solver
 * normally removes open circuits upstream.)
 *
 * Ordering: buckets concatenate as promoted → normal → demoted. Within a
 * bucket, subscription-billed candidates outrank per-token ones — quota
 * already paid for is spent before metered balance. A per-token candidate
 * only jumps ahead of a subscription candidate whose rolling latency has
 * crossed an absolute usability bar (see SUBSCRIPTION_LATENCY_MAX_MS);
 * relative speed is ignored because total stream duration confounds model
 * speed with response length. Among same-billing candidates the sort is rolling-average latency ascending; candidates without latency
 * history sort last. Ties (unknown or equal latency) break by estimated
 * per-request cost ascending when BOTH candidates expose cost — using a flat
 * 1M-input + 1M-output-token estimate for comparison only. Anything still
 * tied keeps its input order (stable sort).
 */

import type { BudgetAudit, CandidateInfo, UviResult } from "./types";
import type { CircuitBreaker } from "./circuit-breaker";

/** Inputs for {@link partitionCandidates}. */
export interface PartitionInput {
	/** provider → UVI classification (absent = unknown). */
	uvi: Record<string, UviResult>;
	/** provider → budget audit (absent = no limit / no data). */
	budget: Record<string, BudgetAudit>;
	/** "provider/model" → rolling-average latency ms (absent = no history). */
	latency: Record<string, number>;
	/** Circuit breaker consulted per candidate key. */
	circuit: CircuitBreaker;
	/** Epoch ms basis for circuit evaluation. */
	nowMs: number;
	/** Hard mode: stressed-UVI providers are excluded entirely. */
	hardMode?: boolean;
	/** Local-time basis (reserved for time-of-day aware policies; unused today). */
	now: Date;
}

/** Named buckets; `ordered` is their concatenation in this order. */
export interface PartitionBuckets {
	promoted: CandidateInfo[];
	normal: CandidateInfo[];
	demoted: CandidateInfo[];
}

/** Result of {@link partitionCandidates}. */
export interface PartitionResult {
	/** Failover order: promoted, then normal, then demoted. */
	ordered: CandidateInfo[];
	buckets: PartitionBuckets;
}

/**
 * Partition and order `candidates`. Excluded candidates appear nowhere in the
 * result; see the module doc for the all-excluded fallback.
 */
export function partitionCandidates(
	candidates: CandidateInfo[],
	input: PartitionInput,
): PartitionResult {
	const hardMode = input.hardMode ?? false;
	const buckets: PartitionBuckets = { promoted: [], normal: [], demoted: [] };

	const flags = candidates.map((candidate) => ({
		candidate,
		excluded: isExcluded(candidate, input, hardMode),
	}));
	// Never fully block the user: when every candidate would be excluded,
	// suppress exclusions and treat all as normal.
	const suppressExclusions =
		flags.length > 0 && flags.every((flag) => flag.excluded);

	for (const { candidate, excluded } of flags) {
		if (excluded && !suppressExclusions) continue;
		buckets[suppressExclusions ? "normal" : bucketOf(candidate, input)].push(candidate);
	}

	const byLatencyThenCost = compareCandidates(input);
	buckets.promoted.sort(byLatencyThenCost);
	buckets.normal.sort(byLatencyThenCost);
	buckets.demoted.sort(byLatencyThenCost);

	return {
		ordered: [...buckets.promoted, ...buckets.normal, ...buckets.demoted],
		buckets,
	};
}

/** Hard exclusion gates; see module doc. */
function isExcluded(
	candidate: CandidateInfo,
	input: PartitionInput,
	hardMode: boolean,
): boolean {
	const uvi = input.uvi[candidate.target.provider];
	const budget = input.budget[candidate.target.provider];
	if (budget?.status === "blocked") return true;
	if (uvi?.status === "critical") return true;
	if (hardMode && uvi?.status === "stressed") return true;
	if (input.circuit.state(candidate.key, input.nowMs) === "open") return true;
	return false;
}

/** Bucket assignment for a non-excluded candidate. */
function bucketOf(
	candidate: CandidateInfo,
	input: PartitionInput,
): keyof PartitionBuckets {
	const uvi = input.uvi[candidate.target.provider];
	const budget = input.budget[candidate.target.provider];
	if (uvi?.status === "surplus") return "promoted";
	if (uvi?.status === "stressed") return "demoted";
	if (budget?.status === "warning") return "demoted";
	if (input.circuit.state(candidate.key, input.nowMs) === "half-open") return "demoted";
	return "normal";
}

/**
 * Subscription→per-token override: a per-token candidate may outrank a
 * subscription candidate only when the subscription rolling latency exceeds
 * an absolute "unusable" bar. Latency here is total stream duration, which
 * grows with response length as much as with model speed — a frontier
 * subscription model doing real work is routinely 10× "slower" than a
 * flash-class metered model while serving perfectly well. A ratio-based
 * comparison would therefore dethrone subscription models almost
 * permanently; only an absolute usability bar matches "switch when the
 * degradation actually hurts normal use".
 */
export const SUBSCRIPTION_LATENCY_MAX_MS = 60_000;

/**
 * Comparator: subscription billing first (per-token only ahead when the
 * subscription latency is significantly degraded), then latency ascending
 * (no-history last), then estimated cost ascending when both sides expose
 * cost, else 0 (stable — input order kept).
 */
function compareCandidates(
	input: PartitionInput,
): (a: CandidateInfo, b: CandidateInfo) => number {
	return (a, b) => {
		// Latency history only counts when present and finite.
		const rawA = input.latency[a.key];
		const rawB = input.latency[b.key];
		const latencyA = rawA !== undefined && Number.isFinite(rawA) ? rawA : undefined;
		const latencyB = rawB !== undefined && Number.isFinite(rawB) ? rawB : undefined;

		const billingA = a.target.billing ?? "subscription";
		const billingB = b.target.billing ?? "subscription";
		if (billingA !== billingB) {
			const subLatency = billingA === "subscription" ? latencyA : latencyB;
			const tokenLatency = billingA === "subscription" ? latencyB : latencyA;
			// Per-token jumps ahead only when the subscription rolling latency
			// is past the absolute usability bar AND worse than the metered
			// candidate; missing history is not evidence of degradation.
			const degraded =
				subLatency !== undefined &&
				tokenLatency !== undefined &&
				subLatency >= SUBSCRIPTION_LATENCY_MAX_MS &&
				subLatency > tokenLatency;
			if (!degraded) return billingA === "subscription" ? -1 : 1;
			return billingA === "per-token" ? -1 : 1;
		}

		if (latencyA !== undefined && latencyB !== undefined) {
			if (latencyA !== latencyB) return latencyA - latencyB;
		} else if (latencyA !== undefined) {
			return -1;
		} else if (latencyB !== undefined) {
			return 1;
		}
		const costA = estimatedRequestCost(a);
		const costB = estimatedRequestCost(b);
		if (costA !== undefined && costB !== undefined && costA !== costB) {
			return costA - costB;
		}
		return 0;
	};
}

/**
 * Flat per-request cost estimate used ONLY for ordering: one request of
 * 1M input + 1M output tokens at per-1M-token pricing, i.e. input + output.
 * Any caller-provided token estimate is unavailable at this stage, so the
 * flat estimate keeps the comparison dimensionally consistent.
 */
function estimatedRequestCost(candidate: CandidateInfo): number | undefined {
	const cost = candidate.capabilities?.cost;
	if (!cost) return undefined;
	return cost.input + cost.output;
}
