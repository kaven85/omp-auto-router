/**
 * Provider registry — per-provider adapter knowledge that used to be
 * hard-coded in commands.ts (Kimi window labels, DeepSeek balance endpoint).
 *
 * A target-level `balanceEndpoint` in the profile config overrides the
 * registry default, so users can point at self-hosted or gateway-provided
 * balance APIs without code changes. Endpoints are expected to answer a
 * bearer-authenticated GET with either the DeepSeek shape
 * (`{balance_infos: [{currency, total_balance}]}`) or a generic
 * `{currency, total_balance}` shape.
 */

import type { RouteTarget, ThinkingCap } from "../core/types";
import type { AdapterState } from "./state";
import type { OmpExtensionContext, OmpModel } from "./omp-api";

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
function parseDeepSeekBalance(payload: unknown): ProviderBalance | undefined {
	if (!payload || typeof payload !== "object" || !("balance_infos" in payload) || !Array.isArray(payload.balance_infos)) return undefined;
	const [first] = payload.balance_infos;
	if (!first || typeof first !== "object" || !("currency" in first) || !("total_balance" in first)) return undefined;
	const { currency, total_balance: total } = first;
	if (typeof currency !== "string" || (typeof total !== "string" && typeof total !== "number")) return undefined;
	return { currency, total: String(total) };
}

/** Generic `{currency, total_balance|balance}` shape used by some gateways. */
function parseGenericBalance(payload: unknown): ProviderBalance | undefined {
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
 * Fetch a provider's remaining balance via its resolved endpoint.
 * Best-effort: any failure (no model, no key, network, shape) yields
 * undefined so callers can render "unknown". The request carries a 10s
 * timeout so a hung endpoint cannot block the caller.
 */
export async function fetchProviderBalance(
	ctx: OmpExtensionContext,
	state: AdapterState,
	provider: string,
	endpoint: string,
): Promise<ProviderBalance | undefined> {
	const model: OmpModel | undefined =
		[...state.modelsByKey.values(), ...ctx.models.list()].find((candidate) => candidate.provider === provider);
	if (!model) return undefined;
	try {
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) return undefined;
		const response = await fetch(endpoint, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		const parse = PROVIDER_REGISTRY[provider]?.parseBalance;
		return parse?.(payload) ?? parseGenericBalance(payload);
	} catch {
		return undefined;
	}
}
