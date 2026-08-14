import { describe, expect, test } from "bun:test";

import { BudgetTracker } from "../../src/core/budget-tracker";
import { CircuitBreaker } from "../../src/core/circuit-breaker";
import { DecisionStore } from "../../src/core/decision-store";
import { EventLog } from "../../src/core/event-log";
import { FeedbackTracker } from "../../src/core/feedback-tracker";
import { LatencyTracker } from "../../src/core/latency-tracker";
import { ProfileRegistry } from "../../src/core/profile-registry";
import type { QuotaSnapshot, RouterConfig } from "../../src/core/types";
import {
	buildRouterCompletions,
	formatClassifierRules,
	formatQuotaTable,
	runRouterCommand,
	SUBCOMMANDS,
	uviUnavailableNotice,
	type RouterCommandHost,
} from "../../src/runtime/commands";
import type { RouterRuntimeState } from "../../src/runtime/router-runtime";
import type { RoutingDecision } from "../../src/core/types";

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

function createState(config: RouterConfig = CONFIG): RouterRuntimeState {
	const budgets = new BudgetTracker({ load: () => undefined, save: () => {} }, { load: () => undefined, save: () => {} });
	for (const profile of Object.values(config.profiles)) {
		if (profile.budgets) budgets.mergeProfileLimits(profile.budgets);
	}
	return {
		registry: new ProfileRegistry(config),
		circuit: new CircuitBreaker(),
		latency: new LatencyTracker(),
		budgets,
		decisions: new DecisionStore(),
		eventLog: new EventLog("/dev/null"),
		cooldowns: new Map(),
		ratings: new FeedbackTracker({ load: () => undefined, save: () => {} }),
		sessionUsage: { calls: new Map(), cost: new Map(), thinking: new Map() },
		classifierOverrides: {},
		configErrors: [],
	};
}

interface FakeHost extends RouterCommandHost {
	notices: Array<{ message: string; level: string }>;
	switches: string[];
	profileEntries: string[];
	persisted: number;
	reloadCount: number;
	switchResult: boolean;
}

function createHost(state: RouterRuntimeState, overrides: Partial<RouterCommandHost> = {}): FakeHost {
	const host: FakeHost = {
		hostName: "Test",
		notices: [],
		switches: [],
		profileEntries: [],
		persisted: 0,
		reloadCount: 0,
		switchResult: true,
		notify(message, level) {
			host.notices.push({ message, level });
		},
		activeVirtualProfile: () => undefined,
		async setVirtualProfile(name) {
			host.switches.push(name);
			return host.switchResult;
		},
		appendProfileSwitch(name) {
			host.profileEntries.push(name);
		},
		async reloadConfig() {
			host.reloadCount++;
			return [];
		},
		doctorLines: () => ["✅ R1 — required capability present"],
		quotaAvailable: () => true,
		persistClassifierOverrides() {
			host.persisted++;
		},
		...overrides,
	};
	return host;
}

function decisionFixture(profile = "premium"): RoutingDecision {
	return {
		profile,
		tier: "standard",
		confidence: 0.9,
		target: { provider: "anthropic", model: "sonnet" },
		orderedCandidates: [
			{ provider: "anthropic", model: "sonnet" },
			{ provider: "deepseek", model: "flash" },
		],
		estimatedTokens: 42,
		reasoning: ["because reasons"],
		thinking: "medium",
		hints: {
			rulesTrace: [],
			budget: {},
			uvi: {},
			complexity: {
				tier: "standard",
				confidence: 0.9,
				reasons: [],
				signals: { estimatedTokens: 42, codeSignals: [], repairDebug: false, implementation: false, mixedPhase: false, multiStep: false, mechanicalOp: false, shortQa: false, stickyEscalation: false, hasImages: false },
			},
		},
		decidedAt: Date.now(),
	};
}

const output = (host: FakeHost) => host.notices.map((notice) => notice.message).join("\n");

describe("shared router commands", () => {
	test("status shows the active profile and last decision", async () => {
		const state = createState();
		state.lastDecision = { at: Date.now(), decision: decisionFixture(), cleanPrompt: "" };
		const host = createHost(state);
		await runRouterCommand("status", state, host);
		expect(output(host)).toContain("profile: premium (订阅优先)");
		expect(output(host)).toContain("last: standard → anthropic/sonnet (thinking=medium)");
		expect(output(host)).toContain("mode: A");
	});

	test("profiles marks the active profile and lists the rest", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("profiles", state, host);
		expect(output(host)).toContain("▶ premium");
		expect(output(host)).toContain(" economy");
	});

	test("host virtual model wins over registry default for the active profile", async () => {
		const state = createState();
		const host = createHost(state, { activeVirtualProfile: () => "economy" });
		await runRouterCommand("current", state, host);
		expect(output(host)).toBe("economy");
	});

	test("use switches profile through the host and persists the switch marker", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("use eco", state, host);
		expect(host.switches).toEqual(["economy"]);
		expect(host.profileEntries).toEqual(["economy"]);
		expect(state.registry.current()).toBe("economy");
		expect(output(host)).toContain("switched to profile: economy");
	});

	test("use rejects unknown profiles and reports host switch failures", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("use nope", state, host);
		expect(host.switches).toEqual([]);
		expect(output(host)).toContain("unknown profile: nope");

		host.switchResult = false;
		await runRouterCommand("use economy", state, host);
		expect(output(host)).toContain("model switch to auto-router/economy failed");
		expect(state.registry.current()).toBe("premium");
	});

	test("list and show render tier chains, thinking and budgets", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("list", state, host);
		expect(output(host)).toContain("standard (thinking=medium): anthropic/sonnet, deepseek/flash");
		await runRouterCommand("show economy", state, host);
		expect(output(host)).toContain("economy — 省钱");
		expect(output(host)).toContain("- deepseek/flash (per-token)");
		await runRouterCommand("show missing", state, host);
		expect(output(host)).toContain("unknown profile: missing");
	});

	test("explain renders tier, target, chain, token estimate, ratings and reasoning", async () => {
		const state = createState();
		state.lastDecision = { at: Date.now(), decision: decisionFixture(), cleanPrompt: "" };
		state.ratings.rate({ rating: "good", provider: "anthropic", model: "sonnet", profile: "premium", tier: "standard" });
		const host = createHost(state);
		await runRouterCommand("explain", state, host);
		expect(output(host)).toContain("profile=premium tier=standard (conf 0.90)");
		expect(output(host)).toContain("target: anthropic/sonnet");
		expect(output(host)).toContain("chain: anthropic/sonnet → deepseek/flash");
		expect(output(host)).toContain("tokens≈42");
		expect(output(host)).toContain("ratings anthropic/sonnet: 1👍/0👎 (100% good)");
		expect(output(host)).toContain("· because reasons");
	});

	test("doctor identifies the host, surfaces config errors and host capability rows", async () => {
		const state = createState();
		state.configErrors = ["broken.yml: bad profile"];
		const host = createHost(state, { hostName: "Pi", doctorLines: () => ["❌ R1 — required capability missing", "⚠️ UVI unavailable"] });
		await runRouterCommand("doctor", state, host);
		expect(output(host)).toContain("auto-router doctor (Pi)");
		expect(output(host)).toContain("config errors: broken.yml: bad profile");
		expect(output(host)).toContain("❌ R1 — required capability missing");
		expect(output(host)).toContain("⚠️ UVI unavailable");
		expect(output(host)).toContain("mode: A");
	});

	test("reload delegates to the host and reports warnings", async () => {
		const state = createState();
		const host = createHost(state, { reloadConfig: async () => ["user.yml: weird key"] });
		await runRouterCommand("reload", state, host);
		expect(host.notices.at(-1)).toEqual({ message: "config reloaded\nwarnings: user.yml: weird key", level: "warning" });
	});

	test("budget show/set/clear round-trips limits with usage percentages", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("budget show", state, host);
		expect(output(host)).toContain("anthropic: $0.00 / $10 (0%) monthly");
		await runRouterCommand("budget set deepseek 3", state, host);
		expect(output(host)).toContain("budget set: deepseek $3 daily");
		expect(state.budgets.limits().deepseek).toEqual({ amount: 3, monthly: false });
		await runRouterCommand("budget clear deepseek", state, host);
		expect(state.budgets.limits().deepseek).toBeUndefined();
		await runRouterCommand("budget set deepseek nope", state, host);
		expect(host.notices.at(-1)?.level).toBe("warning");
	});

	test("uvi toggles monitoring on hosts with quota reports", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("uvi disable", state, host);
		expect(state.uviEnabled).toBe(false);
		await runRouterCommand("uvi enable", state, host);
		expect(state.uviEnabled).toBe(true);
		await runRouterCommand("uvi refresh", state, host);
		expect(state.quotaCache).toEqual({ at: 0, data: [] });
	});

	test("uvi reports explicit degradation on hosts without quota capability", async () => {
		const state = createState();
		const host = createHost(state, { hostName: "Pi", quotaAvailable: () => false });
		await runRouterCommand("uvi show", state, host);
		expect(host.notices.at(-1)?.level).toBe("warning");
		expect(output(host)).toContain(uviUnavailableNotice("Pi"));
		await runRouterCommand("uvi enable", state, host);
		expect(output(host)).toContain("unavailable through Pi public interface");
	});

	test("shadow toggles and reports state", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("shadow enable", state, host);
		expect(state.shadowEnabled).toBe(true);
		await runRouterCommand("shadow", state, host);
		expect(output(host)).toContain("shadow mode: 🟢 enabled");
	});

	test("rate persists feedback against the settled target", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("rate good", state, host);
		expect(output(host)).toContain("no decision to rate yet");
		state.lastDecision = { at: Date.now(), decision: decisionFixture(), cleanPrompt: "" };
		await runRouterCommand("rate bad flaky output", state, host);
		const stats = state.ratings.statsFor("anthropic", "sonnet");
		expect(stats.total).toBe(1);
		expect(stats.goodFraction).toBe(0);
		expect(output(host)).toContain("rated bad — anthropic/sonnet (1 total, 0% good)");
	});

	test("usage paginates settled calls and appends the degradation notice without quota capability", async () => {
		const state = createState();
		for (let index = 0; index < 9; index++) state.sessionUsage.calls.set(`deepseek/flash-${index}`, 1);
		state.sessionUsage.cost.set("deepseek/flash-0", 0.5);
		const host = createHost(state, { hostName: "Pi", quotaAvailable: () => false });
		await runRouterCommand("usage", state, host);
		expect(output(host)).toContain("usage — page 1/2");
		expect(output(host)).toContain("deepseek: $0.5000 (session)");
		expect(output(host)).toContain("provider quota: no data from host interface");
		expect(output(host)).toContain(uviUnavailableNotice("Pi"));
		await runRouterCommand("usage 2", state, host);
		expect(output(host)).toContain("usage — page 2/2");
	});

	test("usage refreshes quota through the host and mirrors balances into the widget cache", async () => {
		const state = createState();
		const snapshot: QuotaSnapshot = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			windows: [{ id: "weekly", usedFraction: 0.25, resetsAt: Date.now() + 3_600_000 }],
		};
		let quotaFetches = 0;
		const host = createHost(state, {
			fetchQuota: async (providers) => {
				quotaFetches++;
				expect(providers).toContain("anthropic");
				return [snapshot];
			},
			fetchBalance: async (provider, endpoint) => {
				expect(provider).toBe("deepseek");
				expect(endpoint).toBe("https://api.deepseek.com/user/balance");
				return { currency: "USD", total: "9.99" };
			},
		});
		await runRouterCommand("usage", state, host);
		expect(quotaFetches).toBe(1);
		expect(state.quotaCache?.data).toEqual([snapshot]);
		expect(state.balanceCache?.deepseek).toEqual({ currency: "USD", total: "9.99" });
		expect(output(host)).toContain("provider quota:");
		expect(output(host)).toContain("balance");
		// Second call within the refresh window reuses the cache.
		await runRouterCommand("usage", state, host);
		expect(quotaFetches).toBe(1);
	});

	test("rules show/add/remove/reset edit and persist classifier overrides", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("rules", state, host);
		expect(output(host)).toContain("复杂度判定规则");
		await runRouterCommand("rules add mechanicalOp 同步数据", state, host);
		expect(state.classifierOverrides?.add?.mechanicalOp).toEqual(["同步数据"]);
		expect(host.persisted).toBe(1);
		await runRouterCommand("rules remove mechanicalOp 同步数据", state, host);
		expect(state.classifierOverrides?.add?.mechanicalOp).toEqual([]);
		await runRouterCommand("rules reset", state, host);
		expect(state.classifierOverrides).toEqual({});
		expect(host.persisted).toBe(3);
		await runRouterCommand("rules add bogusList 词", state, host);
		expect(output(host)).toContain("usage: /auto-router rules add");
	});

	test("formatClassifierRules renders builtin lists and override summary", () => {
		const rendered = formatClassifierRules({ add: { mechanicalOp: ["同步数据"] } });
		expect(rendered).toContain("mechanicalOp");
		expect(rendered).toContain("同步数据 (+)");
		expect(rendered).toContain("overrides: +1 添加");
	});

	test("help lists every subcommand with an example", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("help", state, host);
		for (const command of SUBCOMMANDS) {
			expect(output(host)).toContain(`/auto-router ${command.sub}`);
			expect(output(host)).toContain(command.example);
		}
	});

	test("useage remains an alias and unknown subcommands point at help", async () => {
		const state = createState();
		const host = createHost(state);
		await runRouterCommand("useage", state, host);
		expect(output(host)).toContain("usage — page 1/1");
		await runRouterCommand("bogus", state, host);
		expect(output(host)).toContain("unknown subcommand: bogus — run /auto-router help");
	});

	test("completions filter subcommands, actions, profiles and rule lists", () => {
		const state = createState();
		const all = buildRouterCompletions("", state);
		expect(all?.map((item) => item.label)).toEqual(SUBCOMMANDS.map((command) => command.sub));
		expect(buildRouterCompletions("expla", state)?.map((item) => item.label)).toEqual(["explain"]);
		expect(buildRouterCompletions("budget s", state)?.map((item) => item.label).sort()).toEqual(["set", "show"]);
		expect(buildRouterCompletions("use eco", state)).toEqual([
			{ value: "use economy ", label: "economy", description: "省钱" },
		]);
		expect(buildRouterCompletions("rules add mech", state)?.map((item) => item.label).sort()).toEqual(["mechanicalOp", "mechanicalOpWord"]);
		expect(buildRouterCompletions("rules ", state)?.map((item) => item.label).sort()).toEqual(["add", "remove", "reset", "show"]);
		// Known subcommand without nested completion yields nothing.
		expect(buildRouterCompletions("status ", state)).toBeNull();
	});

	test("formatQuotaTable renders plan and balance rows in display order", () => {
		const rows = formatQuotaTable(
			[{ provider: "kimi-code", fetchedAt: 0, windows: [
				{ id: "kimi-code:1", usedFraction: 0.5, resetsAt: Date.now() + 3_600_000 },
				{ id: "kimi-code:0", usedFraction: 0.25, resetsAt: Date.now() + 86_400_000 },
			] }],
			new Map([["deepseek", { currency: "USD", total: "12.34" }]]),
		);
		expect(rows[0]).toContain("provider");
		expect(rows.some((row) => row.includes("5h/weekly"))).toBe(true);
		expect(rows.some((row) => row.includes("balance") && row.includes("12.34 USD"))).toBe(true);
	});
});
