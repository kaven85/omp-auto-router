/**
 * BudgetTracker — accumulates per-provider token/cost usage into local-day and
 * local-month buckets, and manages configured USD limits.
 *
 * Persistence goes through injected ports (wired to the JSON state store by
 * the pipeline); the tracker itself never touches disk directly. Corrupt or
 * missing store data is treated as empty — loading never throws.
 */

import type { BudgetLimit, BudgetUsage, ProviderUsageStats } from "./types";

/** Persistence port for accumulated usage. */
export interface BudgetStore {
	load(): BudgetUsage | undefined;
	save(usage: BudgetUsage): void;
}

/** Persistence port for configured limits (same shape as BudgetStore). */
export interface LimitsStore {
	load(): Record<string, BudgetLimit> | undefined;
	save(limits: Record<string, BudgetLimit>): void;
}

/** Usage buckets for one provider at one point in time. */
export interface ProviderUsageBuckets {
	daily?: ProviderUsageStats;
	monthly?: ProviderUsageStats;
}

/** YYYY-MM-DD in local time. */
function dayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** YYYY-MM in local time. */
function monthKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	return `${date.getFullYear()}-${month}`;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Daily usage buckets are retained for this many days; monthly rollups are kept indefinitely. */
export const DAILY_RETENTION_DAYS = 62;

/** Validate one stats entry; corrupt entries are dropped rather than trusted. */
function isUsageStats(value: unknown): value is ProviderUsageStats {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const stats = value as Record<string, unknown>;
	return (
		isFiniteNumber(stats.inputTokens) &&
		isFiniteNumber(stats.outputTokens) &&
		isFiniteNumber(stats.cost) &&
		isFiniteNumber(stats.updatedAt)
	);
}

/** Validate a two-level bucket map (date/month → provider → stats). */
function sanitizeBuckets(value: unknown): Record<string, Record<string, ProviderUsageStats>> {
	const buckets: Record<string, Record<string, ProviderUsageStats>> = {};
	if (typeof value !== "object" || value === null) {
		return buckets;
	}
	for (const [key, perProvider] of Object.entries(value)) {
		if (typeof perProvider !== "object" || perProvider === null) {
			continue;
		}
		const valid: Record<string, ProviderUsageStats> = {};
		for (const [provider, stats] of Object.entries(perProvider)) {
			if (isUsageStats(stats)) {
				valid[provider] = stats;
			}
		}
		buckets[key] = valid;
	}
	return buckets;
}

/** Load usage defensively: any throw or malformed shape starts empty. */
function loadUsage(store: BudgetStore): BudgetUsage {
	try {
		const raw = store.load();
		if (typeof raw !== "object" || raw === null) {
			return { daily: {}, monthly: {} };
		}
		return { daily: sanitizeBuckets(raw.daily), monthly: sanitizeBuckets(raw.monthly) };
	} catch {
		return { daily: {}, monthly: {} };
	}
}

/** Load limits defensively: any throw or malformed shape starts empty. */
function loadLimits(store: LimitsStore): Record<string, BudgetLimit> {
	try {
		const raw = store.load();
		if (typeof raw !== "object" || raw === null) {
			return {};
		}
		const limits: Record<string, BudgetLimit> = {};
		for (const [provider, limit] of Object.entries(raw)) {
			if (typeof limit === "object" && limit !== null && isFiniteNumber(limit.amount)) {
				limits[provider] = limit;
			}
		}
		return limits;
	} catch {
		return {};
	}
}

/** Add a delta into one bucket map under `key`/`provider`, creating entries as needed. */
function accumulate(
	buckets: Record<string, Record<string, ProviderUsageStats>>,
	key: string,
	provider: string,
	delta: { inputTokens: number; outputTokens: number; cost: number },
	nowMs: number,
): void {
	const perProvider = buckets[key] ?? (buckets[key] = {});
	const stats = perProvider[provider] ?? { inputTokens: 0, outputTokens: 0, cost: 0, updatedAt: nowMs };
	stats.inputTokens += delta.inputTokens;
	stats.outputTokens += delta.outputTokens;
	stats.cost += delta.cost;
	stats.updatedAt = nowMs;
	perProvider[provider] = stats;
}

/**
 * Tracks per-provider usage and limits. All state is held in memory after
 * construction and flushed to the stores on every mutation.
 */
export class BudgetTracker {
	private usageData: BudgetUsage;
	private limitsData: Record<string, BudgetLimit>;
	/** Profile-configured defaults; command/file limits take precedence. */
	private profileLimitsData: Record<string, BudgetLimit> = {};

	constructor(
		private readonly usageStore: BudgetStore,
		private readonly limitsStore: LimitsStore,
	) {
		this.usageData = loadUsage(usageStore);
		this.limitsData = loadLimits(limitsStore);
	}

	/**
	 * Accumulate a usage delta into the provider's daily (YYYY-MM-DD) and
	 * monthly (YYYY-MM) buckets, keyed by LOCAL date, then persist.
	 *
	 * @param now Timestamp for bucket selection and `updatedAt`; defaults to the current time.
	 */
	record(
		provider: string,
		delta: { inputTokens: number; outputTokens: number; cost: number },
		now: Date = new Date(),
	): void {
		const nowMs = now.getTime();
		accumulate(this.usageData.daily, dayKey(now), provider, delta, nowMs);
		accumulate(this.usageData.monthly, monthKey(now), provider, delta, nowMs);
		// Bound growth: daily buckets older than the retention window are dead
		// weight (monthly rollups keep the long-term view).
		const cutoff = dayKey(new Date(nowMs - DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000));
		for (const key of Object.keys(this.usageData.daily)) {
			if (key < cutoff) delete this.usageData.daily[key];
		}
		this.usageStore.save(this.usageData);
	}

	/** Set (or replace) the USD limit for a provider and persist. */
	setLimit(provider: string, limit: BudgetLimit): void {
		this.limitsData[provider] = limit;
		this.limitsStore.save(this.limitsData);
	}

	/**
	 * Clear a provider's limit and persist. When `monthly` is given, the limit
	 * is only cleared if its kind matches (true = monthly limit, false = daily);
	 * otherwise any limit for the provider is cleared.
	 */
	clearLimit(provider: string, monthly?: boolean): void {
		const existing = this.limitsData[provider];
		if (existing === undefined) {
			return;
		}
		if (monthly !== undefined && Boolean(existing.monthly) !== monthly) {
			return;
		}
		delete this.limitsData[provider];
		this.limitsStore.save(this.limitsData);
	}

	/**
	 * Current usage buckets for a provider. `daily` is today's (local) bucket,
	 * `monthly` the current local month's; either is undefined when nothing has
	 * been recorded for that period.
	 *
	 * @param now Bucket selection timestamp; defaults to the current time.
	 */
	usage(provider: string, now: Date = new Date()): ProviderUsageBuckets {
		const buckets: ProviderUsageBuckets = {};
		const daily = this.usageData.daily[dayKey(now)]?.[provider];
		if (daily !== undefined) {
			buckets.daily = daily;
		}
		const monthly = this.usageData.monthly[monthKey(now)]?.[provider];
		if (monthly !== undefined) {
			buckets.monthly = monthly;
		}
		return buckets;
	}

	/** All configured limits, keyed by provider (a copy). File/command limits override profile defaults. */
	limits(): Record<string, BudgetLimit> {
		return { ...this.profileLimitsData, ...this.limitsData };
	}

	/**
	 * Merge profile-configured default limits. These are overridden by any
	 * limit set via `setLimit` (which persists to the limits store). Calling
	 * this again replaces the previous profile-default layer, so config reloads
	 * keep the effective limits in sync without clobbering user overrides.
	 */
	mergeProfileLimits(limits: Record<string, BudgetLimit>): void {
		this.profileLimitsData = {};
		for (const [provider, limit] of Object.entries(limits)) {
			if (limit && typeof limit === "object" && isFiniteNumber(limit.amount)) {
				this.profileLimitsData[provider] = limit;
			}
		}
	}

	/** Clear profile-configured default limits. */
	clearProfileLimits(): void {
		this.profileLimitsData = {};
	}

	/** Clear all accumulated usage (limits are kept) and persist. */
	reset(): void {
		this.usageData = { daily: {}, monthly: {} };
		this.usageStore.save(this.usageData);
	}
}
