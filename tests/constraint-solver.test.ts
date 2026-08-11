import { describe, expect, test } from "bun:test";

import { CircuitBreaker } from "../src/core/circuit-breaker";
import { solveConstraints } from "../src/core/constraint-solver";
import type { CandidateInfo, ModelCapabilities } from "../src/core/types";

const NOW = 1_700_000_000_000;

function caps(over: Partial<ModelCapabilities> = {}): ModelCapabilities {
	return {
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		...over,
	};
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

function freshCircuit(): CircuitBreaker {
	return new CircuitBreaker();
}

describe("solveConstraints health / cooldown / circuit gates", () => {
	test("healthy candidate with no gates passes", () => {
		const c = candidate("p", "m");
		const { eligible, excluded } = solveConstraints([c], {}, { circuit: freshCircuit(), nowMs: NOW });
		expect(eligible).toEqual([c]);
		expect(excluded).toEqual([]);
	});

	test("unhealthy candidate is excluded with a reason", () => {
		const c = candidate("p", "m", { healthy: false });
		const { eligible, excluded } = solveConstraints([c], {}, { circuit: freshCircuit(), nowMs: NOW });
		expect(eligible).toEqual([]);
		expect(excluded).toHaveLength(1);
		expect(excluded[0]?.reason).toContain("unhealthy");
		expect(excluded[0]?.reason).toContain("p/m");
	});

	test("cooldownUntil in the future excludes; expired cooldown passes", () => {
		const cooling = candidate("p", "cooling", { cooldownUntil: NOW + 1_000 });
		const warmed = candidate("p", "warmed", { cooldownUntil: NOW });
		const { eligible, excluded } = solveConstraints([cooling, warmed], {}, {
			circuit: freshCircuit(),
			nowMs: NOW,
		});
		expect(eligible).toEqual([warmed]);
		expect(excluded).toHaveLength(1);
		expect(excluded[0]?.reason).toContain("cooling down");
	});

	test("cooldown exclusion carries the failure that caused it", () => {
		const cooling = candidate("p", "cooling", {
			cooldownUntil: NOW + 1_000,
			cooldownReason: "rate limit reached [status 429]",
		});
		const { excluded } = solveConstraints([cooling], {}, { circuit: freshCircuit(), nowMs: NOW });
		expect(excluded[0]?.reason).toContain("cooling down until");
		expect(excluded[0]?.reason).toContain("last failure: rate limit reached [status 429]");
	});

	test("open circuit excludes; half-open and closed pass", () => {
		const circuit = freshCircuit();
		for (let i = 0; i < 3; i++) circuit.recordFailure("p/open", NOW - 10_000);
		for (let i = 0; i < 3; i++) circuit.recordFailure("p/half", NOW - 61_000);
		const open = candidate("p", "open");
		const half = candidate("p", "half");
		const closed = candidate("p", "closed");
		const { eligible, excluded } = solveConstraints([open, half, closed], {}, {
			circuit,
			nowMs: NOW,
		});
		expect(eligible).toEqual([half, closed]);
		expect(excluded).toHaveLength(1);
		expect(excluded[0]?.reason).toContain("circuit breaker open");
	});

	test("hard-UVI providers are excluded", () => {
		const hard = candidate("google", "m");
		const soft = candidate("openai", "m");
		const { eligible, excluded } = solveConstraints([hard, soft], {}, {
			circuit: freshCircuit(),
			nowMs: NOW,
			hardUviProviders: new Set(["google"]),
		});
		expect(eligible).toEqual([soft]);
		expect(excluded).toHaveLength(1);
		expect(excluded[0]?.reason).toContain("critical UVI");
	});
});

describe("solveConstraints capability gates", () => {
	test("reasoning requirement excludes non-reasoning models", () => {
		const no = candidate("p", "plain", { capabilities: caps({ reasoning: false }) });
		const yes = candidate("p", "thinker", { capabilities: caps({ reasoning: true }) });
		const { eligible, excluded } = solveConstraints([no, yes], { reasoning: true }, {
			circuit: freshCircuit(),
			nowMs: NOW,
		});
		expect(eligible).toEqual([yes]);
		expect(excluded[0]?.reason).toContain("reasoning");
	});

	test("vision requirement excludes text-only models", () => {
		const text = candidate("p", "text", { capabilities: caps({ input: ["text"] }) });
		const vision = candidate("p", "vision", { capabilities: caps({ input: ["text", "image"] }) });
		const { eligible, excluded } = solveConstraints([text, vision], { vision: true }, {
			circuit: freshCircuit(),
			nowMs: NOW,
		});
		expect(eligible).toEqual([vision]);
		expect(excluded[0]?.reason).toContain("vision");
	});

	test("minContextWindow excludes models below the requirement", () => {
		const small = candidate("p", "small", { capabilities: caps({ contextWindow: 32_000 }) });
		const exact = candidate("p", "exact", { capabilities: caps({ contextWindow: 128_000 }) });
		const { eligible, excluded } = solveConstraints(
			[small, exact],
			{ minContextWindow: 128_000 },
			{ circuit: freshCircuit(), nowMs: NOW },
		);
		expect(eligible).toEqual([exact]);
		expect(excluded[0]?.reason).toContain("context window");
	});

	test("undefined capabilities stay eligible despite requirements", () => {
		const unknown = candidate("p", "unknown");
		const { eligible, excluded } = solveConstraints(
			[unknown],
			{ reasoning: true, vision: true, minContextWindow: 1_000_000 },
			{ circuit: freshCircuit(), nowMs: NOW },
		);
		expect(eligible).toEqual([unknown]);
		expect(excluded).toEqual([]);
	});

	test("absent requirements never capability-gate", () => {
		const plain = candidate("p", "plain", { capabilities: caps() });
		const { eligible } = solveConstraints([plain], {}, { circuit: freshCircuit(), nowMs: NOW });
		expect(eligible).toEqual([plain]);
	});
});

describe("solveConstraints ordering", () => {
	test("input order is preserved in both output lists", () => {
		const a = candidate("p", "a", { healthy: false });
		const b = candidate("p", "b");
		const c = candidate("p", "c", { healthy: false });
		const d = candidate("p", "d");
		const { eligible, excluded } = solveConstraints([a, b, c, d], {}, {
			circuit: freshCircuit(),
			nowMs: NOW,
		});
		expect(eligible.map((x) => x.key)).toEqual(["p/b", "p/d"]);
		expect(excluded.map((x) => x.candidate.key)).toEqual(["p/a", "p/c"]);
	});
});
