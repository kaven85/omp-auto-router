#!/usr/bin/env bun
/**
 * Smoke: verify the cache-rate widget line end to end.
 * Drives the REAL RouterRuntime.stream path with usage-bearing done events,
 * then renders buildWidgetLines — no mocks of the code under test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BudgetTracker } from "../src/core/budget-tracker";
import { CircuitBreaker } from "../src/core/circuit-breaker";
import { DecisionStore } from "../src/core/decision-store";
import { EventLog } from "../src/core/event-log";
import { FeedbackTracker } from "../src/core/feedback-tracker";
import { LatencyTracker } from "../src/core/latency-tracker";
import { ProfileRegistry } from "../src/core/profile-registry";
import type { RouterConfig } from "../src/core/types";
import { createPersistentRuntimeState } from "../src/runtime/state";
import { RouterRuntime, type RouterRuntimeHost } from "../src/runtime/router-runtime";
import { buildWidgetLines } from "../src/runtime/widget";

const dir = mkdtempSync(join(tmpdir(), "ar-cache-smoke-"));
const config: RouterConfig = {
	active: "default",
	profiles: {
		default: {
			defaultTier: "standard",
			tiers: {
				standard: { targets: [{ provider: "kimi", model: "k2" }, { provider: "deepseek", model: "v3" }] },
				complex: { targets: [{ provider: "deepseek", model: "v3" }] },
			},
		},
	},
};

// Real production state constructor (the one both adapters boot from).
const state = createPersistentRuntimeState(config, join(dir, "auto-router"), process.cwd(), []);

const host: RouterRuntimeHost = {
	candidatesFor: (targets) =>
		targets.map((target) => ({
			target,
			key: `${target.provider}/${target.model}`,
			healthy: true,
			capabilities: { reasoning: true, input: ["text", "image"], contextWindow: 200_000 },
		})),
	streamTarget: (target) =>
		(async function* () {
			yield { type: "text_delta", delta: "ok", target };
			// Anthropic-style usage: input excludes cache tokens.
			yield {
				type: "done",
				target,
				message: {
					usage:
						target.provider === "kimi"
							? { input: 3_000, output: 500, cacheRead: 6_000, cacheWrite: 1_000 }
							: { input: 9_000, output: 500 },
				},
			};
		})(),
	isRetryable: () => false,
	persistDecision() {},
	setStatus() {},
	now: () => Date.now(),
};

const runtime = new RouterRuntime(state, host);

// Turn 1: routed to kimi (standard tier).
for await (const _ of runtime.stream({ profile: "default", context: { messages: [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }] }, options: {} })) {
	/* drain */
}

console.log("── after turn 1 (kimi settled, 3k fresh / 6k cacheRead / 1k cacheWrite) ──");
const lines1 = buildWidgetLines(state, state.lastDecision?.decision);
console.log(lines1.join("\n"));
const cacheLine1 = lines1.find((line) => line.startsWith("cache:"));
console.log(`\nsessionUsage: input=${state.sessionUsage.inputTokens.get("kimi/k2")} read=${state.sessionUsage.cacheRead.get("kimi/k2")} write=${state.sessionUsage.cacheWrite.get("kimi/k2")}`);
if (cacheLine1 !== "cache: kimi hit 60.00% · read 6,000 · write 1,000") throw new Error(`unexpected cache line: ${cacheLine1}`);

// Turn 2: force deepseek via shortcut profile pin, then check kimi line disappears
// and deepseek (no cache tokens) renders 0% once it settles.
const altConfig: RouterConfig = {
	active: "default",
	profiles: {
		...config.profiles,
		ds: { defaultTier: "standard", tiers: { standard: { targets: [{ provider: "deepseek", model: "v3" }] } } },
	},
};
state.registry = new ProfileRegistry(altConfig);
for await (const _ of runtime.stream({ profile: "ds", context: { messages: [{ role: "user", content: [{ type: "text", text: "follow up" }] }] }, options: {} })) {
	/* drain */
}

console.log("\n── after turn 2 (deepseek settled, 9k fresh, no cache) ──");
const lines2 = buildWidgetLines(state, state.lastDecision?.decision);
console.log(lines2.join("\n"));
const cacheLine2 = lines2.find((line) => line.startsWith("cache:"));
if (cacheLine2 !== "cache: deepseek hit 0.00% · read 0 · write 0") throw new Error(`unexpected cache line: ${cacheLine2}`);

rmSync(dir, { recursive: true, force: true });
console.log("\nSMOKE OK — cache-rate line verified through the real stream → recordUsage → widget path");
