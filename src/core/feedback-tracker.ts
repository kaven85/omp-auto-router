/**
 * FeedbackTracker — 👍/👎 rating history with aggregate stats.
 *
 * Entries persist through the injected RatingStore port (adapter-backed in
 * production, in-memory in tests); the tracker itself holds no IO knowledge.
 */

import type { RatingEntry } from "./types";

/** Persistence port for rating entries. */
export interface RatingStore {
	/** Previously saved entries in recorded order; `undefined` when none. */
	load(): RatingEntry[] | undefined;
	/** Persist the full entry list (recorded order). */
	save(entries: RatingEntry[]): void;
}

/** Aggregate rating counts for a provider (optionally narrowed to a model). */
export interface RatingStats {
	good: number;
	bad: number;
	total: number;
	/** good / total; 0 when there are no ratings. */
	goodFraction: number;
}

/** Default maximum retained rating entries (bounds memory + persisted size). */
const DEFAULT_MAX_ENTRIES = 1000;

/** Rating history backed by an injected store port. */
export class FeedbackTracker {
	private readonly store: RatingStore;
	private readonly maxEntries: number;
	private entries: RatingEntry[];

	constructor(store: RatingStore, maxEntries = DEFAULT_MAX_ENTRIES) {
		// A non-positive cap means unbounded (legacy behavior); otherwise the
		// retained history — and the persisted file — stays under `maxEntries`.
		const max = Number.isInteger(maxEntries) ? maxEntries : DEFAULT_MAX_ENTRIES;
		this.store = store;
		this.maxEntries = max > 0 ? max : Infinity;
		this.entries = store.load() ?? [];
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(-this.maxEntries);
		}
	}

	/**
	 * Record a rating and persist. `at` is stamped from `now`.
	 * @param now Epoch ms; defaults to `Date.now()` when omitted.
	 * @returns the stamped entry as recorded.
	 */
	rate(entry: Omit<RatingEntry, "at">, now?: number): RatingEntry {
		const stamped: RatingEntry = { ...entry, at: now ?? Date.now() };
		this.entries.push(stamped);
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(-this.maxEntries);
		}
		this.store.save([...this.entries]);
		return stamped;
	}

	/** Aggregate stats for a provider, optionally narrowed to one model. */
	statsFor(provider: string, model?: string): RatingStats {
		let good = 0;
		let bad = 0;
		for (const entry of this.entries) {
			if (entry.provider !== provider) continue;
			if (model !== undefined && entry.model !== model) continue;
			if (entry.rating === "good") good += 1;
			else bad += 1;
		}
		const total = good + bad;
		return { good, bad, total, goodFraction: total === 0 ? 0 : good / total };
	}

	/** The last `n` ratings, newest first. `n <= 0` yields `[]`. */
	recent(n: number): RatingEntry[] {
		if (n <= 0) return [];
		return this.entries.slice(-n).reverse();
	}

	/** Drop all ratings and persist the empty list. */
	reset(): void {
		this.entries = [];
		this.store.save([]);
	}
}
