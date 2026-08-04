import { describe, expect, test } from "bun:test";
import type { QuotaSnapshot } from "../src/core/types";
import { classifyMonthlySpendUvi, computeAllUvi, computeUvi } from "../src/core/uvi";

/** Fixed reference instant; all windows are built relative to it. */
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

function snapshot(partial: Partial<QuotaSnapshot> & Pick<QuotaSnapshot, "windows">): QuotaSnapshot {
	return { provider: "anthropic", fetchedAt: NOW, ...partial };
}

describe("computeUvi", () => {
	test("derives elapsed fraction from windowSeconds and resetsAt", () => {
		// 5h window, 2.5h remaining → elapsed 0.5; used 0.8 → UVI 1.6 → stressed.
		const result = computeUvi(
			snapshot({ windows: [{ id: "5h", usedFraction: 0.8, windowSeconds: 18000, resetsAt: NOW + 9000_000 }] }),
			NOW,
		);
		expect(result.status).toBe("stressed");
		expect(result.uvi).toBeCloseTo(1.6, 10);
		expect(result.windowId).toBe("5h");
		expect(result.provider).toBe("anthropic");
	});

	test("window without timing metadata is treated as fully elapsed", () => {
		const result = computeUvi(snapshot({ windows: [{ id: "7d", usedFraction: 1.8 }] }), NOW);
		expect(result.uvi).toBeCloseTo(1.8, 10);
		expect(result.status).toBe("stressed");
	});

	test("classification thresholds are exact", () => {
		// elapsed 0.5 for every case below (windowSeconds 1000, 500s remaining).
		const timed = (usedFraction: number) =>
			snapshot({ windows: [{ id: "w", usedFraction, windowSeconds: 1000, resetsAt: NOW + 500_000 }] });
		expect(computeUvi(timed(1.0), NOW).status).toBe("critical"); // UVI exactly 2.0
		expect(computeUvi(timed(0.999), NOW).status).toBe("stressed"); // UVI 1.998
		expect(computeUvi(timed(0.75), NOW).status).toBe("stressed"); // UVI exactly 1.5
		expect(computeUvi(timed(0.749), NOW).status).toBe("ok"); // UVI 1.498
	});

	test("surplus requires UVI ≤ 0.5 AND elapsed ≥ 70%", () => {
		// 80% elapsed, used 0.3 → UVI 0.375 → surplus.
		const surplus = computeUvi(
			snapshot({ windows: [{ id: "w", usedFraction: 0.3, windowSeconds: 1000, resetsAt: NOW + 200_000 }] }),
			NOW,
		);
		expect(surplus.status).toBe("surplus");
		// 50% elapsed, used 0.2 → UVI 0.4 ≤ 0.5 but window too young → ok.
		const early = computeUvi(
			snapshot({ windows: [{ id: "w", usedFraction: 0.2, windowSeconds: 1000, resetsAt: NOW + 500_000 }] }),
			NOW,
		);
		expect(early.status).toBe("ok");
	});

	test("highest-UVI window drives the classification", () => {
		const result = computeUvi(
			snapshot({
				windows: [
					{ id: "5h", usedFraction: 0.1, windowSeconds: 18000, resetsAt: NOW + 9000_000 }, // UVI 0.2
					{ id: "7d", usedFraction: 1.0, windowSeconds: 604800, resetsAt: NOW + 302400_000 }, // UVI 2.0
					{ id: "monthly", usedFraction: 0.5 }, // UVI 0.5 (untimed)
				],
			}),
			NOW,
		);
		expect(result.windowId).toBe("7d");
		expect(result.status).toBe("critical");
	});

	test("overage (usedFraction > 1) classifies by the same thresholds", () => {
		const result = computeUvi(
			snapshot({ windows: [{ id: "5h", usedFraction: 1.2, windowSeconds: 1000, resetsAt: NOW + 500_000 }] }),
			NOW,
		);
		expect(result.uvi).toBeCloseTo(2.4, 10);
		expect(result.status).toBe("critical");
	});

	test("elapsed fraction is clamped at 0.01 for a window that has not started", () => {
		// resetsAt far beyond windowSeconds → negative raw elapsed → clamped.
		const result = computeUvi(
			snapshot({
				windows: [{ id: "5h", usedFraction: 0.01, windowSeconds: 18000, resetsAt: NOW + 100 * 3600_000 }],
			}),
			NOW,
		);
		expect(result.uvi).toBeCloseTo(1.0, 10); // 0.01 / 0.01
		expect(result.status).toBe("ok");
	});

	test("snapshot with fetch error is unknown with uvi 0", () => {
		const result = computeUvi(
			snapshot({ error: "HTTP 429", windows: [{ id: "5h", usedFraction: 0.99, windowSeconds: 1000, resetsAt: NOW }] }),
			NOW,
		);
		expect(result.status).toBe("unknown");
		expect(result.uvi).toBe(0);
		expect(result.windowId).toBeUndefined();
	});

	test("snapshot without usable windows is unknown with uvi 0", () => {
		expect(computeUvi(snapshot({ windows: [] }), NOW).status).toBe("unknown");
		const onlyNaN = computeUvi(
			snapshot({ windows: [{ id: "w", usedFraction: Number.NaN, windowSeconds: 1000, resetsAt: NOW }] }),
			NOW,
		);
		expect(onlyNaN.status).toBe("unknown");
		expect(onlyNaN.uvi).toBe(0);
	});
});

describe("computeAllUvi", () => {
	test("computes per provider, keyed by provider name", () => {
		const results = computeAllUvi(
			[
				snapshot({ provider: "anthropic", windows: [{ id: "5h", usedFraction: 0.6 }] }),
				snapshot({ provider: "openai", windows: [{ id: "5h", usedFraction: 4 }] }),
				snapshot({ provider: "google", windows: [], error: "boom" }),
			],
			NOW,
		);
		expect(Object.keys(results).sort()).toEqual(["anthropic", "google", "openai"]);
		expect(results.anthropic?.status).toBe("ok");
		expect(results.openai?.status).toBe("critical");
		expect(results.google?.status).toBe("unknown");
	});
});

describe("classifyMonthlySpendUvi", () => {
	test("first day of the month: tiny elapsed fraction inflates UVI", () => {
		// Local midnight on Aug 1 → raw elapsed 0 → clamped to 0.01.
		const result = classifyMonthlySpendUvi(10, 100, new Date(2026, 7, 1, 0, 0, 0));
		expect(result.uvi).toBeCloseTo(10, 10); // 0.1 / 0.01
		expect(result.status).toBe("critical");
	});

	test("last day of the month: elapsed ≈ 1", () => {
		const now = new Date(2026, 7, 31, 12, 0, 0);
		const monthStart = new Date(2026, 7, 1).getTime();
		const monthEnd = new Date(2026, 8, 1).getTime();
		const elapsed = (now.getTime() - monthStart) / (monthEnd - monthStart);
		expect(elapsed).toBeGreaterThan(0.9);

		const result = classifyMonthlySpendUvi(10, 100, now);
		expect(result.uvi).toBeCloseTo(0.1 / elapsed, 10);
		expect(result.status).toBe("surplus"); // low UVI with ≥70% elapsed
	});

	test("mid-month: UVI compares spend pace to month pace", () => {
		// Aug 16 noon → elapsed 15.5/31 = 0.5; half the budget spent → UVI 1.0 → ok.
		const result = classifyMonthlySpendUvi(50, 100, new Date(2026, 7, 16, 12, 0, 0));
		expect(result.uvi).toBeCloseTo(1.0, 10);
		expect(result.status).toBe("ok");
	});

	test("zero budget with spend is critical; zero spend and zero budget is not", () => {
		const overspent = classifyMonthlySpendUvi(0.01, 0, new Date(2026, 7, 16, 12, 0, 0));
		expect(overspent.status).toBe("critical");
		const idle = classifyMonthlySpendUvi(0, 0, new Date(2026, 7, 16, 12, 0, 0));
		expect(idle.uvi).toBe(0);
		expect(idle.status).not.toBe("critical");
	});

	test("carries an optional provider name and a synthetic window id", () => {
		const result = classifyMonthlySpendUvi(1, 10, new Date(2026, 7, 16), "openai");
		expect(result.provider).toBe("openai");
		expect(result.windowId).toBe("monthly");
	});
});
