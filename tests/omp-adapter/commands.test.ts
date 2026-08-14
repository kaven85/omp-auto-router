import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatQuotaTable } from "../../src/runtime/commands";
import { registerCommands } from "../../src/omp-adapter/commands";
import { createAdapterState } from "../../src/omp-adapter/state";
import type { RouterConfig } from "../../src/core/types";
import type { ClassifierOverrides } from "../../src/core/complexity-classifier";
import type { OmpExtensionContext } from "../../src/omp-adapter/omp-api";
import { MockExtensionApi } from "./mock-omp";

const CONFIG: RouterConfig = {
	active: "premium",
	aliases: { eco: ["economy"] },
	profiles: {
		premium: {
			description: "订阅优先",
			defaultTier: "standard",
			tiers: {
				standard: {
					thinking: "medium",
					targets: [
						{ provider: "anthropic", model: "sonnet" },
						{ provider: "deepseek", model: "flash", billing: "per-token" },
					],
				},
			},
			budgets: { anthropic: { amount: 10, monthly: true } },
		},
		economy: {
			description: "省钱",
			tiers: {
				standard: { targets: [{ provider: "deepseek", model: "flash", billing: "per-token" }] },
			},
		},
	},
};

describe("adapter commands", () => {
	function setup(): {
		api: MockExtensionApi;
		ctx: OmpExtensionContext;
		state: ReturnType<typeof createAdapterState>;
		invoke: (args: string) => Promise<void>;
		notifies: string[];
	} {
		const api = new MockExtensionApi();
		const notifies: string[] = [];
		const state = createAdapterState(CONFIG, mkdtempSync(join(tmpdir(), "ar-cmd-")), "/tmp/work");
		const ctx = api.makeCtx({
			ui: { hasUI: true, notify: (m) => notifies.push(m), setStatus: () => {} },
		});
		registerCommands(api, { getState: () => state, reloadConfig: async () => [], pi: api });
		return {
			api,
			ctx,
			state,
			invoke: async (args: string) => {
				const def = api.commands.get("auto-router");
				expect(def).toBeDefined();
				await def!.handler(args, ctx);
			},
			notifies,
		};
	}

	test("status shows active profile and no decision yet", async () => {
		const { invoke, notifies } = setup();
		await invoke("");
		expect(notifies.join("\n")).toContain("premium");
		expect(notifies.join("\n")).toContain("last: —");
	});

	test("profiles lists with active marker", async () => {
		const { invoke, notifies } = setup();
		await invoke("profiles");
		expect(notifies.join("\n")).toContain("▶ premium");
		expect(notifies.join("\n")).toContain("economy");
	});

	test("current prints the active profile", async () => {
		const { invoke, notifies } = setup();
		await invoke("current");
		expect(notifies[0]).toBe("premium");
	});

	test("use switches model and persists state", async () => {
		const { api, invoke, notifies } = setup();
		await invoke("use economy");
		expect(api.modelSwitches).toEqual(["auto-router/economy"]);
		expect(api.entries.some((e) => e.customType === "com.auto-router.v1.state" && (e.data as { profile?: string })?.profile === "economy")).toBe(true);
		expect(notifies.join("\n")).toContain("economy");
	});

	test("use supplies the model input capabilities needed by later TUI interactions", async () => {
		const { api, invoke } = setup();
		await invoke("use economy");

		expect(api.currentModel?.input?.includes("text")).toBe(true);
	});

	test("use resolves alias", async () => {
		const { api, invoke } = setup();
		await invoke("use eco");
		expect(api.modelSwitches).toEqual(["auto-router/economy"]);
	});

	test("use with unknown profile warns without switching", async () => {
		const { api, invoke, notifies } = setup();
		await invoke("use nope");
		expect(api.modelSwitches).toEqual([]);
		expect(notifies.join("\n")).toContain("unknown profile");
	});

	test("list shows tier chains of active profile", async () => {
		const { invoke, notifies } = setup();
		await invoke("list");
		expect(notifies.join("\n")).toContain("standard (thinking=medium): anthropic/sonnet, deepseek/flash");
	});

	test("show renders a profile in detail", async () => {
		const { invoke, notifies } = setup();
		await invoke("show economy");
		expect(notifies.join("\n")).toContain("economy");
		expect(notifies.join("\n")).toContain("deepseek/flash (per-token)");
	});

	test("explain renders the last decision reasoning", async () => {
		const { invoke, notifies, state } = setup();
		await invoke("explain");
		expect(notifies.join("\n")).toContain("no routing decision yet");
		// Simulate the stream handler having recorded a decision.
		state.lastDecision = {
			at: Date.now(),
			cleanPrompt: "hello",
			decision: {
				profile: "premium",
				tier: "standard",
				confidence: 0.9,
				target: { provider: "anthropic", model: "sonnet" },
				orderedCandidates: [
					{ provider: "anthropic", model: "sonnet" },
					{ provider: "deepseek", model: "flash" },
				],
				estimatedTokens: 10,
				reasoning: ["shortcut @swe", "tier=standard"],
				hints: {} as never,
				decidedAt: Date.now(),
			},
		};
		notifies.length = 0;
		await invoke("explain");
		const out = notifies.join("\n");
		expect(out).toContain("profile=premium tier=standard");
		expect(out).toContain("anthropic/sonnet");
		expect(out).toContain("shortcut @swe");
	});

	test("doctor renders the probe matrix", async () => {
		const { invoke, notifies } = setup();
		await invoke("doctor");
		const out = notifies.join("\n");
		expect(out).toContain("auto-router doctor");
		expect(out).toContain("H1 registerProvider/stream");
		expect(out).toContain("mode: A");
	});

	test("budget set/show/clear round-trips limits", async () => {
		const { invoke, notifies, state } = setup();
		await invoke("budget show");
		expect(notifies.join("\n")).toContain("anthropic: $0.00 / $10 (0%) monthly");

		notifies.length = 0;
		await invoke("budget set google 20 monthly");
		expect(state.budgets.limits().google).toEqual({ amount: 20, monthly: true });
		expect(notifies.join("\n")).toContain("budget set: google $20 monthly");

		notifies.length = 0;
		await invoke("budget show");
		expect(notifies.join("\n")).toContain("google: $0.00 / $20");

		notifies.length = 0;
		await invoke("budget clear google monthly");
		expect(state.budgets.limits().google).toBeUndefined();
		expect(notifies.join("\n")).toContain("budget cleared");
	});

	test("uvi toggle and shadow toggle", async () => {
		const { invoke, notifies, state } = setup();
		await invoke("uvi disable");
		expect(state.uviEnabled).toBe(false);
		await invoke("uvi enable");
		expect(state.uviEnabled).toBe(true);
		await invoke("shadow enable");
		expect(state.shadowEnabled).toBe(true);
		expect(notifies.join("\n")).toContain("shadow mode enabled");
		await invoke("shadow disable");
		expect(state.shadowEnabled).toBe(false);
	});

	test("rate records a rating against the last decision", async () => {
		const { invoke, notifies, state } = setup();
		await invoke("rate good");
		expect(notifies.join("\n")).toContain("no decision to rate yet");
		state.lastDecision = {
			at: Date.now(),
			cleanPrompt: "hello",
			decision: {
				profile: "premium",
				tier: "standard",
				confidence: 0.9,
				target: { provider: "anthropic", model: "sonnet" },
				orderedCandidates: [{ provider: "anthropic", model: "sonnet" }],
				estimatedTokens: 10,
				reasoning: [],
				hints: {} as never,
				decidedAt: Date.now(),
			},
		};
		notifies.length = 0;
		await invoke("rate good fast and accurate");
		expect(state.ratings.statsFor("anthropic", "sonnet").total).toBe(1);
		expect(notifies.join("\n")).toContain("anthropic/sonnet");
	});

	test("usage fetches provider quota from the omp auth chain when cache is empty", async () => {
		const { api, state, notifies } = setup();
		let fetched = 0;
		const newCtx = api.makeCtx({
			ui: { hasUI: true, notify: (m) => notifies.push(m), setStatus: () => {} },
			modelRegistry: {
				getApiKey: async () => "test-key",
				authStorage: {
					fetchUsageReports: async () => {
						fetched += 1;
						const resetsAt = Date.now() + 3_600_000;
						return [
							{
								provider: "anthropic",
								fetchedAt: Date.now(),
								limits: [
									{
										id: "daily",
										window: { windowSeconds: 86_400, resetsAt },
										amount: { usedFraction: 0.34 },
									},
								],
							},
						];
					},
				},
			},
		});
		const def = api.commands.get("auto-router");
		expect(def).toBeDefined();
		await def!.handler("usage", newCtx);
		const out = notifies.join("\n");
		expect(fetched).toBe(1);
		expect(out).toContain("provider quota:");
		expect(out).toContain("deepseek");
		expect(out).toContain("balance");
		expect(out).toContain("anthropic");
		expect(out).toContain("daily");
		expect(out).toContain("66.0%");
		expect(state.quotaCache.data.length).toBe(1);
		const snapshot = state.quotaCache.data[0];
		if (!snapshot) throw new Error("expected snapshot");
		expect(snapshot.provider).toBe("anthropic");
		const firstWindow = snapshot.windows[0];
		if (!firstWindow) throw new Error("expected window");
		expect(firstWindow.id).toBe("daily");
	});

	test("formats quota output into the consolidated usage table", () => {
		const resetsAt = Date.now() + 3_600_000;
		expect(
			formatQuotaTable(
				[
					{
						provider: "openai-codex",
						fetchedAt: Date.now(),
						windows: [{ id: "openai-codex:primary", usedFraction: 0.06, resetsAt }],
					},
					{
						provider: "kimi-code",
						fetchedAt: Date.now(),
						windows: [
							{ id: "kimi-code:0", usedFraction: 0.99, resetsAt },
							{ id: "kimi-code:1", usedFraction: 0.29, resetsAt },
						],
					},
				],
				new Map([["deepseek", { currency: "CNY", total: "65.84" }]]),
				() => "1h 0m",
			),
		).toEqual([
			"provider      window                type        remaining    balance      resets in",
			"------------  --------------------  -------  ------------  ---------  -------------",
			"openai-codex  openai-codex:primary  plan            94.0%          -          1h 0m",
			"deepseek      n/a                   balance             -  65.84 CNY              -",
			"kimi-code     5h/weekly             plan     71.0% / 1.0%          -  1h 0m / 1h 0m",
		]);
	});

	test("not-ready state when boot hasn't run", async () => {
		const api = new MockExtensionApi();
		const notifies: string[] = [];
		const ctx = api.makeCtx({ ui: { hasUI: true, notify: (m) => notifies.push(m), setStatus: () => {} } });
		registerCommands(api, { getState: () => undefined, reloadConfig: async () => [], pi: api });
		const def = api.commands.get("auto-router")!;
		await def.handler("", ctx);
		expect(notifies.join("\n")).toContain("not ready");
	});

	test("help lists every subcommand with a description and example", async () => {
		const { invoke, notifies } = setup();
		await invoke("help");
		const out = notifies.join("\n");
		// Every implemented subcommand appears with usage + example.
		expect(out).toContain("/auto-router use <profile|alias> — 切换 profile");
		expect(out).toContain("例: /auto-router use economy");
		expect(out).toContain("/auto-router budget show|set <p> <usd> [monthly]|clear <p>");
		expect(out).toContain("例: /auto-router budget set google 20 monthly");
		expect(out).toContain("/auto-router rate good|bad [comment]");
		expect(out).toContain("例: /auto-router rate good");
		expect(out).toContain("请求内钉层");
	});

	test("useage works as an alias for usage", async () => {
		const { invoke, notifies } = setup();
		await invoke("useage");
		expect(notifies.join("\n")).toContain("usage — page 1/1");
	});

	test("unknown subcommand points at help", async () => {
		const { invoke, notifies } = setup();
		await invoke("bogus");
		expect(notifies.join("\n")).toContain("/auto-router help");
	});
	test("completions: empty prefix lists every subcommand with description + usage hint", () => {
		const { api } = setup();
		const items = api.commands.get("auto-router")!.getArgumentCompletions!("");
		expect(items).not.toBeNull();
		const labels = items!.map((i) => i.label);
		for (const sub of ["status", "use", "doctor", "budget", "uvi", "shadow", "rate", "help"]) {
			expect(labels).toContain(sub);
		}
		expect(items!.every((i) => i.value.endsWith(" "))).toBe(true);
		expect(items!.find((i) => i.label === "doctor")!.description).toContain("宿主能力探测");
		expect(items!.find((i) => i.label === "use")!.hint).toBe("<profile|alias>");
		expect(items!.find((i) => i.label === "budget")!.hint).toBe("show|set <p> <usd> [monthly]|clear <p>");
	});

	test("completions: partial subcommand filters by prefix", () => {
		const { api } = setup();
		const items = api.commands.get("auto-router")!.getArgumentCompletions!("expla");
		expect(items!.map((i) => i.label)).toEqual(["explain"]);
		expect(items![0]!.value).toBe("explain ");
		expect(api.commands.get("auto-router")!.getArgumentCompletions!("bogus")).toBeNull();
	});

	test("completions: action enums complete one level past the subcommand", () => {
		const { api } = setup();
		const budget = api.commands.get("auto-router")!.getArgumentCompletions!("budget s");
		expect(budget!.map((i) => i.label).sort()).toEqual(["set", "show"]);
		expect(budget!.find((i) => i.label === "set")!.value).toBe("budget set ");
		expect(budget!.find((i) => i.label === "set")!.hint).toBe("<provider> <usd> [monthly]");
		expect(api.commands.get("auto-router")!.getArgumentCompletions!("uvi en")).toEqual([
			{ value: "uvi enable ", label: "enable", description: "开启 UVI 监控" },
		]);
		// Past the action token there is nothing to complete.
		expect(api.commands.get("auto-router")!.getArgumentCompletions!("budget set 10")).toBeNull();
		// Known subcommand without nested args offers no second-level completion.
		expect(api.commands.get("auto-router")!.getArgumentCompletions!("status ")).toBeNull();
	});

	test("completions: use/show complete profile names", () => {
		const { api } = setup();
		const use = api.commands.get("auto-router")!.getArgumentCompletions!("use eco");
		expect(use).toEqual([{ value: "use economy ", label: "economy", description: "省钱" }]);
		const show = api.commands.get("auto-router")!.getArgumentCompletions!("show ");
		expect(show!.map((i) => i.label).sort()).toEqual(["economy", "premium"]);
		expect(show!.find((i) => i.label === "premium")!.hint).toBe("当前激活");
	});

	test("rules view shows every editable list with tier and weight", async () => {
		const { invoke, notifies } = setup();
		await invoke("rules");
		const out = notifies.join("\n");
		for (const list of ["multiStep", "multiStepWord", "repairDebug", "mechanicalOp", "mechanicalOpWord", "implementation", "implementationWord"]) {
			expect(out).toContain(list);
		}
		expect(out).toContain("→ complex");
		expect(out).toContain("→ standard");
		expect(out).toContain("→ simple");
		expect(out).toContain("refactor");
		expect(out).toContain("提交代码");
		expect(out).toContain("内置信号（不可编辑）");
		expect(out).toContain("@fast→simple");
		// No overrides yet → no overrides summary line.
		expect(out).not.toContain("overrides: +");
	});

	test("rules add persists keywords and marks them in the view", async () => {
		const { invoke, notifies, state } = setup();
		await invoke("rules add mechanicalOp 同步数据 部署上线");
		expect(notifies.join("\n")).toContain("added → mechanicalOp: 同步数据, 部署上线");
		expect(state.classifierOverrides.add?.mechanicalOp).toEqual(["同步数据", "部署上线"]);
		// Persisted to classifier-rules.json in the state dir.
		expect(state.stateStore.readJson<ClassifierOverrides>("classifier-rules.json")).toEqual(state.classifierOverrides);
		await invoke("rules");
		const out = notifies.join("\n");
		expect(out).toContain("同步数据 (+)");
		expect(out).toContain("overrides: +2 添加");
		// Adding the same keyword again is a no-op skip.
		await invoke("rules add mechanicalOp 同步数据");
		expect(notifies.at(-1)).toContain("skipped (无变化): 同步数据");
	});

	test("rules remove hides builtins and re-adding cancels the removal", async () => {
		const { invoke, notifies, state } = setup();
		await invoke("rules remove multiStep refactor");
		expect(notifies.join("\n")).toContain("removed → multiStep: refactor");
		expect(state.classifierOverrides.remove?.multiStep).toEqual(["refactor"]);
		await invoke("rules");
		const view = notifies.at(-1)!;
		expect(view).not.toContain("refactor,");
		expect(view).toContain("−1 移除");
		// Re-adding a removed builtin cancels the removal instead of duplicating.
		await invoke("rules add multiStep refactor");
		expect(state.classifierOverrides.add?.multiStep ?? []).toEqual([]);
		expect(state.classifierOverrides.remove?.multiStep).toEqual([]);
	});

	test("rules remove of a user-added keyword drops the addition", async () => {
		const { invoke, state } = setup();
		await invoke("rules add mechanicalOp 同步数据");
		await invoke("rules remove mechanicalOp 同步数据");
		expect(state.classifierOverrides.add?.mechanicalOp).toEqual([]);
		expect(state.classifierOverrides.remove?.mechanicalOp ?? []).toEqual([]);
	});

	test("rules reset clears all overrides", async () => {
		const { invoke, notifies, state } = setup();
		await invoke("rules add multiStep 造轮子");
		await invoke("rules reset");
		expect(notifies.at(-1)).toContain("已还原为内置判定规则");
		expect(state.classifierOverrides).toEqual({});
		expect(state.stateStore.readJson<ClassifierOverrides>("classifier-rules.json")).toEqual({});
	});

	test("rules validates list name and keyword presence", async () => {
		const { invoke, notifies } = setup();
		await invoke("rules add bogusList 词");
		expect(notifies.at(-1)).toContain("usage: /auto-router rules add");
		await invoke("rules add mechanicalOp");
		expect(notifies.at(-1)).toContain("usage: /auto-router rules add");
		await invoke("rules frobnicate");
		expect(notifies.at(-1)).toContain("unknown rules action");
	});

	test("completions: rules completes actions then list names", () => {
		const { api } = setup();
		const actions = api.commands.get("auto-router")!.getArgumentCompletions!("rules ");
		expect(actions!.map((i) => i.label).sort()).toEqual(["add", "remove", "reset", "show"]);
		const lists = api.commands.get("auto-router")!.getArgumentCompletions!("rules add ");
		expect(lists!.map((i) => i.label)).toEqual(["multiStep", "multiStepWord", "repairDebug", "mechanicalOp", "mechanicalOpWord", "implementation", "implementationWord"]);
		expect(lists!.find((i) => i.label === "multiStep")!.hint).toContain("→ complex");
		const filtered = api.commands.get("auto-router")!.getArgumentCompletions!("rules remove mech");
		expect(filtered!.map((i) => i.label).sort()).toEqual(["mechanicalOp", "mechanicalOpWord"]);
		expect(filtered![0]!.value).toBe("rules remove mechanicalOp ");
	});
});

