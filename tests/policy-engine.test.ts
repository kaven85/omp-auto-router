import { describe, expect, test } from "bun:test";

import { PolicyEngine } from "../src/core/policy-engine";
import type { PolicyRuleConfig } from "../src/core/types";

/** Local time: 2023-11-15 was a Wednesday (getDay() === 3). */
function at(hour: number, minute = 0): Date {
	return new Date(2023, 10, 15, hour, minute, 0);
}

describe("PolicyEngine preConstraint conditions", () => {
	test("rule without when/profiles always applies", () => {
		const engine = new PolicyEngine([{ type: "force-tier", tier: "complex" }]);
		const out = engine.preConstraint({ profile: "default", now: at(3) });
		expect(out.tierOverride).toBe("complex");
		expect(out.trace).toHaveLength(1);
	});

	test("profiles scoping restricts applicability", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-tier", tier: "complex", profiles: ["work"] },
		];
		const engine = new PolicyEngine(rules);
		expect(engine.preConstraint({ profile: "work", now: at(12) }).tierOverride).toBe("complex");
		expect(
			engine.preConstraint({ profile: "personal", now: at(12) }).tierOverride,
		).toBeUndefined();
	});

	test("hour window [9,17) matches inside, not outside or at the end", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-tier", tier: "simple", when: { hourStart: 9, hourEnd: 17 } },
		];
		const engine = new PolicyEngine(rules);
		expect(engine.preConstraint({ profile: "p", now: at(9) }).tierOverride).toBe("simple");
		expect(engine.preConstraint({ profile: "p", now: at(16, 59) }).tierOverride).toBe("simple");
		expect(engine.preConstraint({ profile: "p", now: at(17) }).tierOverride).toBeUndefined();
		expect(engine.preConstraint({ profile: "p", now: at(8) }).tierOverride).toBeUndefined();
	});

	test("midnight-wrapping window [22,6) matches late night and early morning", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-tier", tier: "trivial", when: { hourStart: 22, hourEnd: 6 } },
		];
		const engine = new PolicyEngine(rules);
		expect(engine.preConstraint({ profile: "p", now: at(22) }).tierOverride).toBe("trivial");
		expect(engine.preConstraint({ profile: "p", now: at(23, 59) }).tierOverride).toBe("trivial");
		expect(engine.preConstraint({ profile: "p", now: at(0) }).tierOverride).toBe("trivial");
		expect(engine.preConstraint({ profile: "p", now: at(5, 59) }).tierOverride).toBe("trivial");
		expect(engine.preConstraint({ profile: "p", now: at(6) }).tierOverride).toBeUndefined();
		expect(engine.preConstraint({ profile: "p", now: at(12) }).tierOverride).toBeUndefined();
		expect(engine.preConstraint({ profile: "p", now: at(21) }).tierOverride).toBeUndefined();
	});

	test("weekdays restrict the rule to listed days", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-tier", tier: "complex", when: { weekdays: [3] } }, // Wednesday
		];
		const engine = new PolicyEngine(rules);
		expect(engine.preConstraint({ profile: "p", now: at(12) }).tierOverride).toBe("complex");
		// 2023-11-16 is a Thursday.
		expect(
			engine.preConstraint({ profile: "p", now: new Date(2023, 10, 16, 12) }).tierOverride,
		).toBeUndefined();
	});

	test("hour window and weekdays are AND-ed", () => {
		const rules: PolicyRuleConfig[] = [
			{
				type: "force-tier",
				tier: "complex",
				when: { weekdays: [3], hourStart: 9, hourEnd: 17 },
			},
		];
		const engine = new PolicyEngine(rules);
		expect(engine.preConstraint({ profile: "p", now: at(10) }).tierOverride).toBe("complex");
		expect(engine.preConstraint({ profile: "p", now: at(20) }).tierOverride).toBeUndefined();
	});
});

describe("PolicyEngine preConstraint priority and effects", () => {
	test("higher priority force-tier wins regardless of config order", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-tier", tier: "simple", priority: 1 },
			{ type: "force-tier", tier: "complex", priority: 10 },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect(out.tierOverride).toBe("complex");
		expect(out.trace[0]).toContain("force-tier:complex");
		expect(out.trace[1]).toContain("ignored");
	});

	test("equal priority falls back to config order (first wins)", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-tier", tier: "simple" },
			{ type: "force-tier", tier: "complex" },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect(out.tierOverride).toBe("simple");
	});

	test("excluded providers accumulate across rules", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "exclude-provider", providers: ["google"], priority: 5 },
			{ type: "exclude-provider", providers: ["openai", "google"], priority: 1 },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect([...out.excludedProviders].sort()).toEqual(["google", "openai"]);
		expect(out.trace).toHaveLength(2);
	});

	test("preferred providers accumulate in application order, deduped", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "prefer-provider", providers: ["anthropic"], priority: 9 },
			{ type: "prefer-provider", providers: ["openai", "anthropic"], priority: 1 },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect(out.preferredProviders).toEqual(["anthropic", "openai"]);
	});

	test("force-billing is first-wins by priority", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-billing", billing: "subscription", priority: 1 },
			{ type: "force-billing", billing: "per-token", priority: 2 },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect(out.billingForce).toBe("per-token");
	});

	test("force-constraint merges: booleans OR-ed, window max-ed", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-constraint", constraint: { reasoning: true, minContextWindow: 100_000 } },
			{ type: "force-constraint", constraint: { vision: true, minContextWindow: 200_000 } },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect(out.extraConstraint).toEqual({
			reasoning: true,
			vision: true,
			minContextWindow: 200_000,
		});
	});

	test("rules with missing payloads are skipped without trace", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "force-tier" },
			{ type: "prefer-provider" },
			{ type: "force-billing" },
			{ type: "force-constraint" },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect(out.trace).toEqual([]);
		expect(out.tierOverride).toBeUndefined();
	});

	test("inapplicable rules produce no effects and no trace", () => {
		const rules: PolicyRuleConfig[] = [
			{ type: "exclude-provider", providers: ["google"], profiles: ["other"] },
			{ type: "prefer-provider", providers: ["openai"], when: { hourStart: 1, hourEnd: 2 } },
		];
		const out = new PolicyEngine(rules).preConstraint({ profile: "p", now: at(12) });
		expect(out.excludedProviders.size).toBe(0);
		expect(out.preferredProviders).toEqual([]);
		expect(out.trace).toEqual([]);
	});
});

describe("PolicyEngine postPartition", () => {
	const chain = [
		{ target: { provider: "google", model: "a" } },
		{ target: { provider: "openai", model: "b" } },
		{ target: { provider: "anthropic", model: "c" } },
		{ target: { provider: "openai", model: "d" } },
	];

	test("preferred providers move up, both groups keep relative order", () => {
		const engine = new PolicyEngine([]);
		const out = engine.postPartition(chain, { preferredProviders: ["openai"] });
		expect(out.map((c) => `${c.target.provider}/${c.target.model}`)).toEqual([
			"openai/b",
			"openai/d",
			"google/a",
			"anthropic/c",
		]);
	});

	test("multiple preferred providers boost together, stably", () => {
		const engine = new PolicyEngine([]);
		const out = engine.postPartition(chain, {
			preferredProviders: ["anthropic", "google"],
		});
		expect(out.map((c) => `${c.target.provider}/${c.target.model}`)).toEqual([
			"google/a",
			"anthropic/c",
			"openai/b",
			"openai/d",
		]);
	});

	test("empty preferences leave the order untouched", () => {
		const engine = new PolicyEngine([]);
		const out = engine.postPartition(chain, { preferredProviders: [] });
		expect(out.map((c) => c.target.model)).toEqual(["a", "b", "c", "d"]);
	});
});
