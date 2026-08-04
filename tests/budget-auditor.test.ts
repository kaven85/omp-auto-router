import { describe, expect, test } from "bun:test";
import { auditBudget } from "../src/core/budget-auditor";
import type { ProviderUsageStats, UviResult } from "../src/core/types";

function stats(cost: number): ProviderUsageStats {
	return { inputTokens: 0, outputTokens: 0, cost, updatedAt: 0 };
}

function uvi(partial: Partial<UviResult> & Pick<UviResult, "status">): UviResult {
	return { provider: "anthropic", uvi: 1, ...partial };
}

describe("auditBudget without limits", () => {
	test("no limit and no UVI → ok with usedFraction 0", () => {
		const audit = auditBudget("anthropic", {}, undefined);
		expect(audit).toEqual({ status: "ok", provider: "anthropic", usedFraction: 0 });
	});

	test("UVI overlay still applies without a limit", () => {
		const critical = auditBudget("anthropic", {}, undefined, uvi({ status: "critical", uvi: 3.5, windowId: "5h" }));
		expect(critical.status).toBe("blocked");
		expect(critical.usedFraction).toBe(0);
		expect(critical.reason).toContain("3.50");
		expect(critical.reason).toContain("5h");

		const stressed = auditBudget("anthropic", {}, undefined, uvi({ status: "stressed", uvi: 1.7 }));
		expect(stressed.status).toBe("ok");
		expect(stressed.reason).toContain("stressed");
	});
});

describe("auditBudget with a USD limit", () => {
	test("daily limit uses the daily bucket; monthly limit the monthly bucket", () => {
		const usage = { daily: stats(9), monthly: stats(90) };
		const daily = auditBudget("anthropic", usage, { amount: 10 });
		expect(daily.usedFraction).toBeCloseTo(0.9, 10);
		const monthly = auditBudget("anthropic", usage, { amount: 100, monthly: true });
		expect(monthly.usedFraction).toBeCloseTo(0.9, 10);
		expect(monthly.remaining).toBeCloseTo(10, 10);
	});

	test("exact 80% threshold warns, just below stays ok", () => {
		const at = auditBudget("anthropic", { daily: stats(8) }, { amount: 10 });
		expect(at.status).toBe("warning");
		expect(at.usedFraction).toBeCloseTo(0.8, 10);
		expect(at.remaining).toBeCloseTo(2, 10);
		expect(at.reason).toContain("80.0%");

		const below = auditBudget("anthropic", { daily: stats(7.99) }, { amount: 10 });
		expect(below.status).toBe("ok");
		expect(below.reason).toBeUndefined();
	});

	test("exact 100% threshold blocks, overage clamps remaining at 0", () => {
		const at = auditBudget("anthropic", { daily: stats(10) }, { amount: 10 });
		expect(at.status).toBe("blocked");
		expect(at.usedFraction).toBeCloseTo(1.0, 10);

		const over = auditBudget("anthropic", { daily: stats(12.5) }, { amount: 10 });
		expect(over.status).toBe("blocked");
		expect(over.usedFraction).toBeCloseTo(1.25, 10);
		expect(over.remaining).toBe(0);
		expect(over.reason).toContain("$12.50");
	});

	test("missing bucket counts as zero spend", () => {
		const audit = auditBudget("anthropic", { monthly: stats(50) }, { amount: 10 });
		expect(audit.status).toBe("ok");
		expect(audit.usedFraction).toBe(0);
		expect(audit.remaining).toBe(10);
	});

	test("zero-amount limit blocks on any spend", () => {
		const audit = auditBudget("anthropic", { daily: stats(0.01) }, { amount: 0 });
		expect(audit.status).toBe("blocked");
		expect(audit.remaining).toBe(0);
		const idle = auditBudget("anthropic", {}, { amount: 0 });
		expect(idle.status).toBe("ok");
	});

	test("audit echoes the applied limit", () => {
		const limit = { amount: 10, monthly: true };
		expect(auditBudget("anthropic", {}, limit).limit).toEqual(limit);
	});
});

describe("UVI overlay", () => {
	test("critical UVI blocks despite a healthy USD budget", () => {
		const audit = auditBudget(
			"anthropic",
			{ daily: stats(1) },
			{ amount: 100 }, // 1% used — perfectly healthy
			uvi({ status: "critical", uvi: 2.4, windowId: "5h" }),
		);
		expect(audit.status).toBe("blocked");
		expect(audit.usedFraction).toBeCloseTo(0.01, 10); // USD fraction unchanged
		expect(audit.reason).toContain("UVI 2.40");
		expect(audit.reason).toContain("5h");
	});

	test("stressed UVI keeps status but annotates the reason", () => {
		const okAudit = auditBudget(
			"anthropic",
			{ daily: stats(1) },
			{ amount: 100 },
			uvi({ status: "stressed", uvi: 1.7, windowId: "7d" }),
		);
		expect(okAudit.status).toBe("ok");
		expect(okAudit.reason).toContain("UVI 1.70");
		expect(okAudit.reason).toContain("stressed");

		const warnAudit = auditBudget(
			"anthropic",
			{ daily: stats(9) },
			{ amount: 10 },
			uvi({ status: "stressed", uvi: 1.7 }),
		);
		expect(warnAudit.status).toBe("warning"); // not escalated
		expect(warnAudit.reason).toContain("90.0%"); // budget reason kept
		expect(warnAudit.reason).toContain("stressed"); // UVI note appended
	});

	test("ok/surplus/unknown UVI does not change the audit", () => {
		for (const status of ["ok", "surplus", "unknown"] as const) {
			const audit = auditBudget("anthropic", { daily: stats(1) }, { amount: 100 }, uvi({ status, uvi: 0.3 }));
			expect(audit.status).toBe("ok");
			expect(audit.reason).toBeUndefined();
		}
	});
});
