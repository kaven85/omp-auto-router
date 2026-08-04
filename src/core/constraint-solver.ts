/**
 * Constraint solver — first pipeline gate.
 *
 * Filters enriched candidates down to those eligible for partitioning, with a
 * human-readable reason for every exclusion. A candidate is excluded when:
 *  - the host reports it unhealthy (auth/health check failed);
 *  - it is still cooling down (`cooldownUntil > nowMs`);
 *  - its circuit breaker is open (half-open stays eligible);
 *  - its provider is in `hardUviProviders` (critical-UVI hard mode);
 *  - its *resolved* capabilities miss a requirement (reasoning / vision /
 *    minContextWindow). Candidates with undefined capabilities are never
 *    capability-gated: they pass through so the failover chain keeps moving.
 *
 * Pure function over injected state; candidate order is preserved in both
 * output lists.
 */

import type { CandidateInfo, CapabilityRequirement } from "./types";
import type { CircuitBreaker } from "./circuit-breaker";

/** Inputs for {@link solveConstraints}. */
export interface ConstraintSolverOptions {
	/** Circuit breaker consulted per candidate key. */
	circuit: CircuitBreaker;
	/** Epoch ms basis for cooldown and circuit evaluation. */
	nowMs: number;
	/** Providers excluded outright (critical UVI under hard mode). */
	hardUviProviders?: Set<string>;
}

/** A candidate dropped by the solver, with a human-readable reason. */
export interface ExcludedCandidate {
	candidate: CandidateInfo;
	reason: string;
}

/** Result of {@link solveConstraints}. */
export interface ConstraintSolveResult {
	/** Candidates passing every gate, in input order. */
	eligible: CandidateInfo[];
	/** Candidates dropped by the first failing gate, in input order. */
	excluded: ExcludedCandidate[];
}

/**
 * Partition `candidates` into eligible and excluded according to health,
 * cooldown, circuit state, hard-UVI providers, and capability requirements.
 */
export function solveConstraints(
	candidates: CandidateInfo[],
	requirement: CapabilityRequirement,
	opts: ConstraintSolverOptions,
): ConstraintSolveResult {
	const eligible: CandidateInfo[] = [];
	const excluded: ExcludedCandidate[] = [];
	for (const candidate of candidates) {
		const reason = exclusionReason(candidate, requirement, opts);
		if (reason === undefined) eligible.push(candidate);
		else excluded.push({ candidate, reason });
	}
	return { eligible, excluded };
}

/** First failing gate's reason, or undefined when the candidate is eligible. */
function exclusionReason(
	candidate: CandidateInfo,
	requirement: CapabilityRequirement,
	opts: ConstraintSolverOptions,
): string | undefined {
	const key = candidate.key;
	if (!candidate.healthy) {
		return `${key}: unhealthy (host auth/health check failed)`;
	}
	if (candidate.cooldownUntil !== undefined && candidate.cooldownUntil > opts.nowMs) {
		return `${key}: cooling down until ${new Date(candidate.cooldownUntil).toISOString()}`;
	}
	if (opts.circuit.state(key, opts.nowMs) === "open") {
		return `${key}: circuit breaker open`;
	}
	if (opts.hardUviProviders?.has(candidate.target.provider)) {
		return `${key}: provider ${candidate.target.provider} has critical UVI (hard mode)`;
	}
	// Capability gates apply ONLY to resolved capabilities; unresolved
	// candidates stay eligible so the failover chain keeps moving.
	const caps = candidate.capabilities;
	if (caps) {
		if (requirement.reasoning === true && caps.reasoning !== true) {
			return `${key}: missing required reasoning capability`;
		}
		if (requirement.vision === true && !caps.input.includes("image")) {
			return `${key}: missing required vision (image input) capability`;
		}
		if (
			requirement.minContextWindow !== undefined &&
			caps.contextWindow < requirement.minContextWindow
		) {
			return `${key}: context window ${caps.contextWindow} below required ${requirement.minContextWindow}`;
		}
	}
	return undefined;
}
