/**
 * Host-neutral provider dictionary — per-provider knowledge shared by both
 * adapters (Kimi window labels, DeepSeek balance endpoint, thinking caps).
 *
 * A target-level `balanceEndpoint` / `thinkingCap` in the profile config
 * overrides the dictionary default, so users can point at self-hosted or
 * gateway-provided APIs without code changes. Fetching is adapter-owned (the
 * host holds credentials); this module only resolves endpoints and parses
 * already-fetched payloads.
 */

import type { RouteTarget, ThinkingCap } from "../core/types";

/** A provider's remaining prepaid balance. */
export interface ProviderBalance {
	currency: string;
	total: string;
}

export interface ProviderDef {
	/** Human labels for quota-window ids (e.g. Kimi's `kimi-code:1`). */
	windowLabels?: Record<string, string>;
	/** Default balance endpoint; overridable per-target via `balanceEndpoint`. */
	balanceEndpoint?: string;
	/** Parse the endpoint's JSON payload into a balance; undefined on shape mismatch. */
	parseBalance?: (payload: unknown) => ProviderBalance | undefined;
	/** Thinking levels accepted per model id; overridable per-target via `thinkingCap`. */
	thinkingCaps?: Record<string, ThinkingCap>;
}

/** DeepSeek `{balance_infos: [{currency, total_balance}]}` shape. */
export function parseDeepSeekBalance(payload: unknown): ProviderBalance | undefined {
	if (!payload || typeof payload !== "object" || !("balance_infos" in payload) || !Array.isArray(payload.balance_infos)) return undefined;
	const [first] = payload.balance_infos;
	if (!first || typeof first !== "object" || !("currency" in first) || !("total_balance" in first)) return undefined;
	const { currency, total_balance: total } = first;
	if (typeof currency !== "string" || (typeof total !== "string" && typeof total !== "number")) return undefined;
	return { currency, total: String(total) };
}

/** Generic `{currency, total_balance|balance}` shape used by some gateways. */
export function parseGenericBalance(payload: unknown): ProviderBalance | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	const currency = record.currency;
	const total = record.total_balance ?? record.balance;
	if (typeof currency !== "string" || (typeof total !== "string" && typeof total !== "number")) return undefined;
	return { currency, total: String(total) };
}

/** Built-in provider knowledge; keyed by provider id. */
export const PROVIDER_REGISTRY: Record<string, ProviderDef> = {
	deepseek: {
		balanceEndpoint: "https://api.deepseek.com/user/balance",
		parseBalance: (payload) => parseDeepSeekBalance(payload) ?? parseGenericBalance(payload),
		// deepseek-v4-pro rejects `low`/`medium` effort; only high/max are valid.
		thinkingCaps: {
			"deepseek-v4-pro": { min: "high" },
		},
	},
	"kimi-code": {
		windowLabels: {
			"kimi-code:1": "5h",
			"kimi-code:0": "weekly",
		},
	},
};

/** Stable display order for the quota table; unknown providers sort last. */
export const PROVIDER_DISPLAY_ORDER: Record<string, number> = {
	"openai-codex": 0,
	deepseek: 1,
	"kimi-code": 2,
};

/**
 * Resolve the balance endpoint for a provider: a target-level
 * `balanceEndpoint` from the profile config wins over the registry default.
 */
export function resolveBalanceEndpoint(provider: string, targets: readonly RouteTarget[]): string | undefined {
	for (const target of targets) {
		if (target.provider === provider && target.balanceEndpoint !== undefined) return target.balanceEndpoint;
	}
	return PROVIDER_REGISTRY[provider]?.balanceEndpoint;
}

/**
 * Resolve the thinking cap for a target: a target-level `thinkingCap` from
 * the profile config wins over the registry default; unknown models are
 * unbounded (host decides).
 */
export function resolveThinkingCap(target: RouteTarget): ThinkingCap | undefined {
	if (target.thinkingCap !== undefined) return target.thinkingCap;
	return PROVIDER_REGISTRY[target.provider]?.thinkingCaps?.[target.model];
}

/**
 * Parse a balance payload for a provider: dictionary-specific shape first,
 * then the generic gateway shape.
 */
export function parseProviderBalance(provider: string, payload: unknown): ProviderBalance | undefined {
	return PROVIDER_REGISTRY[provider]?.parseBalance?.(payload) ?? parseGenericBalance(payload);
}
