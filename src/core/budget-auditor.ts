/**
 * auditBudget — pure budget decision for one provider.
 *
 * Combines a configured USD limit (daily or monthly bucket) with an optional
 * UVI overlay: a critical UVI blocks the provider even when the USD budget is
 * healthy; a stressed UVI only annotates the reason (demotion is the
 * partitioner's job).
 */

import type { BudgetAudit, BudgetLimit, ProviderUsageStats, UviResult } from "./types";

/** Usage buckets consulted by the audit (daily vs monthly per limit kind). */
export interface BudgetAuditUsage {
	daily?: ProviderUsageStats;
	monthly?: ProviderUsageStats;
}

/** Fraction of the limit at/above which the audit warns. */
export const BUDGET_WARNING_THRESHOLD = 0.8;
/** Fraction of the limit at/above which the audit blocks. */
export const BUDGET_BLOCKED_THRESHOLD = 1.0;

function formatUsd(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/** Describe the UVI overlay for reason strings. */
function uviNote(uvi: UviResult): string {
	const window = uvi.windowId !== undefined ? ` (window "${uvi.windowId}")` : "";
	return `quota UVI ${uvi.uvi.toFixed(2)}${window}`;
}

/**
 * Audit a provider's budget posture.
 *
 * - No limit and no UVI → `{ status: "ok", usedFraction: 0 }`.
 * - Limit → usedFraction = cost / amount against the daily bucket (or monthly
 *   bucket when `limit.monthly`); ≥1.0 blocked, ≥0.8 warning, else ok;
 *   `remaining` is amount − cost clamped at 0.
 * - UVI overlay → critical blocks outright (reason cites the UVI, overriding a
 *   healthy USD budget); stressed keeps the status but appends a reason note.
 */
export function auditBudget(
	provider: string,
	usage: BudgetAuditUsage,
	limit: BudgetLimit | undefined,
	uvi?: UviResult,
): BudgetAudit {
	const audit: BudgetAudit = { status: "ok", provider, usedFraction: 0 };
	const reasons: string[] = [];

	if (limit !== undefined) {
		const bucket = limit.monthly === true ? usage.monthly : usage.daily;
		const cost = bucket?.cost ?? 0;
		const period = limit.monthly === true ? "monthly" : "daily";
		audit.usedFraction = limit.amount > 0 ? cost / limit.amount : cost > 0 ? Number.POSITIVE_INFINITY : 0;
		audit.remaining = Math.max(0, limit.amount - cost);
		audit.limit = limit;
		if (audit.usedFraction >= BUDGET_BLOCKED_THRESHOLD) {
			audit.status = "blocked";
			reasons.push(
				limit.amount > 0
					? `${period} budget exceeded: ${formatUsd(cost)} of ${formatUsd(limit.amount)} used`
					: `${period} budget exceeded: ${formatUsd(cost)} spent against a ${formatUsd(0)} limit`,
			);
		} else if (audit.usedFraction >= BUDGET_WARNING_THRESHOLD) {
			audit.status = "warning";
			reasons.push(
				`${period} budget at ${(audit.usedFraction * 100).toFixed(1)}%: ${formatUsd(cost)} of ${formatUsd(limit.amount)} used`,
			);
		}
	}

	if (uvi !== undefined && uvi.status === "critical") {
		audit.status = "blocked";
		reasons.push(`${uviNote(uvi)} is critical — provider blocked regardless of USD budget`);
	} else if (uvi !== undefined && uvi.status === "stressed") {
		reasons.push(`${uviNote(uvi)} is stressed — candidate will be demoted`);
	}

	if (reasons.length > 0) {
		audit.reason = reasons.join("; ");
	}
	return audit;
}
