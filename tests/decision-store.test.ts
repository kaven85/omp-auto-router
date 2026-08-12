import { describe, expect, test } from "bun:test";

import { DecisionStore } from "../src/core/decision-store";
import type { RoutingDecision } from "../src/core/types";

/** Minimal valid RoutingDecision fixture; `decidedAt` identifies instances. */
function makeDecision(decidedAt: number, profile = "default"): RoutingDecision {
	return {
		profile,
		tier: "standard",
		confidence: 0.9,
		target: { provider: "anthropic", model: "claude" },
		orderedCandidates: [{ provider: "anthropic", model: "claude" }],
		reasoning: ["test fixture"],
		estimatedTokens: 100,
		hints: {
			complexity: {
				tier: "standard",
				confidence: 0.9,
				signals: {
					estimatedTokens: 100,
					codeSignals: [],
					repairDebug: false,
					implementation: false,
					mixedPhase: false,
					multiStep: false,
					mechanicalOp: false,
					shortQa: false,
					stickyEscalation: false,
					hasImages: false,
				},
				reasons: [],
			},
			rulesTrace: [],
			budget: {},
			uvi: {},
		},
		decidedAt,
	};
}

describe("DecisionStore", () => {
	test("last() is undefined on an empty store", () => {
		expect(new DecisionStore().last()).toBeUndefined();
		expect(new DecisionStore().list()).toEqual([]);
	});

	test("record + last + list (newest first)", () => {
		const store = new DecisionStore();
		store.record(makeDecision(1));
		store.record(makeDecision(2));
		store.record(makeDecision(3));
		expect(store.last()?.decidedAt).toBe(3);
		expect(store.list().map((d) => d.decidedAt)).toEqual([3, 2, 1]);
	});

	test("capacity evicts the oldest decisions", () => {
		const store = new DecisionStore(3);
		for (const at of [1, 2, 3, 4, 5]) store.record(makeDecision(at));
		expect(store.list().map((d) => d.decidedAt)).toEqual([5, 4, 3]);
		expect(store.last()?.decidedAt).toBe(5);
	});

	test("restore rebuilds from recorded order and trims to capacity", () => {
		const store = new DecisionStore(3);
		store.restore([1, 2, 3, 4, 5].map((at) => makeDecision(at)));
		expect(store.list().map((d) => d.decidedAt)).toEqual([5, 4, 3]);
		expect(store.last()?.decidedAt).toBe(5);
	});

	test("restore replaces prior contents", () => {
		const store = new DecisionStore();
		store.record(makeDecision(99));
		store.restore([makeDecision(1), makeDecision(2)]);
		expect(store.list().map((d) => d.decidedAt)).toEqual([2, 1]);
	});

	test("clear empties the store", () => {
		const store = new DecisionStore();
		store.record(makeDecision(1));
		store.clear();
		expect(store.last()).toBeUndefined();
		expect(store.list()).toEqual([]);
	});

	test("non-positive or non-integer capacity is a programmer error", () => {
		for (const bad of [0, -1, 2.5, Number.NaN]) {
			expect(() => new DecisionStore(bad)).toThrow(RangeError);
		}
	});
});
