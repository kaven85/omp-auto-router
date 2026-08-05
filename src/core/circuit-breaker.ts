/**
 * CircuitBreaker — per provider/model-key failure gate.
 *
 * State machine: closed → open (after `failureThreshold` consecutive failures)
 * → half-open (once `cooldownMs` has elapsed since the circuit opened).
 *
 * While half-open a single trial is admitted: the router is sequential, so the
 * first candidate tried after the cooldown elapsed IS the trial. The trial
 * resolves through:
 *  - `recordSuccess` → closed (failure count and backoff fully reset);
 *  - `recordFailure` → open again with a doubled cooldown (capped at 30 min).
 *
 * All time is injected as epoch ms; the breaker never reads a clock itself.
 */

import type { CircuitState } from "./types";

/** Default consecutive failures before the circuit opens. */
const DEFAULT_FAILURE_THRESHOLD = 3;
/** Default cooldown before an open circuit admits a half-open trial. */
const DEFAULT_COOLDOWN_MS = 60_000;
/** Hard cap for the exponential backoff after failed half-open trials. */
const MAX_COOLDOWN_MS = 30 * 60_000;

interface CircuitRecord {
	/** Consecutive failures since the last success. */
	consecutiveFailures: number;
	/** Epoch ms of the most recent closed→open (or half-open→open) transition. */
	openedAt: number;
	/** Current cooldown; doubles on each failed half-open trial. */
	cooldownMs: number;
}

/** Tunables for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
	/** Consecutive failures before opening. Default 3. */
	failureThreshold?: number;
	/** Base cooldown in ms before half-open. Default 60_000. */
	cooldownMs?: number;
}

/**
 * Per-key circuit breaker. Keys are canonical "provider/model" strings.
 */
export class CircuitBreaker {
	private readonly failureThreshold: number;
	private readonly baseCooldownMs: number;
	private readonly records = new Map<string, CircuitRecord>();

	constructor(options: CircuitBreakerOptions = {}) {
		this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
		this.baseCooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	}

	/**
	 * Current state of `key` at `nowMs`. Pure: no side effects, safe to poll.
	 * "half-open" is reported once `nowMs - openedAt >= cooldownMs`; the caller
	 * must then resolve the trial via {@link recordSuccess}/{@link recordFailure}.
	 */
	state(key: string, nowMs: number): CircuitState {
		const rec = this.records.get(key);
		if (!rec || rec.consecutiveFailures < this.failureThreshold) return "closed";
		return nowMs - rec.openedAt >= rec.cooldownMs ? "half-open" : "open";
	}

	/**
	 * Record a successful call: the key returns to closed with backoff reset.
	 * Resolves a half-open trial; harmless for unknown keys.
	 */
	recordSuccess(key: string): void {
		this.records.delete(key);
	}

	/**
	 * Record a failed call at `nowMs`.
	 * - Below threshold: increments the consecutive-failure count; reaching the
	 *   threshold opens the circuit with the base cooldown.
	 * - While half-open (failed trial): re-opens immediately with doubled
	 *   cooldown (capped at 30 min).
	 * - While already open (cooling): only counts the failure.
	 */
	recordFailure(key: string, nowMs: number): void {
		const rec = this.records.get(key);
		if (!rec) {
			this.records.set(key, {
				consecutiveFailures: 1,
				// With threshold 1 the circuit opens on this very failure.
				openedAt: this.failureThreshold <= 1 ? nowMs : 0,
				cooldownMs: this.baseCooldownMs,
			});
			return;
		}
		const halfOpenTrialFailed =
			rec.consecutiveFailures >= this.failureThreshold &&
			nowMs - rec.openedAt >= rec.cooldownMs;
		if (halfOpenTrialFailed) {
			rec.cooldownMs = Math.min(rec.cooldownMs * 2, MAX_COOLDOWN_MS);
			rec.openedAt = nowMs;
			return;
		}
		rec.consecutiveFailures += 1;
		if (rec.consecutiveFailures === this.failureThreshold) {
			rec.openedAt = nowMs;
			rec.cooldownMs = this.baseCooldownMs;
		}
	}

	/**
	 * Current per-key records, for persistence across restarts.
	 * `openedAt` is epoch ms; consumers must tolerate clock drift on restore.
	 */
	snapshot(): Record<string, { consecutiveFailures: number; openedAt: number; cooldownMs: number }> {
		const out: Record<string, { consecutiveFailures: number; openedAt: number; cooldownMs: number }> = {};
		for (const [key, rec] of this.records) {
			out[key] = { ...rec };
		}
		return out;
	}

	/**
	 * Replace all state with a previously taken snapshot. Entries with
	 * non-finite or negative fields are skipped. `openedAt` is kept verbatim —
	 * the state machine resolves open/half-open against the caller's clock, so
	 * a restored circuit whose cooldown already elapsed simply admits a trial.
	 */
	restore(snapshot: Record<string, { consecutiveFailures: number; openedAt: number; cooldownMs: number }>): void {
		this.records.clear();
		for (const [key, rec] of Object.entries(snapshot)) {
			if (
				!rec ||
				!Number.isFinite(rec.consecutiveFailures) || rec.consecutiveFailures < 0 ||
				!Number.isFinite(rec.openedAt) || rec.openedAt < 0 ||
				!Number.isFinite(rec.cooldownMs) || rec.cooldownMs <= 0
			) continue;
			this.records.set(key, {
				consecutiveFailures: Math.floor(rec.consecutiveFailures),
				openedAt: rec.openedAt,
				cooldownMs: Math.min(rec.cooldownMs, MAX_COOLDOWN_MS),
			});
		}
	}

	/** Drop all per-key state; every circuit returns to closed. */
	reset(): void {
		this.records.clear();
	}
}
