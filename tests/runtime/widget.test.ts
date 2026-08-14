import { describe, expect, test } from "bun:test";

import { BudgetTracker } from "../../src/core/budget-tracker";
import { CircuitBreaker } from "../../src/core/circuit-breaker";
import { DecisionStore } from "../../src/core/decision-store";
import { EventLog } from "../../src/core/event-log";
import { FeedbackTracker } from "../../src/core/feedback-tracker";
import { LatencyTracker } from "../../src/core/latency-tracker";
import { ProfileRegistry } from "../../src/core/profile-registry";
import type { RouterConfig, RoutingDecision } from "../../src/core/types";
import type { RouterRuntimeState } from "../../src/runtime/router-runtime";
import { buildWidgetLines, renderRouterWidget } from "../../src/runtime/widget";

const CONFIG: RouterConfig = {
	active: "default",
	profiles: {
		default: {
			tiers: { standard: { targets: [{ provider: "deepseek", model: "flash", billing: "per-token" }] } },
			budgets: { deepseek: { amount: 5, monthly: true } },
		},
	},
};

function createState(withProfileBudgets = true): RouterRuntimeState {
	const budgets = new BudgetTracker({ load: () => undefined, save: () => {} }, { load: () => undefined, save: () => {} });
	if (withProfileBudgets) budgets.mergeProfileLimits({ deepseek: { amount: 5, monthly: true } });
	return {
		registry: new ProfileRegistry(CONFIG),
		circuit: new CircuitBreaker(),
		latency: new LatencyTracker(),
		budgets,
		decisions: new DecisionStore(),
		eventLog: new EventLog("/dev/null"),
		cooldowns: new Map(),
		ratings: new FeedbackTracker({ load: () => undefined, save: () => {} }),
		sessionUsage: { calls: new Map(), cost: new Map(), thinking: new Map() },
		quotaCache: { at: 0, data: [] },
		balanceCache: {},
		uviEnabled: true,
	};
}

function decisionFixture(): RoutingDecision {
	return {
		profile: "default",
		tier: "standard",
		confidence: 0.9,
		target: { provider: "deepseek", model: "flash", billing: "per-token" },
		orderedCandidates: [{ provider: "deepseek", model: "flash" }],
		estimatedTokens: 42,
		reasoning: [],
		thinking: "low",
		hints: {
			rulesTrace: [],
			budget: {},
			uvi: {},
			complexity: {
				tier: "standard",
				confidence: 0.9,
				reasons: [],
				signals: { estimatedTokens: 42, codeSignals: [], repairDebug: false, implementation: false, mixedPhase: false, multiStep: false, mechanicalOp: false, shortQa: false, stickyEscalation: false, hasImages: false },
			},
		},
		decidedAt: Date.now(),
	};
}

describe("shared widget", () => {
	test("renders decision, billing, thinking, budgets and observed latency", () => {
		const state = createState();
		state.latency.record("deepseek/flash", 1_500);
		const lines = buildWidgetLines(state, decisionFixture());
		expect(lines[0]).toBe("default | tier=standard | deepseek/flash (per-token) | low | first output=1.5s");
		expect(lines.some((line) => line.startsWith("budgets: deepseek $0.00/$5/mo (0%)"))).toBe(true);
	});

	test("shows open circuits and treats expired UVI windows as freshly reset", () => {
		const state = createState();
		for (let index = 0; index < 3; index++) state.circuit.recordFailure("deepseek/flash", Date.now());
		state.quotaCache = {
			at: Date.now(),
			data: [
				{ provider: "deepseek", fetchedAt: Date.now(), windows: [{ id: "weekly", usedFraction: 0.9, resetsAt: Date.now() - 1_000 }] },
			],
		};
		const lines = buildWidgetLines(state, decisionFixture());
		expect(lines.some((line) => line.startsWith("circuit open: deepseek/flash (3x)"))).toBe(true);
		expect(lines.some((line) => line === "uvi: deepseek 100% left")).toBe(true);
	});

	test("renders prepaid balance without any quota snapshot (Pi degradation path)", () => {
		const state = createState();
		state.balanceCache = { deepseek: { currency: "USD", total: "3.21" } };
		const lines = buildWidgetLines(state, decisionFixture());
		expect(lines.some((line) => line === "balance: deepseek 3.21 USD")).toBe(true);
		expect(lines.some((line) => line.startsWith("uvi:"))).toBe(false);
	});

	test("suppresses identical re-renders per runtime instance only", () => {
		const first = createState();
		const second = createState();
		const firstRenders: string[][] = [];
		const secondRenders: string[][] = [];
		const decision = decisionFixture();

		renderRouterWidget(first, (lines) => firstRenders.push(lines), decision);
		renderRouterWidget(first, (lines) => firstRenders.push(lines), decision);
		expect(firstRenders).toHaveLength(1);

		// A new runtime/session instance must not be suppressed by the first.
		renderRouterWidget(second, (lines) => secondRenders.push(lines), decision);
		expect(secondRenders).toHaveLength(1);

		// Changed content re-renders on the same instance.
		first.budgets.record("deepseek", { inputTokens: 1, outputTokens: 1, cost: 0.01 }, new Date());
		renderRouterWidget(first, (lines) => firstRenders.push(lines), decision);
		expect(firstRenders).toHaveLength(2);
	});

	test("never calls the sink with empty output", () => {
		const state = createState(false);
		let calls = 0;
		renderRouterWidget(state, () => calls++);
		expect(calls).toBe(0);
	});
});
