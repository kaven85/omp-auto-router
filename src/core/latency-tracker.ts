/**
 * LatencyTracker — rolling average latency per provider/model key.
 *
 * Keeps at most `maxSamples` (default 100) samples per key; the average is a
 * rolling mean over the retained window. Supports snapshot/restore so the
 * host can persist warm-start averages across sessions. Pure in-memory state;
 * no clocks, no I/O.
 */

/** Tunables for {@link LatencyTracker}. */
export interface LatencyTrackerOptions {
	/** Samples retained per key for the rolling mean. Default 100. */
	maxSamples?: number;
}

/**
 * Rolling-mean latency tracker. Keys are canonical "provider/model" strings.
 */
export class LatencyTracker {
	private readonly maxSamples: number;
	private readonly samples = new Map<string, number[]>();

	constructor(options: LatencyTrackerOptions = {}) {
		this.maxSamples = Math.max(1, options.maxSamples ?? 100);
	}

	/**
	 * Record one observed latency in ms. Non-finite or negative values are
	 * ignored (they carry no signal and would poison the mean).
	 */
	record(key: string, ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) return;
		let window = this.samples.get(key);
		if (!window) {
			window = [];
			this.samples.set(key, window);
		}
		window.push(ms);
		if (window.length > this.maxSamples) {
			window.splice(0, window.length - this.maxSamples);
		}
	}

	/** Rolling mean for `key`, or undefined when no samples exist. */
	average(key: string): number | undefined {
		const window = this.samples.get(key);
		if (!window || window.length === 0) return undefined;
		let sum = 0;
		for (const ms of window) sum += ms;
		return sum / window.length;
	}

	/** Current rolling mean per key, for persistence. Empty keys are omitted. */
	snapshot(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [key, window] of this.samples) {
			if (window.length === 0) continue;
			let sum = 0;
			for (const ms of window) sum += ms;
			out[key] = sum / window.length;
		}
		return out;
	}

	/**
	 * Replace all state with a previously taken snapshot. Each restored average
	 * is seeded as a single sample, so fresh recordings quickly dominate the
	 * rolling mean again. Non-finite or negative entries are skipped.
	 */
	restore(snapshot: Record<string, number>): void {
		this.samples.clear();
		for (const [key, average] of Object.entries(snapshot)) {
			if (!Number.isFinite(average) || average < 0) continue;
			this.samples.set(key, [average]);
		}
	}

	/** Drop all samples. */
	reset(): void {
		this.samples.clear();
	}
}
