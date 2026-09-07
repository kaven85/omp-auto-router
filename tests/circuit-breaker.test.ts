import { describe, expect, test } from "bun:test";

import { CircuitBreaker } from "../src/core/circuit-breaker";

const T0 = 1_000_000_000;

describe("CircuitBreaker closed → open", () => {
	test("unknown key starts closed", () => {
		const breaker = new CircuitBreaker();
		expect(breaker.state("p/m", T0)).toBe("closed");
	});

	test("stays closed below the default threshold of 3", () => {
		const breaker = new CircuitBreaker();
		breaker.recordFailure("p/m", T0);
		breaker.recordFailure("p/m", T0 + 1);
		expect(breaker.state("p/m", T0 + 2)).toBe("closed");
	});

	test("opens after 3 consecutive failures", () => {
		const breaker = new CircuitBreaker();
		breaker.recordFailure("p/m", T0);
		breaker.recordFailure("p/m", T0 + 1);
		breaker.recordFailure("p/m", T0 + 2);
		expect(breaker.state("p/m", T0 + 2)).toBe("open");
	});

	test("honors a custom failure threshold", () => {
		const breaker = new CircuitBreaker({ failureThreshold: 2 });
		breaker.recordFailure("p/m", T0);
		expect(breaker.state("p/m", T0)).toBe("closed");
		breaker.recordFailure("p/m", T0 + 1);
		expect(breaker.state("p/m", T0 + 1)).toBe("open");
	});

	test("a success resets the consecutive failure count", () => {
		const breaker = new CircuitBreaker();
		breaker.recordFailure("p/m", T0);
		breaker.recordFailure("p/m", T0 + 1);
		breaker.recordSuccess("p/m", T0 + 2);
		breaker.recordFailure("p/m", T0 + 2);
		breaker.recordFailure("p/m", T0 + 3);
		expect(breaker.state("p/m", T0 + 3)).toBe("closed");
	});

	test("state is isolated per key", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("a/m", T0 + i);
		expect(breaker.state("a/m", T0 + 3)).toBe("open");
		expect(breaker.state("b/m", T0 + 3)).toBe("closed");
	});
});

describe("CircuitBreaker open → half-open", () => {
	test("stays open during the default 60s cooldown", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		expect(breaker.state("p/m", T0 + 59_999)).toBe("open");
	});

	test("turns half-open exactly when the cooldown elapses", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		expect(breaker.state("p/m", T0 + 60_000)).toBe("half-open");
	});

	test("honors a custom cooldown", () => {
		const breaker = new CircuitBreaker({ cooldownMs: 5_000 });
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		expect(breaker.state("p/m", T0 + 4_999)).toBe("open");
		expect(breaker.state("p/m", T0 + 5_000)).toBe("half-open");
	});

	test("half-open success closes the circuit and resets backoff", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		const trialAt = T0 + 60_000;
		expect(breaker.state("p/m", trialAt)).toBe("half-open");
		breaker.recordSuccess("p/m", trialAt);
		expect(breaker.state("p/m", trialAt)).toBe("closed");
		// Backoff reset: 3 fresh failures reopen with the base 60s cooldown.
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", trialAt + 1);
		expect(breaker.state("p/m", trialAt + 1 + 59_999)).toBe("open");
		expect(breaker.state("p/m", trialAt + 1 + 60_000)).toBe("half-open");
	});
});

describe("CircuitBreaker half-open failure backoff", () => {
	test("failed trial reopens with doubled cooldown", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		const trialAt = T0 + 60_000;
		expect(breaker.state("p/m", trialAt)).toBe("half-open");
		breaker.recordFailure("p/m", trialAt);
		// Doubled: 120s. Still open at +60s and +119.999s, half-open at +120s.
		expect(breaker.state("p/m", trialAt + 60_000)).toBe("open");
		expect(breaker.state("p/m", trialAt + 119_999)).toBe("open");
		expect(breaker.state("p/m", trialAt + 120_000)).toBe("half-open");
	});

	test("repeated failed trials keep doubling: 60s → 120s → 240s", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		let trialAt = T0 + 60_000;
		breaker.recordFailure("p/m", trialAt); // cooldown now 120s
		trialAt += 120_000;
		expect(breaker.state("p/m", trialAt)).toBe("half-open");
		breaker.recordFailure("p/m", trialAt); // cooldown now 240s
		expect(breaker.state("p/m", trialAt + 239_999)).toBe("open");
		expect(breaker.state("p/m", trialAt + 240_000)).toBe("half-open");
	});

	test("backoff is capped at 30 minutes", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		// Walk through 8 failed trials: 60→120→240→480→960→1920(cap 1800)→1800→1800.
		let trialAt = T0;
		for (let i = 0; i < 8; i++) {
			trialAt += Math.min(60_000 * 2 ** i, 1_800_000);
			expect(breaker.state("p/m", trialAt)).toBe("half-open");
			breaker.recordFailure("p/m", trialAt);
		}
		// Cooldown must be capped: open just before 30min, half-open at 30min.
		expect(breaker.state("p/m", trialAt + 1_799_999)).toBe("open");
		expect(breaker.state("p/m", trialAt + 1_800_000)).toBe("half-open");
	});

	test("failures recorded while open do not extend the cooldown", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		breaker.recordFailure("p/m", T0 + 10_000);
		breaker.recordFailure("p/m", T0 + 20_000);
		expect(breaker.state("p/m", T0 + 60_000)).toBe("half-open");
	});
});

describe("CircuitBreaker reset", () => {
	test("reset clears all keys back to closed", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("a/m", T0);
		for (let i = 0; i < 2; i++) breaker.recordFailure("b/m", T0);
		breaker.reset();
		expect(breaker.state("a/m", T0)).toBe("closed");
		expect(breaker.state("b/m", T0)).toBe("closed");
	});
});

describe("CircuitBreaker snapshot/restore", () => {
	test("an open circuit survives a snapshot round-trip", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0 + i);
		const revived = new CircuitBreaker();
		revived.restore(breaker.snapshot());
		expect(revived.state("p/m", T0 + 30_000)).toBe("open");
		expect(revived.state("p/m", T0 + 62_000)).toBe("half-open"); // openedAt = T0+2 (threshold-reaching failure)
	});

	test("restored backoff preserves the doubled cooldown", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < 3; i++) breaker.recordFailure("p/m", T0);
		breaker.recordFailure("p/m", T0 + 60_000); // failed trial → 120s cooldown
		const revived = new CircuitBreaker();
		revived.restore(breaker.snapshot());
		expect(revived.state("p/m", T0 + 60_000 + 119_999)).toBe("open");
		expect(revived.state("p/m", T0 + 60_000 + 120_000)).toBe("half-open");
	});

	test("restores the effective retry deadline returned after a failed trial", () => {
		const breaker = new CircuitBreaker({ failureThreshold: 1 });
		breaker.recordFailure("p/m", T0, { cooldownMs: 5_000 });
		const backoff = breaker.recordFailure("p/m", T0 + 5_000, { cooldownMs: 5_000 });
		expect(backoff).toEqual({ cooldownMs: 10_000, retryAt: T0 + 15_000 });

		const revived = new CircuitBreaker({ failureThreshold: 1 });
		revived.restore(breaker.snapshot());
		expect(revived.state("p/m", T0 + 10_000)).toBe("open");
		expect(revived.state("p/m", backoff.retryAt)).toBe("half-open");
	});

	test("corrupt snapshot entries are skipped, valid ones survive", () => {
		const breaker = new CircuitBreaker();
		breaker.restore({
			"bad/neg": { consecutiveFailures: -1, openedAt: 0, cooldownMs: 1_000 },
			"bad/nan": { consecutiveFailures: Number.NaN, openedAt: 0, cooldownMs: 1_000 },
			"bad/zero-cd": { consecutiveFailures: 3, openedAt: T0, cooldownMs: 0 },
			"ok/m": { consecutiveFailures: 3, openedAt: T0, cooldownMs: 60_000 },
		});
		expect(breaker.state("bad/neg", T0)).toBe("closed");
		expect(breaker.state("bad/nan", T0)).toBe("closed");
		expect(breaker.state("bad/zero-cd", T0)).toBe("closed");
		expect(breaker.state("ok/m", T0 + 30_000)).toBe("open");
	});
});

describe("CircuitBreaker retryAt", () => {
	test("reports the half-open deadline only while failures meet the threshold", () => {
		const breaker = new CircuitBreaker();
		expect(breaker.retryAt("p/m")).toBeUndefined();
		breaker.recordFailure("p/m", T0);
		expect(breaker.retryAt("p/m")).toBeUndefined(); // below threshold
		breaker.recordFailure("p/m", T0 + 1);
		breaker.recordFailure("p/m", T0 + 2);
		expect(breaker.retryAt("p/m")).toBe(T0 + 2 + 60_000);
		breaker.recordSuccess("p/m", T0 + 3);
		expect(breaker.retryAt("p/m")).toBeUndefined();
	});
});

describe("CircuitBreaker multi-process merge", () => {
	test("a newer success tombstone beats another process's older failure", () => {
		const breaker = new CircuitBreaker();
		breaker.recordSuccess("p/m", T0 + 10_000);
		breaker.mergeSnapshot({
			"p/m": { consecutiveFailures: 3, openedAt: T0, cooldownMs: 60_000, updatedAt: T0 },
		}, T0 + 20_000);
		expect(breaker.state("p/m", T0 + 20_000)).toBe("closed");
	});

	test("a newer failure from another process beats a stale local tombstone", () => {
		const breaker = new CircuitBreaker();
		breaker.recordSuccess("p/m", T0);
		breaker.mergeSnapshot({
			"p/m": { consecutiveFailures: 3, openedAt: T0 + 5_000, cooldownMs: 60_000, updatedAt: T0 + 5_000 },
		}, T0 + 10_000);
		expect(breaker.state("p/m", T0 + 10_000)).toBe("open");
	});

	test("keys known only to the other process are adopted", () => {
		const breaker = new CircuitBreaker();
		breaker.mergeSnapshot({
			"other/m": { consecutiveFailures: 3, openedAt: T0, cooldownMs: 60_000 },
		}, T0 + 1_000);
		expect(breaker.state("other/m", T0 + 1_000)).toBe("open");
	});

	test("ancient success tombstones are pruned on both sides", () => {
		const breaker = new CircuitBreaker();
		breaker.recordSuccess("old/m", T0);
		breaker.mergeSnapshot({
			"disk/old": { consecutiveFailures: 0, openedAt: 0, cooldownMs: 60_000, updatedAt: T0 },
		}, T0 + 25 * 60 * 60_000);
		expect(breaker.snapshot()).toEqual({});
	});
});
