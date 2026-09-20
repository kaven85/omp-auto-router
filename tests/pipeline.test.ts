import { describe, expect, test } from "bun:test";

import { route } from "../src/core/pipeline";
import type { PipelineDeps } from "../src/core/pipeline";
import { BudgetTracker } from "../src/core/budget-tracker";
import type { BudgetLimit, BudgetUsage } from "../src/core/types";
import { CircuitBreaker } from "../src/core/circuit-breaker";
import { LatencyTracker } from "../src/core/latency-tracker";
import { ProfileRegistry } from "../src/core/profile-registry";
import type {
	CandidateInfo,
	QuotaSnapshot,
	RouterConfig,
	RouteTarget,
} from "../src/core/types";

const NOW = new Date("2026-08-04T12:00:00");

const CONFIG: RouterConfig = {
	active: "premium",
	aliases: { eco: ["economy"] },
	profiles: {
		premium: {
			description: "订阅优先",
			defaultTier: "standard",
			tiers: {
				trivial: {
					thinking: "low",
					targets: [
						{ provider: "deepseek", model: "flash", billing: "per-token" },
					],
				},
				simple: {
					thinking: "low",
					targets: [
						{ provider: "deepseek", model: "flash", billing: "per-token" },
					],
				},
				standard: {
					thinking: "medium",
					targets: [
						{ provider: "anthropic", model: "sonnet" },
						{ provider: "deepseek", model: "flash", billing: "per-token" },
					],
				},
				complex: {
					thinking: "high",
					targets: [
						{ provider: "anthropic", model: "opus" },
						{ provider: "google", model: "gemini-pro", billing: "per-token" },
					],
				},
			},
			budgets: {
				anthropic: { amount: 10, monthly: true },
			},
		},
		economy: {
			defaultTier: "standard",
			tiers: {
				standard: {
					targets: [{ provider: "deepseek", model: "flash", billing: "per-token" }],
				},
			},
		},
	},
};

function inMemoryStore<T>(): { store: { load: () => T | undefined; save: (v: T) => void } } {
	const state = { data: undefined as T | undefined };
	return {
		store: {
			load: () => state.data,
			save: (v: T) => {
				state.data = v;
			},
		},
	};
}

function makeDeps(overrides?: Partial<PipelineDeps>): PipelineDeps {
	const usage = inMemoryStore<BudgetUsage>();
	const limits = inMemoryStore<Record<string, BudgetLimit>>();
	return {
		registry: new ProfileRegistry(CONFIG, { cwd: "/tmp/work" }),
		circuit: new CircuitBreaker(),
		latency: new LatencyTracker(),
		budgets: new BudgetTracker(usage.store, limits.store),
		...(overrides ?? {}),
	};
}

const CAPS: CandidateInfo["capabilities"] = {
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200_000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function targetCandidates(targets: RouteTarget[]): CandidateInfo[] {
	return targets.map((target) => ({
		target,
		key: `${target.provider}/${target.model}`,
		capabilities: CAPS,
		healthy: true,
	}));
}

function allTargets(cfg: RouterConfig): RouteTarget[] {
	const seen = new Set<string>();
	const out: RouteTarget[] = [];
	for (const profile of Object.values(cfg.profiles)) {
		for (const tier of Object.values(profile.tiers)) {
			for (const t of tier.targets) {
				if (!seen.has(`${t.provider}/${t.model}`)) {
					seen.add(`${t.provider}/${t.model}`);
					out.push(t);
				}
			}
		}
	}
	return out;
}

function quotaFor(provider: string, usedFraction: number, windowSeconds: number, resetsAt: number): QuotaSnapshot {
	return { provider, fetchedAt: NOW.getTime(), windows: [{ id: "5h", usedFraction, windowSeconds, resetsAt }] };
}

describe("pipeline", () => {
	test("@reasoning pins to complex tier and strips the shortcut", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "@reasoning prove there are infinitely many primes",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.cleanPrompt).toBe("prove there are infinitely many primes");
		expect(result.decision.profile).toBe("premium");
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "opus" });
		expect(result.decision.thinking).toBe("high");
		expect(result.decision.hints.shortcut).toBe("@reasoning");
	});

	test("falls back to another tier when every target in the resolved tier is unavailable", () => {
		const config: RouterConfig = {
			active: "company",
			profiles: {
				company: {
					defaultTier: "standard",
					tiers: {
						standard: { targets: [{ provider: "newapi", model: "deepseek-v4-flash" }] },
						complex: { thinking: "high", targets: [{ provider: "newapi", model: "gpt-5.6-sol" }] },
					},
				},
			},
		};
		const candidates = targetCandidates(allTargets(config)).map(candidate =>
			candidate.key === "newapi/deepseek-v4-flash" ? { ...candidate, healthy: false } : candidate,
		);
		const result = route(
			{
				rawPrompt: "implement this feature",
				hasImages: false,
				candidates,
				quota: {},
				now: NOW,
			},
			makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) }),
		);
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.target).toEqual({ provider: "newapi", model: "gpt-5.6-sol" });
		expect(result.decision.reasoning.join("\n")).toContain("availability fallback to complex");
	});

	test("selected target thinking overrides the tier thinking level", () => {
		const config: RouterConfig = {
			active: "company",
			profiles: {
				company: {
					defaultTier: "complex",
					tiers: {
						complex: {
							thinking: "high",
							targets: [
								{ provider: "anthropic", model: "opus", thinking: "low" },
								{ provider: "google", model: "gemini-pro" },
							],
						},
					},
				},
			},
		};
		const result = route(
			{
				rawPrompt: "@reasoning prove there are infinitely many primes",
				hasImages: false,
				candidates: targetCandidates(allTargets(config)),
				quota: {},
				now: NOW,
			},
			makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) }),
		);
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "opus", thinking: "low" });
		expect(result.decision.thinking).toBe("low");
	});

	test("classifierOverrides from deps steer the resolved tier", () => {
		const candidates = targetCandidates(allTargets(CONFIG));
		const baseline = route(
			{ rawPrompt: "帮我造个轮子", hasImages: false, candidates, quota: {}, now: NOW },
			makeDeps(),
		);
		expect(baseline.decision.tier).not.toBe("complex");
		const overridden = route(
			{ rawPrompt: "帮我造个轮子", hasImages: false, candidates, quota: {}, now: NOW },
			makeDeps({ classifierOverrides: { add: { multiStep: ["造个轮子"] } } }),
		);
		expect(overridden.decision.tier).toBe("complex");
		expect(overridden.decision.reasoning.join(" ")).toContain("multi-step");
	});

	test("@profile alias override switches profile per-request", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "@profile:eco fix this typo",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.profile).toBe("economy");
		expect(result.decision.orderedCandidates).toEqual([
			{ provider: "deepseek", model: "flash", billing: "per-token" },
		]);
	});

	test("low confidence falls back to defaultTier", () => {
		const deps = makeDeps({ confidenceThreshold: 0.99 });
		const result = route(
			{
				rawPrompt: "hello there",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("standard");
		expect(result.decision.reasoning.join("\n")).toContain("defaultTier");
	});

	test("estimatedTokens from adapter overrides prompt-length heuristic", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "short",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				estimatedTokens: 150_000, // force epic context despite short prompt
				now: NOW,
			},
			deps,
		);
		expect(result.decision.estimatedTokens).toBe(150_000);
	});

	test("estimatedTokens falls back to prompt length when omitted", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "short",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.estimatedTokens).toBeGreaterThan(0);
		expect(result.decision.estimatedTokens).toBeLessThan(10);
	});

	test("@long excludes small-context candidates", () => {
		const deps = makeDeps({
			globalRules: [{ type: "force-constraint", constraint: { minContextWindow: 100_000 } }],
		});
		// deepseek/flash (standard tier's second target) has a small context window
		const candidates = targetCandidates(allTargets(CONFIG)).map((c) =>
			c.key === "deepseek/flash" ? { ...c, capabilities: { ...CAPS, contextWindow: 60_000 } } : c,
		);
		const result = route(
			{
				rawPrompt: "@swe migrate this service",
				hasImages: false,
				candidates,
				quota: {},
				now: NOW,
			},
			deps,
		);
		// standard tier pinned by @swe; deepseek (60k) excluded by the 100k floor
		expect(result.decision.orderedCandidates).toEqual([{ provider: "anthropic", model: "sonnet" }]);
		expect(result.decision.reasoning.join("\n")).toContain("excluded deepseek/flash");
	});

	test("reasoning-required task escalates when resolved tier has no reasoning candidate", () => {
		const deps = makeDeps({ globalRules: [{ type: "force-constraint", constraint: { reasoning: true } }] });
		// deepseek/flash is the only trivial-tier candidate and is non-reasoning;
		// anthropic/sonnet (standard tier) is reasoning. A trivial-classified
		// task forced to reason must escalate standard, not serve deepseek.
		const candidates = targetCandidates(allTargets(CONFIG)).map((c) =>
			c.key === "deepseek/flash"
				? { ...c, capabilities: { ...CAPS, reasoning: false } }
				: { ...c, capabilities: { ...CAPS, reasoning: c.key === "anthropic/sonnet" } },
		);
		const result = route(
			{
				rawPrompt: "把标题改成红色", // short general prompt → classifier says trivial
				hasImages: false,
				candidates,
				quota: {},
				now: NOW,
			},
			deps,
		);
		// escalated away from trivial (non-reasoning) to standard (anthropic/sonnet, reasoning)
		expect(result.decision.tier).toBe("standard");
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "sonnet" });
		expect(result.decision.orderedCandidates).toEqual([{ provider: "anthropic", model: "sonnet" }]);
		expect(result.decision.reasoning.join("\n")).toContain("reasoning required");
		expect(result.decision.reasoning.join("\n")).toContain("escalated to standard");
	});

	test("epic context auto-requires a window and escalates when the tier's models are too small", () => {
		// A short general prompt at 150k context classifies trivial, but the
		// pipeline derives minContextWindow=150k from the epic context. The
		// trivial tier's only model (deepseek/flash, 60k window) is excluded,
		// so routing escalates to standard (anthropic/sonnet, 200k window).
		const deps = makeDeps();
		const candidates = targetCandidates(allTargets(CONFIG)).map((c) =>
			c.key === "deepseek/flash"
				? { ...c, capabilities: { ...CAPS, contextWindow: 60_000 } }
				: c,
		);
		const result = route(
			{
				rawPrompt: "hi",
				hasImages: false,
				candidates,
				quota: {},
				estimatedTokens: 150_000,
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("standard");
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "sonnet" });
		expect(result.decision.orderedCandidates).toEqual([{ provider: "anthropic", model: "sonnet" }]);
		expect(result.decision.reasoning.join("\n")).toContain("excluded deepseek/flash");
		expect(result.decision.reasoning.join("\n")).toContain("context window required");
		expect(result.decision.reasoning.join("\n")).toContain("escalated to standard");
	});

	test("hasImages requires vision-capable candidates", () => {
		const deps = makeDeps();
		const candidates = targetCandidates(allTargets(CONFIG)).map((c) =>
			c.key === "anthropic/sonnet" || c.key === "anthropic/opus"
				? { ...c, capabilities: { ...CAPS, input: ["text"] as ("text" | "image")[] } }
				: c,
		);
		const result = route(
			{
				rawPrompt: "@reasoning what's in this screenshot?",
				hasImages: true,
				candidates,
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.target).toEqual({ provider: "google", model: "gemini-pro", billing: "per-token" });
	});

	test("budget-blocked provider is excluded; remaining candidates still route", () => {
		const deps = makeDeps();
		// anthropic monthly limit $10, spend $12 → blocked
		deps.budgets.record("anthropic", { inputTokens: 0, outputTokens: 0, cost: 12 }, NOW);
		deps.budgets.setLimit("anthropic", { amount: 10, monthly: true });
		const result = route(
			{
				rawPrompt: "@swe implement a function",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.target.provider).toBe("deepseek");
		expect(result.decision.hints.budget.anthropic?.status).toBe("blocked");
	});

	test("all candidates budget-blocked → partitioner falls back to normal (never blocks)", () => {
		const deps = makeDeps();
		for (const provider of ["anthropic", "deepseek", "google"]) {
			deps.budgets.record(provider, { inputTokens: 0, outputTokens: 0, cost: 12 }, NOW);
			deps.budgets.setLimit(provider, { amount: 10, monthly: true });
		}
		const result = route(
			{
				rawPrompt: "implement a function",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.orderedCandidates.length).toBeGreaterThan(0);
	});

	test("critical UVI provider is excluded", () => {
		const deps = makeDeps();
		// google window just started (resets far in future) with full usage → UVI huge → critical
		const quota: Record<string, QuotaSnapshot> = {
			google: quotaFor("google", 1.0, 3600, NOW.getTime() + 3600_000),
		};
		const result = route(
			{
				rawPrompt: "@reasoning design a distributed system",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota,
				now: NOW,
			},
			deps,
		);
		expect(result.decision.hints.uvi.google?.status).toBe("critical");
		expect(result.decision.target.provider).toBe("anthropic"); // google excluded
	});

	test("exclude-provider rule removes provider with trace", () => {
		const deps = makeDeps({
			globalRules: [{ type: "exclude-provider", providers: ["google"] }],
		});
		const result = route(
			{
				rawPrompt: "@reasoning hard problem",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "opus" });
		expect(result.decision.hints.rulesTrace.join("\n")).toContain("google");
	});

	test("prefer-provider rule boosts the preferred provider within the tier order", () => {
		const deps = makeDeps({
			globalRules: [{ type: "prefer-provider", providers: ["deepseek"] }],
		});
		const result = route(
			{
				rawPrompt: "implement a function",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		// standard tier config order: anthropic/sonnet first; prefer deepseek should boost it ahead
		expect(result.decision.orderedCandidates[0]).toEqual({ provider: "deepseek", model: "flash", billing: "per-token" });
	});

	test("current task complexity is classified independently", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "fix the typo",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("trivial");
	});

	test("force-tier rule overrides the classifier", () => {
		const deps = makeDeps({
			globalRules: [{ type: "force-tier", tier: "trivial" }],
		});
		const result = route(
			{
				rawPrompt: "refactor this entire codebase across ten modules",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("trivial");
		expect(result.decision.target).toEqual({ provider: "deepseek", model: "flash", billing: "per-token" });
	});

	test("unresolvable targets still produce a decision without throwing", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "hello",
				hasImages: false,
				candidates: [], // adapter failed to enrich any target
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.orderedCandidates).toEqual([]);
		expect(result.decision.target.provider).toBe("none");
	});

	test("explicit input.profile overrides the registry's active profile", () => {
		const deps = makeDeps();
		// registry active = premium; the request targets the economy profile
		const result = route(
			{
				rawPrompt: "@swe implement a function",
				profile: "economy",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.profile).toBe("economy");
		expect(result.decision.orderedCandidates).toEqual([
			{ provider: "deepseek", model: "flash", billing: "per-token" },
		]);
	});

	test("@profile shortcut still wins over input.profile", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "@profile:eco hello",
				profile: "premium",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.profile).toBe("economy");
	});

	test("budgetRemaining is reported for the selected provider", () => {
		const deps = makeDeps();
		// month-end: elapsed fraction ≈ 0.9 → synthetic monthly UVI ok (spend 3/10)
		const lateMonth = new Date("2026-08-28T12:00:00");
		deps.budgets.record("anthropic", { inputTokens: 0, outputTokens: 0, cost: 3 }, lateMonth);
		deps.budgets.setLimit("anthropic", { amount: 10, monthly: true });
		const result = route(
			{
				rawPrompt: "@swe implement a function",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: lateMonth,
			},
			deps,
		);
		expect(result.decision.target.provider).toBe("anthropic");
		expect(result.decision.budgetRemaining).toBe(7);
	});

	test("adjudicatedTier overrides the heuristic classifier", () => {
		const deps = makeDeps();
		const result = route(
			{
				// Heuristic lands on standard (implementation terminal phase);
				// adjudication says complex → complex target wins.
				rawPrompt: "帮我设计并实现一个登录功能",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				adjudicatedTier: "complex",
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.reasoning.join(" ")).toContain("llm adjudication");
	});

	test("shortcut pin beats adjudicatedTier", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "@fast 帮我设计并实现一个登录功能",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				adjudicatedTier: "complex",
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("simple");
	});

	test("policy force-tier beats adjudicatedTier", () => {
		const deps = makeDeps({
			globalRules: [{ type: "force-tier", tier: "simple" }],
		});
		const result = route(
			{
				rawPrompt: "帮我设计并实现一个登录功能",
				hasImages: false,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				adjudicatedTier: "complex",
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("simple");
	});
});

const ROLE_CONFIG: RouterConfig = {
	active: "company",
	profiles: {
		company: {
			defaultTier: "standard",
			tiers: {
				trivial: { targets: [{ provider: "deepseek", model: "flash", billing: "per-token" }] },
				simple: { targets: [{ provider: "deepseek", model: "flash", billing: "per-token" }] },
				standard: { targets: [{ provider: "anthropic", model: "sonnet" }] },
				complex: { targets: [{ provider: "anthropic", model: "opus" }] },
			},
			roles: {
				task: {
					targets: [{ provider: "ollama", model: "qwen3" }],
					thinking: "low",
				},
				smol: { tierCap: "simple" },
				slow: { tierFloor: "complex" },
			},
		},
	},
};

const ROLE_CANDIDATES: RouteTarget[] = [
	{ provider: "deepseek", model: "flash", billing: "per-token" },
	{ provider: "anthropic", model: "sonnet" },
	{ provider: "anthropic", model: "opus" },
	{ provider: "ollama", model: "qwen3" },
];

function routeWithRole(rawPrompt: string, role?: string) {
	const config = structuredClone(ROLE_CONFIG);
	const deps = makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) });
	return route(
		{
			rawPrompt,
			...(role !== undefined ? { role } : {}),
			hasImages: false,
			candidates: targetCandidates(ROLE_CANDIDATES),
			quota: {},
			now: NOW,
		},
		deps,
	);
}

describe("pipeline role routing", () => {
	test("fixed-chain role bypasses classification even for complex-sounding prompts", () => {
		const result = routeWithRole("重构整个模块，重写架构并迁移所有调用方", "task");
		expect(result.decision.role).toBe("task");
		expect(result.decision.target).toEqual({ provider: "ollama", model: "qwen3" });
		expect(result.decision.orderedCandidates).toEqual([{ provider: "ollama", model: "qwen3" }]);
		expect(result.decision.thinking).toBe("low");
		expect(result.decision.reasoning.some((r) => r.includes("fixed chain"))).toBe(true);
	});

	test("shortcut pin escapes a fixed-chain role into the classified tier", () => {
		const result = routeWithRole("@reasoning prove the halting problem is undecidable", "task");
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "opus" });
	});

	test("tierCap clamps a complex classification down", () => {
		const result = routeWithRole("重构整个模块，重写架构并迁移所有调用方", "smol");
		expect(result.decision.tier).toBe("simple");
		expect(result.decision.target).toEqual({ provider: "deepseek", model: "flash", billing: "per-token" });
		expect(result.decision.reasoning.some((r) => r.includes("tierCap"))).toBe(true);
	});

	test("tierFloor raises a trivial classification up", () => {
		const result = routeWithRole("改个 typo", "slow");
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "opus" });
		expect(result.decision.reasoning.some((r) => r.includes("tierFloor"))).toBe(true);
	});

	test("shortcut pin bypasses role clamps", () => {
		const result = routeWithRole("@reasoning prove the halting problem is undecidable", "smol");
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "opus" });
	});

	test("undeclared role falls back to default classification", () => {
		const result = routeWithRole("重构整个模块，重写架构并迁移所有调用方", "vision");
		expect(result.decision.role).toBe("vision");
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.reasoning.some((r) => r.includes("undeclared"))).toBe(true);
	});

	test("absent role routes as default and tags the decision", () => {
		const result = routeWithRole("改个 typo");
		expect(result.decision.role).toBe("default");
		expect(result.decision.tier).toBe("trivial");
	});

	test("fixed-chain role keeps the declared target order", () => {
		const config = structuredClone(ROLE_CONFIG);
		config.profiles.company!.roles = {
			task: {
				targets: [
					{ provider: "deepseek", model: "flash", billing: "per-token" },
					{ provider: "anthropic", model: "sonnet" },
				],
			},
		};
		const result = route(
			{
				rawPrompt: "重构整个模块，重写架构并迁移所有调用方",
				role: "task",
				hasImages: false,
				candidates: targetCandidates(ROLE_CANDIDATES),
				quota: {},
				now: NOW,
			},
			makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) }),
		);
		// The partitioner ranks subscription anthropic/sonnet ahead of
		// per-token deepseek/flash; a fixed chain must keep the declared order.
		expect(result.decision.orderedCandidates).toEqual([
			{ provider: "deepseek", model: "flash", billing: "per-token" },
			{ provider: "anthropic", model: "sonnet" },
		]);
		expect(result.decision.target).toEqual({ provider: "deepseek", model: "flash", billing: "per-token" });
	});

	test("fixed-chain role keeps its own target metadata when a tier lists the same model", () => {
		const config = structuredClone(ROLE_CONFIG);
		// The standard tier lists anthropic/sonnet as a subscription target;
		// the role chain declares the same model per-token. The role's own
		// metadata must survive candidate enrichment.
		config.profiles.company!.roles = {
			task: { targets: [{ provider: "anthropic", model: "sonnet", billing: "per-token" }] },
		};
		const result = route(
			{
				rawPrompt: "重构整个模块，重写架构并迁移所有调用方",
				role: "task",
				hasImages: false,
				candidates: targetCandidates(ROLE_CANDIDATES),
				quota: {},
				now: NOW,
			},
			makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) }),
		);
		expect(result.decision.target).toEqual({ provider: "anthropic", model: "sonnet", billing: "per-token" });
	});

	test("capability escalation re-applies exclude-provider policy to the escalated pool", () => {
		const config: RouterConfig = {
			active: "p",
			profiles: {
				p: {
					defaultTier: "standard",
					tiers: {
						trivial: { targets: [{ provider: "a", model: "small" }] },
						standard: { targets: [{ provider: "b", model: "big" }] },
						complex: { targets: [{ provider: "c", model: "big" }] },
					},
					rules: [{ type: "exclude-provider", providers: ["b"] }],
				},
			},
		};
		const candidates = targetCandidates([
			{ provider: "a", model: "small" },
			{ provider: "b", model: "big" },
			{ provider: "c", model: "big" },
		]).map(c => (c.key === "a/small" ? { ...c, capabilities: { ...CAPS, contextWindow: 60_000 } } : c));
		const result = route(
			{
				rawPrompt: "hi",
				hasImages: false,
				candidates,
				quota: {},
				estimatedTokens: 150_000,
				now: NOW,
			},
			makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) }),
		);
		// standard's only big-window model is policy-excluded: escalation must
		// skip it and land on complex, never on the excluded provider.
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.target).toEqual({ provider: "c", model: "big" });
		expect(result.decision.orderedCandidates).toEqual([{ provider: "c", model: "big" }]);
	});

	test("capability escalation is bounded by the role tierCap", () => {
		const config = structuredClone(ROLE_CONFIG);
		// smol caps at simple; only standard+ tiers have a big enough window
		// for a 150k context (deepseek/flash shrunk to 60k).
		const candidates = targetCandidates(ROLE_CANDIDATES).map(c =>
			c.key === "deepseek/flash" ? { ...c, capabilities: { ...CAPS, contextWindow: 60_000 } } : c,
		);
		const result = route(
			{
				rawPrompt: "hi",
				role: "smol",
				hasImages: false,
				candidates,
				quota: {},
				estimatedTokens: 150_000,
				now: NOW,
			},
			makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) }),
		);
		// No permitted tier can serve the window: stay within the cap with an
		// empty chain rather than escalating to standard/complex.
		expect(result.decision.tier).not.toBe("standard");
		expect(result.decision.tier).not.toBe("complex");
		expect(result.decision.orderedCandidates).toEqual([]);
		expect(result.decision.reasoning.join("\n")).not.toContain("escalated to standard");
	});

	test("role thinking overrides tier thinking but loses to target thinking", () => {
		const config = structuredClone(ROLE_CONFIG);
		config.profiles.company!.roles = { plan: { tierFloor: "standard", thinking: "low" } };
		config.profiles.company!.tiers.standard = {
			thinking: "high",
			targets: [{ provider: "anthropic", model: "sonnet" }],
		};
		const deps = makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) });
		const result = route(
			{
				rawPrompt: "改个 typo",
				role: "plan",
				hasImages: false,
				candidates: targetCandidates(ROLE_CANDIDATES),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("standard");
		expect(result.decision.thinking).toBe("low");

		// target.thinking still wins over the role override
		config.profiles.company!.tiers.standard = {
			thinking: "high",
			targets: [{ provider: "anthropic", model: "sonnet", thinking: "medium" }],
		};
		const withTargetThinking = route(
			{
				rawPrompt: "改个 typo",
				role: "plan",
				hasImages: false,
				candidates: targetCandidates([{ provider: "anthropic", model: "sonnet", thinking: "medium" }]),
				quota: {},
				now: NOW,
			},
			makeDeps({ registry: new ProfileRegistry(config, { cwd: "/tmp/work" }) }),
		);
		expect(withTargetThinking.decision.thinking).toBe("medium");
	});
});
