/**
 * UVI (Usage Velocity Index) — pure computation over host-agnostic quota data.
 *
 * UVI = consumed_fraction / elapsed_fraction per quota window. A UVI above 1
 * means the provider is burning quota faster than the window is elapsing;
 * below 1 it is ahead of pace. The highest-UVI window drives classification.
 */

import type { QuotaSnapshot, QuotaWindow, UviResult, UviStatus } from "./types";

/** UVI at or above which a provider is classified critical. */
export const UVI_CRITICAL_THRESHOLD = 2.0;
/** UVI at or above which a provider is classified stressed. */
export const UVI_STRESSED_THRESHOLD = 1.5;
/** UVI at or below which a provider may be classified surplus. */
export const UVI_SURPLUS_THRESHOLD = 0.5;
/** Minimum elapsed fraction required for the surplus classification. */
export const UVI_SURPLUS_MIN_ELAPSED = 0.7;

/**
 * Floor for the elapsed fraction. Without it, a window that just started
 * (elapsed ≈ 0) would produce absurd UVI values from trivial usage.
 */
const MIN_ELAPSED_FRACTION = 0.01;

/** Per-window evaluation result. */
interface WindowEval {
	uvi: number;
	elapsedFraction: number;
}

/**
 * Evaluate one window. Returns undefined when the window carries no usable
 * consumption data. Windows lacking timing metadata are treated as fully
 * elapsed (elapsed = 1.0), i.e. UVI equals the used fraction — conservative,
 * since we cannot prove the provider is ahead of pace.
 */
function evaluateWindow(window: QuotaWindow, nowMs: number): WindowEval | undefined {
	if (!Number.isFinite(window.usedFraction)) {
		return undefined;
	}
	let elapsedFraction = 1.0;
	if (
		window.windowSeconds !== undefined &&
		window.resetsAt !== undefined &&
		Number.isFinite(window.windowSeconds) &&
		Number.isFinite(window.resetsAt) &&
		window.windowSeconds > 0
	) {
		const remainingSeconds = (window.resetsAt - nowMs) / 1000;
		const elapsedFractionRaw = (window.windowSeconds - remainingSeconds) / window.windowSeconds;
		elapsedFraction = Math.min(1, Math.max(MIN_ELAPSED_FRACTION, elapsedFractionRaw));
	}
	return { uvi: window.usedFraction / elapsedFraction, elapsedFraction };
}

/** Map a UVI + elapsed fraction to a classification status. */
function classify(uvi: number, elapsedFraction: number): UviStatus {
	if (uvi >= UVI_CRITICAL_THRESHOLD) {
		return "critical";
	}
	if (uvi >= UVI_STRESSED_THRESHOLD) {
		return "stressed";
	}
	if (uvi <= UVI_SURPLUS_THRESHOLD && elapsedFraction >= UVI_SURPLUS_MIN_ELAPSED) {
		return "surplus";
	}
	return "ok";
}

/**
 * Compute the UVI for one provider's quota snapshot.
 *
 * The driving window is the usable window with the highest UVI. Snapshots with
 * a fetch error, or without any usable window, yield status "unknown" with
 * uvi 0 (never NaN).
 */
export function computeUvi(snapshot: QuotaSnapshot, nowMs: number): UviResult {
	if (snapshot.error !== undefined) {
		return { provider: snapshot.provider, uvi: 0, status: "unknown" };
	}
	let driver: { window: QuotaWindow; evaluated: WindowEval } | undefined;
	for (const window of snapshot.windows) {
		const evaluated = evaluateWindow(window, nowMs);
		if (evaluated === undefined) {
			continue;
		}
		if (driver === undefined || evaluated.uvi > driver.evaluated.uvi) {
			driver = { window, evaluated };
		}
	}
	if (driver === undefined) {
		return { provider: snapshot.provider, uvi: 0, status: "unknown" };
	}
	const uvi = Number.isFinite(driver.evaluated.uvi) ? driver.evaluated.uvi : 0;
	return {
		provider: snapshot.provider,
		uvi,
		status: classify(uvi, driver.evaluated.elapsedFraction),
		windowId: driver.window.id,
	};
}

/**
 * Compute UVI for a batch of snapshots, keyed by provider. Later snapshots for
 * the same provider overwrite earlier ones.
 */
export function computeAllUvi(snapshots: QuotaSnapshot[], nowMs: number): Record<string, UviResult> {
	const results: Record<string, UviResult> = {};
	for (const snapshot of snapshots) {
		results[snapshot.provider] = computeUvi(snapshot, nowMs);
	}
	return results;
}

/**
 * Classify per-token spend against a monthly USD budget as a synthetic quota
 * window. The elapsed fraction is the fraction of the LOCAL calendar month
 * containing `now` that has already passed (clamped to [0.01, 1], so the 1st
 * of the month does not divide by ~0).
 *
 * A non-positive budget with any spend classifies as infinitely over pace.
 */
export function classifyMonthlySpendUvi(
	spendUsd: number,
	budgetUsd: number,
	now: Date,
	provider: string = "",
): UviResult {
	const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
	const monthEndMs = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
	const spanMs = monthEndMs - monthStartMs;
	const elapsedFraction = Math.min(
		1,
		Math.max(MIN_ELAPSED_FRACTION, spanMs > 0 ? (now.getTime() - monthStartMs) / spanMs : 1),
	);
	const usedFraction = budgetUsd > 0 ? spendUsd / budgetUsd : spendUsd > 0 ? Number.POSITIVE_INFINITY : 0;
	const uvi = usedFraction / elapsedFraction;
	return {
		provider,
		uvi,
		status: classify(uvi, elapsedFraction),
		windowId: "monthly",
	};
}
