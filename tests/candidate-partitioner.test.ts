import { describe, expect, test } from "bun:test";

import { partitionCandidates, SUBSCRIPTION_LATENCY_MAX_MS, type PartitionInput } from "../src/core/candidate-partitioner";
import { CircuitBreaker } from "../src/core/circuit-breaker";
import type {
	BudgetAudit,
	CandidateInfo,
	ModelCapabilities,
	UviResult,
	UviStatus,
} from "../src/core/types";

const NOW_MS = 1_700_000_000_000;
const NOW = new Date(NOW_MS);

function caps(over: Partial<ModelCapabilities> = {}): ModelCapabilities {
	return { reasoning: false, input: ["text"], contextWindow: 200_000, ...over };
}

function candidate(
	provider: string,
	model: string,
	over: Partial<CandidateInfo> = {},
): CandidateInfo {
	return {
		target: { provider, model },
		key: `${provider}/${model}`,
		healthy: true,
		...over,
	};
}

function uvi(provider: string, status: UviStatus): UviResult {
	return { provider, uvi: 1, status };
}

function budget(provider: string, status: BudgetAudit["status"]): BudgetAudit {
	return { provider, status, usedFraction: status === "ok" ? 0 : 0.9 };
}

function input(over: Partial<PartitionInput> = {}): PartitionInput {
	return {
		uvi: {},
		budget: {},
		latency: {},
		circuit: new CircuitBreaker(),
		nowMs: NOW_MS,
		now: NOW,
		...over,
	};
}

function keys(list: CandidateInfo[]): string[] {
	return list.map((c) => c.key);
}

describe("partitionCandidates bucketing", () => {
	test("surplus promotes, stressed demotes, warning demotes, rest normal", () => {
		const promoted = candidate("surplus", "m");
		const stressed = candidate("stressed", "m");
		const warning = candidate("warning", "m");
		const plain = candidate("plain", "m");
		const unknown = candidate("unknown", "m");
		const { buckets, ordered } = partitionCandidates(
			[promoted, stressed, warning, plain, unknown],
			input({
				uvi: {
					surplus: uvi("surplus", "surplus"),
					stressed: uvi("stressed", "stressed"),
				},
				budget: { warning: budget("warning", "warning") },
			}),
		);
		expect(keys(buckets.promoted)).toEqual(["surplus/m"]);
		expect(keys(buckets.normal)).toEqual(["plain/m", "unknown/m"]);
		expect(keys(buckets.demoted)).toEqual(["stressed/m", "warning/m"]);
		expect(keys(ordered)).toEqual([
			"surplus/m",
			"plain/m",
			"unknown/m",
			"stressed/m",
			"warning/m",
		]);
	});

	test("blocked budget and critical UVI are excluded from the result entirely", () => {
		const blocked = candidate("blocked", "m");
		const critical = candidate("critical", "m");
		const fine = candidate("fine", "m");
		const { ordered, buckets } = partitionCandidates(
			[blocked, critical, fine],
			input({
				uvi: { critical: uvi("critical", "critical") },
				budget: { blocked: budget("blocked", "blocked") },
			}),
		);
		expect(keys(ordered)).toEqual(["fine/m"]);
		expect(keys(buckets.promoted)).toEqual([]);
		expect(keys(buckets.demoted)).toEqual([]);
	});

	test("half-open circuit demotes; open circuit excludes", () => {
		const circuit = new CircuitBreaker();
		for (let i = 0; i < 3; i++) circuit.recordFailure("open/m", NOW_MS - 10_000);
		for (let i = 0; i < 3; i++) circuit.recordFailure("half/m", NOW_MS - 61_000);
		const open = candidate("open", "m");
		const half = candidate("half", "m");
		const fine = candidate("fine", "m");
		const { ordered, buckets } = partitionCandidates([open, half, fine], input({ circuit }));
		expect(keys(ordered)).toEqual(["fine/m", "half/m"]);
		expect(keys(buckets.normal)).toEqual(["fine/m"]);
		expect(keys(buckets.demoted)).toEqual(["half/m"]);
	});
});

describe("partitionCandidates hard mode", () => {
	test("stressed providers are excluded entirely under hard mode", () => {
		const stressed = candidate("stressed", "m");
		const fine = candidate("fine", "m");
		const { ordered } = partitionCandidates(
			[stressed, fine],
			input({ hardMode: true, uvi: { stressed: uvi("stressed", "stressed") } }),
		);
		expect(keys(ordered)).toEqual(["fine/m"]);
	});

	test("without hard mode stressed providers are only demoted", () => {
		const stressed = candidate("stressed", "m");
		const fine = candidate("fine", "m");
		const { ordered, buckets } = partitionCandidates(
			[stressed, fine],
			input({ uvi: { stressed: uvi("stressed", "stressed") } }),
		);
		expect(keys(ordered)).toEqual(["fine/m", "stressed/m"]);
		expect(keys(buckets.demoted)).toEqual(["stressed/m"]);
	});
});

describe("partitionCandidates all-excluded fallback", () => {
	test("when every candidate is excluded, all are treated as normal", () => {
		const a = candidate("a", "m");
		const b = candidate("b", "m");
		const { ordered, buckets } = partitionCandidates(
			[a, b],
			input({
				uvi: { a: uvi("a", "critical"), b: uvi("b", "critical") },
			}),
		);
		expect(keys(ordered)).toEqual(["a/m", "b/m"]);
		expect(keys(buckets.normal)).toEqual(["a/m", "b/m"]);
		expect(keys(buckets.promoted)).toEqual([]);
		expect(keys(buckets.demoted)).toEqual([]);
	});

	test("fallback also applies under hard mode when all are stressed", () => {
		const a = candidate("a", "m");
		const b = candidate("b", "m");
		const { ordered } = partitionCandidates(
			[a, b],
			input({
				hardMode: true,
				uvi: { a: uvi("a", "stressed"), b: uvi("b", "stressed") },
			}),
		);
		expect(keys(ordered)).toEqual(["a/m", "b/m"]);
	});

	test("empty candidate list stays empty", () => {
		const { ordered, buckets } = partitionCandidates([], input());
		expect(ordered).toEqual([]);
		expect(keys(buckets.normal)).toEqual([]);
	});
});

describe("partitionCandidates ordering within buckets", () => {
	test("latency ascending, no-history candidates last", () => {
		const slow = candidate("slow", "m");
		const fast = candidate("fast", "m");
		const noHistory = candidate("none", "m");
		const { ordered } = partitionCandidates(
			[noHistory, slow, fast],
			input({ latency: { "slow/m": 900, "fast/m": 100 } }),
		);
		expect(keys(ordered)).toEqual(["fast/m", "slow/m", "none/m"]);
	});

	test("cost breaks ties when latency is unknown and both expose cost", () => {
		const pricey = candidate("pricey", "m", {
			capabilities: caps({ cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 1 } }),
		});
		const cheap = candidate("cheap", "m", {
			capabilities: caps({ cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } }),
		});
		const { ordered } = partitionCandidates([pricey, cheap], input());
		expect(keys(ordered)).toEqual(["cheap/m", "pricey/m"]);
	});

	test("cost breaks ties when latency is equal", () => {
		const pricey = candidate("pricey", "m", {
			capabilities: caps({ cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 1 } }),
		});
		const cheap = candidate("cheap", "m", {
			capabilities: caps({ cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } }),
		});
		const { ordered } = partitionCandidates(
			[pricey, cheap],
			input({ latency: { "pricey/m": 500, "cheap/m": 500 } }),
		);
		expect(keys(ordered)).toEqual(["cheap/m", "pricey/m"]);
	});

	test("latency dominates cost when latencies differ", () => {
		const fastPricey = candidate("fast", "m", {
			capabilities: caps({ cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 1 } }),
		});
		const slowCheap = candidate("slow", "m", {
			capabilities: caps({ cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } }),
		});
		const { ordered } = partitionCandidates(
			[slowCheap, fastPricey],
			input({ latency: { "fast/m": 100, "slow/m": 900 } }),
		);
		expect(keys(ordered)).toEqual(["fast/m", "slow/m"]);
	});

	test("sort is stable when no latency and cost cannot compare", () => {
		const noCostA = candidate("a", "m"); // no capabilities at all
		const pricedOnly = candidate("b", "m", {
			capabilities: caps({ cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } }),
		});
		const noCostC = candidate("c", "m", { capabilities: caps() });
		const { ordered } = partitionCandidates([noCostA, pricedOnly, noCostC], input());
		// One-sided cost must not reorder: input order preserved.
		expect(keys(ordered)).toEqual(["a/m", "b/m", "c/m"]);
	});

	test("ordering applies within each bucket independently", () => {
		const promotedSlow = candidate("surplus", "slow");
		const promotedFast = candidate("surplus", "fast");
		const demotedFast = candidate("stressed", "fast");
		const { ordered, buckets } = partitionCandidates(
			[promotedSlow, demotedFast, promotedFast],
			input({
				uvi: {
					surplus: uvi("surplus", "surplus"),
					stressed: uvi("stressed", "stressed"),
				},
				latency: {
					"surplus/slow": 900,
					"surplus/fast": 100,
					"stressed/fast": 50,
				},
			}),
		);
		expect(keys(buckets.promoted)).toEqual(["surplus/fast", "surplus/slow"]);
		// Bucket precedence beats raw latency: promoted slow still outranks demoted fast.
		expect(keys(ordered)).toEqual(["surplus/fast", "surplus/slow", "stressed/fast"]);
	});
});

describe("partitionCandidates billing preference", () => {
	const perToken = (provider: string, model = "m") =>
		candidate(provider, model, { target: { provider, model, billing: "per-token" } });

	test("subscription without history outranks per-token with history", () => {
		// The reported case: subscription candidate has never served a request,
		// per-token candidate has a latency sample. No evidence of degradation
		// → subscription (default billing) keeps priority.
		const sub = candidate("sub", "m");
		const metered = perToken("metered");
		const { ordered } = partitionCandidates(
			[metered, sub],
			input({ latency: { "metered/m": 100 } }),
		);
		expect(keys(ordered)).toEqual(["sub/m", "metered/m"]);
	});

	test("subscription keeps priority even when many times slower than per-token", () => {
		// Real-world case: subscription frontier model averaging 22.8s total
		// stream time vs metered flash model at 1.7s. Relative speed is
		// ignored — total duration confounds model speed with response length.
		const sub = candidate("sub", "m");
		const metered = perToken("metered");
		const { ordered } = partitionCandidates(
			[metered, sub],
			input({ latency: { "sub/m": 22_787, "metered/m": 1_675 } }),
		);
		expect(keys(ordered)).toEqual(["sub/m", "metered/m"]);
	});

	test("per-token jumps ahead only when subscription latency crosses the usability bar", () => {
		const sub = candidate("sub", "m");
		const metered = perToken("metered");
		const { ordered } = partitionCandidates(
			[sub, metered],
			input({ latency: { "sub/m": SUBSCRIPTION_LATENCY_MAX_MS + 1_000, "metered/m": 1_000 } }),
		);
		expect(keys(ordered)).toEqual(["metered/m", "sub/m"]);
	});

	test("subscription past the bar still beats a per-token candidate that is even slower", () => {
		const sub = candidate("sub", "m");
		const metered = perToken("metered");
		const { ordered } = partitionCandidates(
			[metered, sub],
			input({
				latency: {
					"sub/m": SUBSCRIPTION_LATENCY_MAX_MS + 1_000,
					"metered/m": SUBSCRIPTION_LATENCY_MAX_MS + 5_000,
				},
			}),
		);
		expect(keys(ordered)).toEqual(["sub/m", "metered/m"]);
	});

	test("same billing group still sorts by latency", () => {
		const slowMetered = perToken("slow");
		const fastMetered = perToken("fast");
		const { ordered } = partitionCandidates(
			[slowMetered, fastMetered],
			input({ latency: { "slow/m": 900, "fast/m": 100 } }),
		);
		expect(keys(ordered)).toEqual(["fast/m", "slow/m"]);
	});
});
