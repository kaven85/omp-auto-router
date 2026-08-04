import { describe, expect, test } from "bun:test";

import { FeedbackTracker, type RatingStore } from "../src/core/feedback-tracker";
import type { RatingEntry } from "../src/core/types";

/** In-memory RatingStore that also records every save payload. */
function memoryStore(seed?: RatingEntry[]): { store: RatingStore; saved: RatingEntry[][] } {
	let data = seed;
	const saved: RatingEntry[][] = [];
	return {
		saved,
		store: {
			load: () => data,
			save: (entries) => {
				saved.push(entries);
				data = entries;
			},
		},
	};
}

/** Rating fixture without the timestamp (stamped by rate()). */
function entry(overrides: Partial<Omit<RatingEntry, "at">> = {}): Omit<RatingEntry, "at"> {
	return {
		rating: "good",
		provider: "anthropic",
		model: "claude",
		profile: "default",
		tier: "standard",
		...overrides,
	};
}

describe("FeedbackTracker", () => {
	test("rate stamps `at` from now and persists through the store port", () => {
		const { store, saved } = memoryStore();
		const tracker = new FeedbackTracker(store);
		const stamped = tracker.rate(entry({ comment: "great" }), 111);
		expect(stamped).toEqual({ ...entry({ comment: "great" }), at: 111 });
		expect(saved).toEqual([[stamped]]);
	});

	test("a tracker rebuilt from the same store sees prior ratings", () => {
		const { store } = memoryStore();
		new FeedbackTracker(store).rate(entry(), 1);
		const reloaded = new FeedbackTracker(store);
		expect(reloaded.statsFor("anthropic").total).toBe(1);
	});

	test("load() returning undefined starts empty", () => {
		const tracker = new FeedbackTracker(memoryStore(undefined).store);
		expect(tracker.recent(10)).toEqual([]);
	});

	test("statsFor aggregates per provider and narrows by model", () => {
		const tracker = new FeedbackTracker(memoryStore().store);
		tracker.rate(entry({ rating: "good" }), 1);
		tracker.rate(entry({ rating: "bad", model: "haiku" }), 2);
		tracker.rate(entry({ rating: "good", provider: "openai", model: "gpt" }), 3);

		expect(tracker.statsFor("anthropic")).toEqual({
			good: 1,
			bad: 1,
			total: 2,
			goodFraction: 0.5,
		});
		expect(tracker.statsFor("anthropic", "claude")).toEqual({
			good: 1,
			bad: 0,
			total: 1,
			goodFraction: 1,
		});
		expect(tracker.statsFor("anthropic", "unknown-model")).toEqual({
			good: 0,
			bad: 0,
			total: 0,
			goodFraction: 0,
		});
		expect(tracker.statsFor("nobody")).toEqual({ good: 0, bad: 0, total: 0, goodFraction: 0 });
	});

	test("recent(n) returns the newest ratings first", () => {
		const tracker = new FeedbackTracker(memoryStore().store);
		tracker.rate(entry({ comment: "a" }), 1);
		tracker.rate(entry({ comment: "b" }), 2);
		tracker.rate(entry({ comment: "c" }), 3);
		expect(tracker.recent(2).map((e) => e.at)).toEqual([3, 2]);
		expect(tracker.recent(10)).toHaveLength(3);
	});

	test("recent(0) and negative n yield []", () => {
		const tracker = new FeedbackTracker(memoryStore().store);
		tracker.rate(entry(), 1);
		expect(tracker.recent(0)).toEqual([]);
		expect(tracker.recent(-5)).toEqual([]);
	});

	test("reset clears history and persists the empty list", () => {
		const { store, saved } = memoryStore();
		const tracker = new FeedbackTracker(store);
		tracker.rate(entry(), 1);
		tracker.reset();
		expect(tracker.recent(10)).toEqual([]);
		expect(tracker.statsFor("anthropic").total).toBe(0);
		expect(saved[saved.length - 1]).toEqual([]);
	});

	test("rate caps retained history to maxEntries (memory + persisted size bounded)", () => {
		const { store, saved } = memoryStore();
		const tracker = new FeedbackTracker(store, 3);
		for (let i = 0; i < 5; i++) tracker.rate(entry({ provider: "anthropic" }), 1000 + i);
		// Only the most recent 3 survive.
		const recent = tracker.recent(10);
		expect(recent).toHaveLength(3);
		expect((saved.at(-1) as RatingEntry[]).length).toBe(3);
		// Oldest two (t=1000, 1001) dropped; retained = 1002, 1003, 1004, newest-first.
		expect(recent.map((r) => r.at)).toEqual([1004, 1003, 1002]);
	});

	test("constructor trims an over-cap store on load", () => {
		const seed: RatingEntry[] = Array.from({ length: 5 }, (_, i) => ({
			rating: "good" as const,
			provider: "anthropic",
			model: "claude",
			profile: "default",
			tier: "standard" as const,
			at: i,
		}));
		const tracker = new FeedbackTracker(memoryStore(seed).store, 2);
		expect(tracker.recent(10)).toHaveLength(2);
	});

	test("non-positive maxEntries keeps legacy unbounded behavior", () => {
		const { store, saved } = memoryStore();
		const tracker = new FeedbackTracker(store, 0);
		for (let i = 0; i < 5; i++) tracker.rate(entry({ provider: "anthropic" }));
		expect(tracker.recent(10)).toHaveLength(5);
		expect((saved.at(-1) as RatingEntry[]).length).toBe(5);
	});
});
