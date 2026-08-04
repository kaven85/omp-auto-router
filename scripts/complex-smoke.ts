/**
 * Ad-hoc complex-task smoke: run a genuinely complex prompt through the real
 * router-core pipeline using the production premium profile. Not part of the
 * test suite — a dev-time demonstration of complex-tier routing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseRouterConfig } from "../src/core/config-loader";
import { ProfileRegistry } from "../src/core/profile-registry";
import { CircuitBreaker } from "../src/core/circuit-breaker";
import { LatencyTracker } from "../src/core/latency-tracker";
import { BudgetTracker } from "../src/core/budget-tracker";
import { route } from "../src/core/pipeline";

const BASE = process.cwd();
const yamlText = readFileSync(join(BASE, "auto-router.example.yml"), "utf8");

const parsed = parseRouterConfig(yamlText);
if (parsed.errors.length) {
	console.error("config errors:", parsed.errors);
	process.exit(1);
}
const cfg = parsed.config;
const NOW = new Date("2026-08-04T12:00:00");

const memStore = () => {
	let data;
	return { store: { load: () => data, save: (v) => { data = v; } } };
};
const usage = memStore();
const limits = memStore();

const deps = {
	registry: new ProfileRegistry(cfg, { cwd: "/Users/kaven/work/legacy-monolith" }),
	circuit: new CircuitBreaker(),
	latency: new LatencyTracker(),
	budgets: new BudgetTracker(usage.store, limits.store),
};

const CAPS = {
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 200_000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const seen = new Set();
const targets = [];
for (const p of Object.values(cfg.profiles))
	for (const t of Object.values(p.tiers))
		for (const tg of t.targets) {
			const k = `${tg.provider}/${tg.model}`;
			if (!seen.has(k)) {
				seen.add(k);
				targets.push(tg);
			}
		}
const candidates = targets.map((t) => ({
	target: t,
	key: `${t.provider}/${t.model}`,
	capabilities: CAPS,
	healthy: true,
}));

// A genuinely complex, multi-step architectural task brief.
const COMPLEX_PROMPT = `我们有一个运行了 8 年的单体 Java 应用（订单 + 库存 + 支付耦合在一个 WAR 里，共享一张 MySQL）。
请设计并落地一次架构迁移：把单体按领域拆成订单/库存/支付三个微服务，各自独立数据库，
引入事务最终一致性方案（本地消息表 + 可靠事件总线），给出拆库后的数据迁移与回滚策略。
同时评估引入 API 网关 + 服务发现对调用链与可观测性的影响，并列出 6 个月内的分阶段迁移里程碑与各阶段风险。`;

const result = route(
	{
		rawPrompt: COMPLEX_PROMPT,
		hasImages: false,
		conversationDepth: 0,
		candidates,
		quota: {},
		now: NOW,
	},
	deps,
);

const d = result.decision;
console.log("=== complex task routing decision ===");
console.log("profile      :", d.profile);
console.log("tier         :", d.tier, `(conf=${d.confidence.toFixed(2)})`);
console.log("thinking     :", d.thinking);
console.log("target       :", `${d.target.provider}/${d.target.model}`, d.target.billing ?? "");
console.log("candidate chain:", d.orderedCandidates.map((t) => `${t.provider}/${t.model}`).join(" -> "));
console.log("estimatedTok :", d.estimatedTokens);
console.log("--- decision reasoning ---");
d.reasoning.forEach((r) => console.log(`  · ${r}`));
console.log("--- complexity hint ---");
if (d.hints?.complexity) console.log("  tier:", d.hints.complexity.tier, "| reasons:", d.hints.complexity.reasons.join("; "));
console.log("cleanPrompt  :", result.cleanPrompt.slice(0, 40) + (result.cleanPrompt.length > 40 ? "…" : ""));
console.log("shortcutpinned:", d.hints?.shortcut ?? "none");

// Assert the complex classification actually fired.
if (d.tier !== "complex") {
	console.error("FAIL: expected complex tier, got", d.tier);
	process.exit(1);
}
console.log("\nOK: classified complex; routed to complex-tier chain.");
