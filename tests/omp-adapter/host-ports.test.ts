import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostPorts, enrichCandidates } from "../../src/omp-adapter/host-ports";
import { createAdapterState } from "../../src/omp-adapter/state";
import type { RouteTarget } from "../../src/core/types";
import { MockExtensionApi } from "./mock-omp";

const CONFIG = {
	active: "p",
	profiles: {
		p: {
			tiers: {
				standard: { targets: [{ provider: "anthropic", model: "sonnet" }] },
			},
		},
	},
};

function setup() {
	const api = new MockExtensionApi();
	const dir = mkdtempSync(join(tmpdir(), "ar-host-ports-"));
	const state = createAdapterState(CONFIG, dir, "/tmp/work");
	return { api, state, dir };
}

function withReports(reports: unknown[] | (() => never)) {
	return {
		getApiKey: async () => "k",
		authStorage: {
			fetchUsageReports:
				typeof reports === "function" ? reports : async () => reports,
		},
	};
}

describe("fetchQuota", () => {
	test("uses usedFraction directly when provided", async () => {
		const { api, state, dir } = setup();
		const ctx = api.makeCtx({
			modelRegistry: withReports([
				{ provider: "anthropic", fetchedAt: 1_000, limits: [{ id: "5h", amount: { usedFraction: 0.42 }, window: { windowSeconds: 18_000, resetsAt: 9_999 } }] },
			]),
		});
		const host = createHostPorts(api, ctx, state);
		const out = await host.fetchQuota(["anthropic"]);
		expect(out).toEqual([
			{
				provider: "anthropic",
				fetchedAt: 1_000,
				windows: [{ id: "5h", usedFraction: 0.42, windowSeconds: 18_000, resetsAt: 9_999 }],
			},
		]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("derives usedFraction from used/limit when the fraction is absent", async () => {
		const { api, state, dir } = setup();
		const ctx = api.makeCtx({
			modelRegistry: withReports([
				{ provider: "google", limits: [{ id: "day", amount: { used: 30, limit: 60 } }] },
			]),
		});
		const host = createHostPorts(api, ctx, state);
		const out = await host.fetchQuota(["google"]);
		expect(out[0]?.windows).toEqual([{ id: "day", usedFraction: 0.5 }]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("drops windows without any usable amount and providers not requested", async () => {
		const { api, state, dir } = setup();
		const ctx = api.makeCtx({
			modelRegistry: withReports([
				{ provider: "anthropic", limits: [{ id: "no-amount", amount: {} }, { amount: { used: 5 } }] },
				{ provider: "deepseek", limits: [{ id: "x", amount: { usedFraction: 0.1 } }] },
			]),
		});
		const host = createHostPorts(api, ctx, state);
		const out = await host.fetchQuota(["anthropic"]);
		expect(out).toEqual([
			{ provider: "anthropic", fetchedAt: out[0]!.fetchedAt, windows: [] },
		]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a throwing auth storage degrades to [] and logs the error", async () => {
		const { api, state, dir } = setup();
		const ctx = api.makeCtx({
			modelRegistry: withReports(() => {
				throw new Error("auth down");
			}),
		});
		const host = createHostPorts(api, ctx, state);
		const out = await host.fetchQuota(["anthropic"]);
		expect(out).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("enrichCandidates", () => {
	const TARGETS: RouteTarget[] = [
		{ provider: "anthropic", model: "sonnet" },
		{ provider: "anthropic", model: "sonnet" }, // duplicate across tiers
		{ provider: "missing", model: "ghost" },
	];

	test("dedupes by provider/model and keeps first occurrence", () => {
		const { api, state, dir } = setup();
		api.models = [{ provider: "anthropic", id: "sonnet", api: "anthropic-messages" }];
		const ctx = api.makeCtx();
		const host = createHostPorts(api, ctx, state);
		const out = enrichCandidates(host, TARGETS);
		expect(out.map((c) => c.key)).toEqual(["anthropic/sonnet", "missing/ghost"]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("marks resolvable models healthy and carries capabilities; unresolved are unhealthy", () => {
		const { api, state, dir } = setup();
		api.models = [
			{
				provider: "anthropic",
				id: "sonnet",
				api: "anthropic-messages",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200_000,
			},
		];
		const ctx = api.makeCtx();
		const host = createHostPorts(api, ctx, state);
		const out = enrichCandidates(host, TARGETS);
		expect(out[0]?.healthy).toBe(true);
		expect(out[0]?.capabilities?.reasoning).toBe(true);
		expect(out[0]?.capabilities?.contextWindow).toBe(200_000);
		expect(out[1]?.healthy).toBe(false);
		expect(out[1]?.capabilities).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});
