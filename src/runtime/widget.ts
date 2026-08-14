/**
 * Host-neutral dashboard widget: decision line plus live budget/circuit/UVI
 * snapshots, rendered identically for OMP and Pi. Duplicate suppression is
 * instance-local (state.widgetPayload) so one session never suppresses
 * another session's first render. Where the host cannot provide quota
 * reports, the widget simply omits UVI-budget lines instead of fabricating
 * remaining quota; prepaid balances still render because they come from
 * provider balance endpoints, not host usage reports.
 */

import type { RoutingDecision } from "../core/types";
import type { RouterRuntimeState } from "./router-runtime";

function observedLatencySuffix(state: RouterRuntimeState, decision: RoutingDecision): string {
	const key = `${decision.target.provider}/${decision.target.model}`;
	const averageMs = state.latency.average(key);
	if (averageMs === undefined) return "";
	return ` | first output=${(averageMs / 1_000).toFixed(1)}s`;
}

/**
 * Compose the widget lines. UVI windows past their `resetsAt` are shown as
 * freshly reset — the cached fetch would otherwise keep displaying the
 * pre-reset usage until the next poll.
 */
export function buildWidgetLines(state: RouterRuntimeState, decision?: RoutingDecision): string[] {
	const lines: string[] = [];
	if (decision !== undefined) {
		const billing = decision.target.billing === "per-token" ? " (per-token)" : "";
		lines.push(
			`${decision.profile} | tier=${decision.tier} | ${decision.target.provider}/${decision.target.model}${billing}${decision.thinking !== undefined ? ` | ${decision.thinking}` : ""}${observedLatencySuffix(state, decision)}`,
		);
	}
	const budgetBits: string[] = [];
	for (const [provider, limit] of Object.entries(state.budgets.limits())) {
		const bucket = limit.monthly ? state.budgets.usage(provider).monthly : state.budgets.usage(provider).daily;
		const used = bucket?.cost ?? 0;
		const pct = limit.amount > 0 ? Math.round((used / limit.amount) * 100) : 0;
		budgetBits.push(`${provider} $${used.toFixed(2)}/$${limit.amount}${limit.monthly ? "/mo" : "/day"} (${pct}%)`);
	}
	if (budgetBits.length > 0) lines.push(`budgets: ${budgetBits.join(" · ")}`);
	const openCircuits = Object.entries(state.circuit.snapshot())
		.filter(([, rec]) => Date.now() - rec.openedAt < rec.cooldownMs)
		.map(([key, rec]) => `${key} (${rec.consecutiveFailures}x)`);
	if (openCircuits.length > 0) lines.push(`circuit open: ${openCircuits.join(" · ")}`);
	// UVI quota pacing: only the current provider's remaining window — the
	// full per-provider breakdown lives in `/auto-router usage`.
	const currentProvider = decision?.target.provider;
	if (state.uviEnabled && currentProvider !== undefined) {
		const nowMs = Date.now();
		const uviBits = (state.quotaCache?.data ?? [])
			.filter((snapshot) => snapshot.provider === currentProvider)
			.map((snapshot) => {
				const worst = Math.max(
					0,
					...snapshot.windows.map((window) =>
						window.resetsAt !== undefined && window.resetsAt <= nowMs ? 0 : window.usedFraction,
					),
				);
				return `${snapshot.provider} ${(100 - worst * 100).toFixed(0)}% left`;
			});
		if (uviBits.length > 0) lines.push(`uvi: ${uviBits.join(" · ")}`);
		const balance = state.balanceCache?.[currentProvider];
		if (balance !== undefined) lines.push(`balance: ${currentProvider} ${balance.total} ${balance.currency}`);
	}
	return lines;
}

/**
 * Render the widget through the adapter's sink, skipping no-op updates.
 * Shared by the request path (new decision) and background refresh (fresh
 * quota data) so the display tracks cache changes within one cadence without
 * re-rendering when nothing changed.
 */
export function renderRouterWidget(
	state: RouterRuntimeState,
	sink: (lines: string[]) => void,
	decision?: RoutingDecision,
): void {
	const lines = buildWidgetLines(state, decision);
	if (lines.length === 0) return;
	const payload = lines.join("\n");
	if (payload === state.widgetPayload) return;
	state.widgetPayload = payload;
	sink(lines);
}
