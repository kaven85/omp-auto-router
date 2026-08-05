import { describe, expect, test } from "bun:test";
import { BudgetTracker, type BudgetStore, type LimitsStore } from "../src/core/budget-tracker";
import type { BudgetLimit, BudgetUsage } from "../src/core/types";

/** In-memory BudgetStore that deep-copies on save/load, like a JSON file would. */
class MemoryBudgetStore implements BudgetStore {
	private data: string | undefined;
	saves = 0;
	load(): BudgetUsage | undefined {
		return this.data === undefined ? undefined : (JSON.parse(this.data) as BudgetUsage);
	}
	save(usage: BudgetUsage): void {
		this.saves += 1;
		this.data = JSON.stringify(usage);
	}
}

/** In-memory LimitsStore with the same copy semantics. */
class MemoryLimitsStore implements LimitsStore {
	private data: string | undefined;
	saves = 0;
	load(): Record<string, BudgetLimit> | undefined {
		return this.data === undefined ? undefined : (JSON.parse(this.data) as Record<string, BudgetLimit>);
	}
	save(limits: Record<string, BudgetLimit>): void {
		this.saves += 1;
		this.data = JSON.stringify(limits);
	}
}

function makeTracker() {
	const usageStore = new MemoryBudgetStore();
	const limitsStore = new MemoryLimitsStore();
	return { tracker: new BudgetTracker(usageStore, limitsStore), usageStore, limitsStore };
}

const DAY1 = new Date(2026, 7, 3, 10, 0, 0); // Aug 3 2026, local
const DAY2 = new Date(2026, 7, 4, 10, 0, 0); // Aug 4 2026, local

describe("record + usage", () => {
	test("accumulates into daily and monthly buckets and persists", () => {
		const { tracker, usageStore } = makeTracker();
		tracker.record("anthropic", { inputTokens: 100, outputTokens: 50, cost: 0.25 }, DAY1);
		tracker.record("anthropic", { inputTokens: 300, outputTokens: 150, cost: 0.75 }, DAY1);

		const usage = tracker.usage("anthropic", DAY1);
		expect(usage.daily?.inputTokens).toBe(400);
		expect(usage.daily?.outputTokens).toBe(200);
		expect(usage.daily?.cost).toBeCloseTo(1.0, 10);
		expect(usage.daily?.updatedAt).toBe(DAY1.getTime());
		expect(usage.monthly?.cost).toBeCloseTo(1.0, 10);
		expect(usageStore.saves).toBe(2);
	});

	test("buckets roll over across days while the month accumulates", () => {
		const { tracker } = makeTracker();
		tracker.record("anthropic", { inputTokens: 100, outputTokens: 10, cost: 1 }, DAY1);
		tracker.record("anthropic", { inputTokens: 200, outputTokens: 20, cost: 2 }, DAY2);

		const day1 = tracker.usage("anthropic", DAY1);
		expect(day1.daily?.cost).toBe(1); // day 1 bucket untouched by day 2
		const day2 = tracker.usage("anthropic", DAY2);
		expect(day2.daily?.cost).toBe(2); // day 2 has only its own usage
		expect(day2.monthly?.cost).toBe(3); // month accumulates both days
		expect(day2.monthly?.inputTokens).toBe(300);
	});

	test("usage of an unknown provider or date is undefined, not fabricated", () => {
		const { tracker } = makeTracker();
		tracker.record("anthropic", { inputTokens: 1, outputTokens: 1, cost: 0.1 }, DAY1);
		expect(tracker.usage("openai", DAY1).daily).toBeUndefined();
		expect(tracker.usage("anthropic", DAY2).daily).toBeUndefined();
		expect(tracker.usage("anthropic", new Date(2026, 8, 1)).monthly).toBeUndefined();
	});

	test("providers are tracked independently", () => {
		const { tracker } = makeTracker();
		tracker.record("anthropic", { inputTokens: 1, outputTokens: 1, cost: 0.5 }, DAY1);
		tracker.record("openai", { inputTokens: 2, outputTokens: 2, cost: 0.25 }, DAY1);
		expect(tracker.usage("anthropic", DAY1).daily?.cost).toBe(0.5);
		expect(tracker.usage("openai", DAY1).daily?.cost).toBe(0.25);
	});
});

describe("limits", () => {
	test("mergeProfileLimits exposes defaults and command limits override them", () => {
		const { tracker } = makeTracker();
		tracker.mergeProfileLimits({ anthropic: { amount: 10, monthly: true } });
		expect(tracker.limits().anthropic).toEqual({ amount: 10, monthly: true });

		tracker.setLimit("anthropic", { amount: 20 }); // command override
		expect(tracker.limits().anthropic).toEqual({ amount: 20 }); // monthly dropped intentionally
	});

	test("re-merging profile defaults does not clobber persisted command overrides", () => {
		const { tracker } = makeTracker();
		tracker.mergeProfileLimits({ anthropic: { amount: 10, monthly: true }, google: { amount: 5 } });
		tracker.setLimit("anthropic", { amount: 30 });
		tracker.mergeProfileLimits({ anthropic: { amount: 10, monthly: true }, google: { amount: 5 } });
		expect(tracker.limits().anthropic).toEqual({ amount: 30 });
		expect(tracker.limits().google).toEqual({ amount: 5 });
	});

	test("invalid profile limits are ignored", () => {
		const { tracker } = makeTracker();
		tracker.mergeProfileLimits({ anthropic: { amount: Number.NaN }, google: { amount: 5 } });
		expect(tracker.limits().anthropic).toBeUndefined();
		expect(tracker.limits().google).toEqual({ amount: 5 });
	});

	test("setLimit stores and limits() returns a copy keyed by provider", () => {
		const { tracker, limitsStore } = makeTracker();
		tracker.setLimit("anthropic", { amount: 10 });
		tracker.setLimit("openai", { amount: 100, monthly: true });
		expect(tracker.limits()).toEqual({ anthropic: { amount: 10 }, openai: { amount: 100, monthly: true } });
		expect(limitsStore.saves).toBe(2);

		const copy = tracker.limits();
		copy.anthropic = { amount: 999 };
		expect(tracker.limits().anthropic?.amount).toBe(10); // mutation does not leak
	});

	test("clearLimit removes any limit when kind is unspecified", () => {
		const { tracker } = makeTracker();
		tracker.setLimit("anthropic", { amount: 10 });
		tracker.clearLimit("anthropic");
		expect(tracker.limits()).toEqual({});
	});

	test("clearLimit with a kind only clears a matching limit", () => {
		const { tracker } = makeTracker();
		tracker.setLimit("anthropic", { amount: 10 }); // daily limit
		tracker.clearLimit("anthropic", true); // asks to clear a monthly limit → no-op
		expect(tracker.limits().anthropic?.amount).toBe(10);
		tracker.clearLimit("anthropic", false);
		expect(tracker.limits().anthropic).toBeUndefined();
	});

	test("limits persist independently of usage data", () => {
		const { tracker, usageStore, limitsStore } = makeTracker();
		tracker.setLimit("anthropic", { amount: 10 });
		expect(usageStore.load()).toBeUndefined(); // setLimit never touches the usage store
		expect(limitsStore.load()).toEqual({ anthropic: { amount: 10 } });
	});
});

describe("persistence and recovery", () => {
	test("state survives a new tracker over the same stores", () => {
		const { tracker, usageStore, limitsStore } = makeTracker();
		tracker.record("anthropic", { inputTokens: 5, outputTokens: 6, cost: 0.7 }, DAY1);
		tracker.setLimit("anthropic", { amount: 5 });

		const restored = new BudgetTracker(usageStore, limitsStore);
		expect(restored.usage("anthropic", DAY1).daily?.cost).toBeCloseTo(0.7, 10);
		expect(restored.limits().anthropic?.amount).toBe(5);
	});

	test("missing store data starts empty", () => {
		const { tracker } = makeTracker();
		expect(tracker.usage("anthropic", DAY1)).toEqual({});
		expect(tracker.limits()).toEqual({});
	});

	test("a throwing store starts empty and never throws", () => {
		const brokenUsage: BudgetStore = {
			load: () => {
				throw new Error("disk on fire");
			},
			save: () => {},
		};
		const brokenLimits: LimitsStore = {
			load: () => {
				throw new Error("disk on fire");
			},
			save: () => {},
		};
		const tracker = new BudgetTracker(brokenUsage, brokenLimits);
		expect(tracker.usage("anthropic", DAY1)).toEqual({});
		expect(tracker.limits()).toEqual({});
		expect(() => tracker.record("a", { inputTokens: 1, outputTokens: 1, cost: 1 }, DAY1)).not.toThrow();
	});

	test("corrupt store shapes are dropped, valid entries survive", () => {
		const usageStore = new MemoryBudgetStore();
		const limitsStore = new MemoryLimitsStore();
		usageStore.save({
			daily: {
				"2026-08-03": {
					good: { inputTokens: 1, outputTokens: 2, cost: 0.3, updatedAt: 42 },
					bad: { inputTokens: "lots" } as unknown as never,
				},
			},
			monthly: "not-a-map" as unknown as never,
		});
		limitsStore.save({ ok: { amount: 5 }, broken: { amount: "five" } as unknown as never });

		const tracker = new BudgetTracker(usageStore, limitsStore);
		expect(tracker.usage("good", DAY1).daily?.cost).toBeCloseTo(0.3, 10);
		expect(tracker.usage("bad", DAY1).daily).toBeUndefined();
		expect(tracker.usage("good", DAY1).monthly).toBeUndefined();
		expect(tracker.limits()).toEqual({ ok: { amount: 5 } });
	});
});

describe("reset", () => {
	test("clears usage but keeps limits", () => {
		const { tracker } = makeTracker();
		tracker.record("anthropic", { inputTokens: 1, outputTokens: 1, cost: 1 }, DAY1);
		tracker.setLimit("anthropic", { amount: 10 });
		tracker.reset();
		expect(tracker.usage("anthropic", DAY1)).toEqual({});
		expect(tracker.limits().anthropic?.amount).toBe(10);
	});
});
