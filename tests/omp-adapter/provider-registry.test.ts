import { describe, expect, test } from "bun:test";

import {
	PROVIDER_REGISTRY,
	resolveBalanceEndpoint,
	resolveThinkingCap,
} from "../../src/runtime/provider-dictionary";
import { fetchOmpBalance } from "../../src/omp-adapter/balance";
import type { RouteTarget } from "../../src/core/types";

function target(provider: string, balanceEndpoint?: string): RouteTarget {
	return {
		provider,
		model: "m",
		billing: "per-token",
		...(balanceEndpoint !== undefined ? { balanceEndpoint } : {}),
	};
}

describe("provider registry", () => {
	test("target-level balanceEndpoint overrides the registry default", () => {
		expect(resolveBalanceEndpoint("deepseek", [target("deepseek", "https://gw.example/balance")])).toBe(
			"https://gw.example/balance",
		);
	});

	test("falls back to the registry default endpoint", () => {
		expect(resolveBalanceEndpoint("deepseek", [target("deepseek")])).toBe(
			"https://api.deepseek.com/user/balance",
		);
	});

	test("providers without balance support resolve to undefined", () => {
		expect(resolveBalanceEndpoint("anthropic", [target("anthropic")])).toBeUndefined();
	});

	test("registry default thinking cap resolves for known models", () => {
		expect(resolveThinkingCap({ provider: "deepseek", model: "deepseek-v4-pro" })).toEqual({ min: "high" });
	});

	test("target-level thinkingCap overrides the registry default", () => {
		expect(
			resolveThinkingCap({
				provider: "deepseek",
				model: "deepseek-v4-pro",
				thinkingCap: { min: "medium", max: "max" },
			}),
		).toEqual({ min: "medium", max: "max" });
	});

	test("unknown models resolve to no cap", () => {
		expect(resolveThinkingCap({ provider: "deepseek", model: "deepseek-v4-flash" })).toBeUndefined();
		expect(resolveThinkingCap({ provider: "anthropic", model: "claude-opus" })).toBeUndefined();
	});

	test("deepseek parser accepts both deepseek and generic shapes", () => {
		const parse = PROVIDER_REGISTRY.deepseek?.parseBalance;
		expect(parse?.({ balance_infos: [{ currency: "CNY", total_balance: "65.84" }] })).toEqual({
			currency: "CNY",
			total: "65.84",
		});
		expect(parse?.({ currency: "USD", balance: 12.5 })).toEqual({ currency: "USD", total: "12.5" });
		expect(parse?.({ unexpected: true })).toBeUndefined();
	});

	test("fetchOmpBalance posts the bearer key and parses the payload", async () => {
		const originalFetch = globalThis.fetch;
		let seenAuth: string | undefined;
		globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
			seenAuth = init?.headers?.Authorization;
			return new Response(JSON.stringify({ currency: "USD", total_balance: "9.99" }), { status: 200 });
		}) as typeof fetch;
		try {
			const ctx = {
				models: { list: () => [{ provider: "acme", id: "m" }] },
				modelRegistry: { getApiKey: async () => "sk-test" },
			};
			const state = { modelsByKey: new Map() };
			const balance = await fetchOmpBalance(
				ctx as never,
				state as never,
				"acme",
				"https://gw.example/balance",
			);
			expect(balance).toEqual({ currency: "USD", total: "9.99" });
			expect(seenAuth).toBe("Bearer sk-test");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("fetchOmpBalance degrades to undefined on http failure", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
		try {
			const ctx = {
				models: { list: () => [{ provider: "acme", id: "m" }] },
				modelRegistry: { getApiKey: async () => "sk-test" },
			};
			const balance = await fetchOmpBalance(
				ctx as never,
				{ modelsByKey: new Map() } as never,
				"acme",
				"https://gw.example/balance",
			);
			expect(balance).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
