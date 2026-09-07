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

function normalizeCooldownMs(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0
		? Math.min(value, MAX_COOLDOWN_MS)
		: undefined;
}

/** Validate one persisted record; legacy entries without `updatedAt` fall back to `openedAt`. */
function normalizeRecord(rec: CircuitRecordSnapshot | undefined): CircuitRecord | undefined {
	if (
		!rec ||
		!Number.isFinite(rec.consecutiveFailures) || rec.consecutiveFailures < 0 ||
		!Number.isFinite(rec.openedAt) || rec.openedAt < 0 ||
		!Number.isFinite(rec.cooldownMs) || rec.cooldownMs <= 0
	) return undefined;
	const updatedAt = rec.updatedAt ?? rec.openedAt;
	if (!Number.isFinite(updatedAt) || updatedAt < 0) return undefined;
	return {
		consecutiveFailures: Math.floor(rec.consecutiveFailures),
		openedAt: rec.openedAt,
		cooldownMs: Math.min(rec.cooldownMs, MAX_COOLDOWN_MS),
		updatedAt,
	};
}

/** The effective retry window chosen after recording one target failure. */
export interface FailureBackoff {
	cooldownMs: number;
	retryAt: number;
}

/** Persisted per-key record. `updatedAt` is absent in legacy (pre-merge) snapshots. */
export interface CircuitRecordSnapshot {
	consecutiveFailures: number;
	openedAt: number;
	cooldownMs: number;
	/** Epoch ms of the last mutation; merge keeps the newer record per key. */
	updatedAt?: number;
}

interface CircuitRecord {
	/** Consecutive failures since the last success. */
	consecutiveFailures: number;
	/** Epoch ms of the most recent closed→open (or half-open→open) transition. */
	openedAt: number;
	/** Current cooldown; doubles on each failed half-open trial. */
	cooldownMs: number;
	/** Epoch ms of the last mutation (failure or success tombstone). */
	updatedAt: number;
}

/** Success tombstones older than this are pruned on merge; failure records never expire by age. */
const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;

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
	/** In-memory leases prevent concurrent callers from sharing one half-open probe. */
	private readonly trialLeases = new Set<string>();

	constructor(options: CircuitBreakerOptions = {}) {
		this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
		this.baseCooldownMs = normalizeCooldownMs(options.cooldownMs) ?? DEFAULT_COOLDOWN_MS;
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
	 * Atomically reserve the single half-open probe for `key`.
	 * The lease is process-local and deliberately not persisted: a restarted
	 * process owns no in-flight request and may safely admit one fresh probe.
	 */
	tryAcquireTrial(key: string, nowMs: number): boolean {
		if (this.state(key, nowMs) !== "half-open" || this.trialLeases.has(key)) return false;
		this.trialLeases.add(key);
		return true;
	}

	/** Release an unconsumed half-open trial, for example after user cancellation. */
	releaseTrial(key: string): void {
		this.trialLeases.delete(key);
	}

	/**
	 * Record a successful call: the key returns to closed with backoff reset.
	 * Resolves a half-open trial; harmless for unknown keys.
	 *
	 * Writes a success tombstone (failures=0) instead of deleting the record:
	 * concurrent processes share the persisted snapshot, and a plain delete
	 * would let another process's older failure record win the next merge.
	 */
	recordSuccess(key: string, nowMs: number): void {
		this.trialLeases.delete(key);
		this.records.set(key, {
			consecutiveFailures: 0,
			openedAt: 0,
			cooldownMs: this.baseCooldownMs,
			updatedAt: nowMs,
		});
	}

	/**
	 * The epoch-ms deadline after which an open circuit admits its half-open
	 * trial, or undefined for closed/unknown keys.
	 */
	retryAt(key: string): number | undefined {
		const rec = this.records.get(key);
		if (!rec || rec.consecutiveFailures < this.failureThreshold) return undefined;
		return rec.openedAt + rec.cooldownMs;
	}

	/**
	 * Record a failed call at `nowMs`.
	 * - Below threshold: increments the consecutive-failure count; reaching the
	 *   threshold opens the circuit with its configured cooldown, or the supplied
	 *   per-failure cooldown when one is provided.
	 * - While half-open (failed trial): re-opens immediately with doubled
	 *   cooldown (capped at 30 min).
	 * - While already open (cooling): only counts the failure.
	 */
	recordFailure(key: string, nowMs: number, options?: { cooldownMs?: number }): FailureBackoff {
		this.trialLeases.delete(key);
		const cooldownMs = normalizeCooldownMs(options?.cooldownMs) ?? this.baseCooldownMs;
		const rec = this.records.get(key);
		if (!rec) {
			this.records.set(key, {
				consecutiveFailures: 1,
				// With threshold 1 the circuit opens on this very failure.
				openedAt: this.failureThreshold <= 1 ? nowMs : 0,
				cooldownMs,
				updatedAt: nowMs,
			});
			return { cooldownMs, retryAt: nowMs + cooldownMs };
		}
		rec.updatedAt = nowMs;
		const halfOpenTrialFailed =
			rec.consecutiveFailures >= this.failureThreshold &&
			nowMs - rec.openedAt >= rec.cooldownMs;
		if (halfOpenTrialFailed) {
			rec.cooldownMs = Math.min(rec.cooldownMs * 2, MAX_COOLDOWN_MS);
			rec.openedAt = nowMs;
			return { cooldownMs: rec.cooldownMs, retryAt: nowMs + rec.cooldownMs };
		}
		rec.consecutiveFailures += 1;
		if (rec.consecutiveFailures === this.failureThreshold) {
			rec.openedAt = nowMs;
			rec.cooldownMs = cooldownMs;
			return { cooldownMs, retryAt: nowMs + cooldownMs };
		}
		if (rec.consecutiveFailures > this.failureThreshold) {
			return { cooldownMs: rec.cooldownMs, retryAt: rec.openedAt + rec.cooldownMs };
		}
		return { cooldownMs, retryAt: nowMs + cooldownMs };
	}

	/**
	 * Current per-key records, for persistence across restarts.
	 * `openedAt` is epoch ms; consumers must tolerate clock drift on restore.
	 * Success tombstones are included so a merge cannot resurrect older failures.
	 */
	snapshot(): Record<string, CircuitRecordSnapshot> {
		const out: Record<string, CircuitRecordSnapshot> = {};
		for (const [key, rec] of this.records) {
			out[key] = { ...rec };
		}
		return out;
	}

	/**
	 * Merge a snapshot read from the shared state file into memory.
	 * Per key, the record with the newer `updatedAt` wins — a success
	 * tombstone beats an older failure, and a newer failure beats a stale
	 * tombstone. Success tombstones older than 24h are pruned on both sides.
	 * Trial leases are untouched: they belong to this process's in-flight work.
	 */
	mergeSnapshot(snapshot: Record<string, CircuitRecordSnapshot>, nowMs: number): void {
		for (const [key, rec] of this.records) {
			if (rec.consecutiveFailures === 0 && nowMs - rec.updatedAt > TOMBSTONE_TTL_MS) {
				this.records.delete(key);
			}
		}
		for (const [key, raw] of Object.entries(snapshot)) {
			const incoming = normalizeRecord(raw);
			if (!incoming) continue;
			if (incoming.consecutiveFailures === 0 && nowMs - incoming.updatedAt > TOMBSTONE_TTL_MS) continue;
			const existing = this.records.get(key);
			if (!existing || incoming.updatedAt > existing.updatedAt) {
				this.records.set(key, incoming);
			}
		}
	}

	/**
	 * Replace all state with a previously taken snapshot. Entries with
	 * non-finite or negative fields are skipped. `openedAt` is kept verbatim —
	 * the state machine resolves open/half-open against the caller's clock, so
	 * a restored circuit whose cooldown already elapsed simply admits a trial.
	 * Legacy entries without `updatedAt` fall back to `openedAt`.
	 */
	restore(snapshot: Record<string, CircuitRecordSnapshot>): void {
		this.records.clear();
		for (const [key, rec] of Object.entries(snapshot)) {
			const normalized = normalizeRecord(rec);
			if (normalized) this.records.set(key, normalized);
		}
	}

	/** Drop all per-key state; every circuit returns to closed. */
	reset(): void {
		this.trialLeases.clear();
		this.records.clear();
	}
}
