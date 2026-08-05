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
				conversationDepth: 0,
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

	test("@profile alias override switches profile per-request", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "@profile:eco fix this typo",
				hasImages: false,
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		// standard tier config order: anthropic/sonnet first; prefer deepseek should boost it ahead
		expect(result.decision.orderedCandidates[0]).toEqual({ provider: "deepseek", model: "flash", billing: "per-token" });
	});

	test("sticky escalation keeps prior higher tier", () => {
		const deps = makeDeps();
		const result = route(
			{
				rawPrompt: "fix the typo",
				hasImages: false,
				conversationDepth: 3,
				priorTier: "complex",
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: NOW,
			},
			deps,
		);
		expect(result.decision.tier).toBe("complex");
		expect(result.decision.hints.complexity.signals.stickyEscalation).toBe(true);
	});

	test("force-tier rule overrides the classifier", () => {
		const deps = makeDeps({
			globalRules: [{ type: "force-tier", tier: "trivial" }],
		});
		const result = route(
			{
				rawPrompt: "refactor this entire codebase across ten modules",
				hasImages: false,
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
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
				conversationDepth: 0,
				candidates: targetCandidates(allTargets(CONFIG)),
				quota: {},
				now: lateMonth,
			},
			deps,
		);
		expect(result.decision.target.provider).toBe("anthropic");
		expect(result.decision.budgetRemaining).toBe(7);
	});
});
