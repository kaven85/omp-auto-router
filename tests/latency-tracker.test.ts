import { describe, expect, test } from "bun:test";

import { LatencyTracker } from "../src/core/latency-tracker";

describe("LatencyTracker recording", () => {
	test("average is undefined for an unknown key", () => {
		const tracker = new LatencyTracker();
		expect(tracker.average("p/m")).toBeUndefined();
	});

	test("average is the mean of recorded samples", () => {
		const tracker = new LatencyTracker();
		tracker.record("p/m", 100);
		tracker.record("p/m", 200);
		tracker.record("p/m", 300);
		expect(tracker.average("p/m")).toBe(200);
	});

	test("samples are isolated per key", () => {
		const tracker = new LatencyTracker();
		tracker.record("a/m", 100);
		tracker.record("b/m", 500);
		expect(tracker.average("a/m")).toBe(100);
		expect(tracker.average("b/m")).toBe(500);
	});

	test("ignores non-finite and negative samples", () => {
		const tracker = new LatencyTracker();
		tracker.record("p/m", Number.NaN);
		tracker.record("p/m", Number.POSITIVE_INFINITY);
		tracker.record("p/m", -5);
		expect(tracker.average("p/m")).toBeUndefined();
		tracker.record("p/m", 100);
		expect(tracker.average("p/m")).toBe(100);
	});
});

describe("LatencyTracker rolling window", () => {
	test("drops the oldest samples beyond maxSamples", () => {
		const tracker = new LatencyTracker({ maxSamples: 3 });
		for (const ms of [1, 2, 3, 4, 5]) tracker.record("p/m", ms);
		expect(tracker.average("p/m")).toBe(4); // mean of 3, 4, 5
	});

	test("defaults to a 100-sample window", () => {
		const tracker = new LatencyTracker();
		for (let i = 1; i <= 150; i++) tracker.record("p/m", i);
		// Mean of 51..150 = (51 + 150) / 2 = 100.5
		expect(tracker.average("p/m")).toBe(100.5);
	});
});

describe("LatencyTracker snapshot / restore", () => {
	test("snapshot exposes the current averages", () => {
		const tracker = new LatencyTracker();
		tracker.record("a/m", 100);
		tracker.record("a/m", 300);
		tracker.record("b/m", 50);
		expect(tracker.snapshot()).toEqual({ "a/m": 200, "b/m": 50 });
	});

	test("snapshot of an empty tracker is empty", () => {
		expect(new LatencyTracker().snapshot()).toEqual({});
	});

	test("restore round-trips averages", () => {
		const source = new LatencyTracker();
		source.record("a/m", 100);
		source.record("a/m", 300);
		const restored = new LatencyTracker();
		restored.restore(source.snapshot());
		expect(restored.average("a/m")).toBe(200);
	});

	test("restored averages act as one seed sample", () => {
		const tracker = new LatencyTracker({ maxSamples: 3 });
		tracker.restore({ "p/m": 90 });
		tracker.record("p/m", 120);
		expect(tracker.average("p/m")).toBe(105);
	});

	test("restore replaces existing state and skips invalid entries", () => {
		const tracker = new LatencyTracker();
		tracker.record("old/m", 10);
		tracker.restore({ "new/m": 42, "bad/m": Number.NaN });
		expect(tracker.average("old/m")).toBeUndefined();
		expect(tracker.average("new/m")).toBe(42);
		expect(tracker.average("bad/m")).toBeUndefined();
	});
});

describe("LatencyTracker reset", () => {
	test("reset drops all samples", () => {
		const tracker = new LatencyTracker();
		tracker.record("p/m", 100);
		tracker.reset();
		expect(tracker.average("p/m")).toBeUndefined();
		expect(tracker.snapshot()).toEqual({});
	});
});
