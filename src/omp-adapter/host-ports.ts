/**
 * HostPorts implementation over the omp ExtensionAPI surface.
 *
 * Maps the router-core port to ctx.models / ctx.modelRegistry / authStorage.
 * This is the ONLY place (besides the thin pi-ai bridge) that touches omp
 * shapes; everything else in src/core stays host-agnostic.
 */

import type { HostModel, HostPorts } from "../core/host-ports";
import type { CandidateInfo, QuotaSnapshot, RouteTarget, ThinkingLevel } from "../core/types";
import type { AdapterState } from "./state";

/** How long a quota snapshot stays fresh before a background/request refresh re-fetches it. */
export const QUOTA_REFRESH_MS = 30_000;

/**
 * Effective quota-refresh cadence: `OMP_AUTO_ROUTER_QUOTA_REFRESH_MS` env
 * override, floored at 10s — provider usage reports update at minute
 * granularity, so polling faster buys nothing and wastes auth-chain calls.
 */
export function quotaRefreshMs(): number {
	const raw = process.env.OMP_AUTO_ROUTER_QUOTA_REFRESH_MS;
	if (raw === undefined) return QUOTA_REFRESH_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : QUOTA_REFRESH_MS;
}
import type { OmpExtensionApi, OmpExtensionContext, OmpModel } from "./omp-api";
import { redactSecrets } from "./redact";

export function createHostPorts(
	pi: OmpExtensionApi,
	ctx: OmpExtensionContext,
	state: AdapterState,
): HostPorts {
	return {
		listModels(): HostModel[] {
			return ctx.models.list().map(wrapModel);
		},

		resolveModel(spec: string): HostModel | undefined {
			const model = ctx.models.resolve(spec);
			return model ? wrapModel(model) : undefined;
		},

		async getApiKey(target: RouteTarget): Promise<string | undefined> {
			const model = ctx.models.resolve(`${target.provider}/${target.model}`);
			if (!model) return undefined;
			return ctx.modelRegistry.getApiKey(model);
		},

		isHealthy(target: RouteTarget): boolean {
			return ctx.models.resolve(`${target.provider}/${target.model}`) !== undefined;
		},

		async setModel(key: string): Promise<boolean> {
			const model = ctx.models.resolve(key);
			if (!model) return false;
			return pi.setModel(model);
		},

		setThinkingLevel(level: ThinkingLevel): void {
			pi.setThinkingLevel(level);
		},

		async fetchQuota(providers: string[]): Promise<QuotaSnapshot[]> {
			try {
				const reports = (await ctx.modelRegistry.authStorage.fetchUsageReports()) ?? [];
				const wanted = new Set(providers);
				const out: QuotaSnapshot[] = [];
				for (const report of reports as Array<{ provider?: string; fetchedAt?: number; limits?: unknown[] }>) {
					if (!report || typeof report !== "object" || !report.provider) continue;
					if (!wanted.has(report.provider)) continue;
					out.push({
						provider: report.provider,
						fetchedAt: report.fetchedAt ?? Date.now(),
						windows: ((report.limits ?? []) as Array<{
							id?: string;
							window?: { windowSeconds?: number; resetsAt?: number };
							amount?: { usedFraction?: number; used?: number; limit?: number };
						}>)
							.map((limit) => {
								const amount = limit.amount ?? {};
								const usedFraction =
									amount.usedFraction ??
									(amount.used !== undefined && amount.limit && amount.limit > 0
										? amount.used / amount.limit
										: undefined);
								if (usedFraction === undefined) return undefined;
								return {
									id: limit.id ?? "unknown",
									usedFraction,
									...(limit.window?.windowSeconds !== undefined
										? { windowSeconds: limit.window.windowSeconds }
										: {}),
									...(limit.window?.resetsAt !== undefined ? { resetsAt: limit.window.resetsAt } : {}),
								};
							})
							.filter((w): w is NonNullable<typeof w> => w !== undefined),
					});
				}
				return out;
			} catch (error) {
				state.eventLog.append({
					type: "error",
					at: Date.now(),
					error: redactSecrets(String(error)),
					what: "fetchQuota",
				});
				return [];
			}
		},

		notify(message: string, level: "info" | "warning" | "error"): void {
			try {
				ctx.ui.notify(message, level);
			} catch {
				// headless/no-ui contexts: notify is a no-op; never crash on it
			}
		},

		setStatus(text: string): void {
			try {
				ctx.ui.setStatus(text);
			} catch {
				// no-op in headless contexts
			}
		},

		setWidget(lines: string[]): void {
			try {
				if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget("auto-router", lines);
			} catch {
				// no-op when the host lacks the widget surface
			}
		},

		now(): number {
			return Date.now();
		},

		cwd(): string {
			return ctx.cwd;
		},
	};
}

function wrapModel(model: OmpModel): HostModel {
	return {
		provider: model.provider,
		id: model.id,
		key: `${model.provider}/${model.id}`,
		capabilities: {
			reasoning: model.reasoning ?? false,
			input: model.input ?? ["text"],
			contextWindow: model.contextWindow ?? 0,
			...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
			...(model.cost !== undefined ? { cost: model.cost } : {}),
		},
	};
}

/** Enrich a profile's tier targets into candidates using the host ports.
 * Dedupes by canonical "provider/model" key: cross-tier profiles list the same
 * model in more than one tier, so pooling all targets would otherwise yield
 * duplicate chain entries (and duplicate failover attempts). First occurrence
 * wins, preserving per-tier config order. */
export function enrichCandidates(
	host: HostPorts,
	targets: RouteTarget[],
	cooldowns?: ReadonlyMap<string, number>,
): CandidateInfo[] {
	const seen = new Set<string>();
	const out: CandidateInfo[] = [];
	const nowMs = Date.now();
	for (const target of targets) {
		const key = `${target.provider}/${target.model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const model = host.resolveModel(key);
		const cooldownUntil = cooldowns?.get(key);
		out.push({
			target,
			key,
			...(model ? { capabilities: model.capabilities } : {}),
			healthy: host.isHealthy(target),
			...(cooldownUntil !== undefined && cooldownUntil > nowMs ? { cooldownUntil } : {}),
		});
	}
	return out;
}
