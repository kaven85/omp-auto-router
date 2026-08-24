import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { BudgetTracker } from "../../src/core/budget-tracker";
import { CircuitBreaker } from "../../src/core/circuit-breaker";
import { DecisionStore } from "../../src/core/decision-store";
import { EventLog } from "../../src/core/event-log";
import { FeedbackTracker } from "../../src/core/feedback-tracker";
import { LatencyTracker } from "../../src/core/latency-tracker";
import { ProfileRegistry } from "../../src/core/profile-registry";
import type { RouterConfig } from "../../src/core/types";
import { RouterRuntime, type RouterRuntimeHost, type RouterRuntimeState } from "../../src/runtime/router-runtime";

// llmAdjudicationEnabled() reads process.env live per request — scrub the
// developer shell's ambient override so it cannot flip test outcomes.
const ADJUDICATE_ENV_KEYS = ["AUTO_ROUTER_LLM_ADJUDICATE", "OMP_AUTO_ROUTER_LLM_ADJUDICATE", "PI_AUTO_ROUTER_LLM_ADJUDICATE"] as const;
const ambientAdjudicateEnv = ADJUDICATE_ENV_KEYS.map((key) => [key, process.env[key]] as const);
beforeEach(() => {
	for (const key of ADJUDICATE_ENV_KEYS) delete process.env[key];
});
afterAll(() => {
	for (const [key, value] of ambientAdjudicateEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const config: RouterConfig = {
	active: "default",
	profiles: {
		default: {
			defaultTier: "standard",
			tiers: {
				standard: {
					targets: [
							{ provider: "first", model: "one" },
							{ provider: "second", model: "two" },
						],
				},
				complex: { targets: [{ provider: "second", model: "two" }] },
			},
		},
		alternate: {
			defaultTier: "standard",
			tiers: { standard: { targets: [{ provider: "alternate", model: "three" }] } },
		},
	},
};

function createState(): RouterRuntimeState {
	return {
		registry: new ProfileRegistry(config),
		circuit: new CircuitBreaker(),
		latency: new LatencyTracker(),
		budgets: new BudgetTracker({ load: () => undefined, save: () => {} }, { load: () => undefined, save: () => {} }),
		decisions: new DecisionStore(),
		eventLog: new EventLog("/dev/null"),
		cooldowns: new Map(),
		ratings: new FeedbackTracker({ load: () => undefined, save: () => {} }),
		sessionUsage: { calls: new Map(), cost: new Map(), thinking: new Map() },
	};
}

function createHost(events: Array<{ type: string; [key: string]: unknown }>): RouterRuntimeHost {
	return {
		candidatesFor(targets, cooldowns) {
			return targets.map((target) => ({
				target,
				key: `${target.provider}/${target.model}`,
				healthy: true,
				capabilities: { reasoning: true, input: ["text", "image"], contextWindow: 200_000 },
				...(cooldowns.get(`${target.provider}/${target.model}`) ? { cooldownUntil: Date.now() + 10_000 } : {}),
			}));
		},
		streamTarget(target) {
			return (async function* () {
				for (const event of events) {
					if (event.type === "throw") throw new Error(String(event.error));
					yield { ...event, target };
				}
			})();
		},
		isRetryable(error) {
			return String(error).includes("retry");
		},
		persistDecision() {},
		setStatus() {},
		now: () => 1_700_000_000_000,
	};
}

function request(prompt: string) {
	return {
		profile: "default",
		context: { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
		options: {},
	};
}

describe("RouterRuntime", () => {
	test("routes, strips shortcuts, and attributes a settled target through the Host seam", async () => {
		const state = createState();
		const runtime = new RouterRuntime(state, createHost([{ type: "text_delta", delta: "ok" }, { type: "done", message: { usage: { input: 10, output: 5 } } }]));
		const input = request("@reasoning solve this");

		const received: string[] = [];
		for await (const event of runtime.stream(input)) received.push(event.type);

		expect(received).toEqual(["text_delta", "done"]);
		expect(input.context.messages[0]?.content).toEqual([{ type: "text", text: "solve this" }]);
		expect(state.lastDecision?.decision).toMatchObject({ tier: "complex", target: { provider: "second", model: "two" } });
		expect(state.sessionUsage.calls.get("second/two")).toBe(1);
	});

	test("uses a shortcut profile's own target chain", async () => {
		const state = createState();
		const runtime = new RouterRuntime(state, createHost([{ type: "done", message: {} }]));

		for await (const _event of runtime.stream(request("@profile:alternate plain prompt"))) { /* drain */ }

		expect(state.lastDecision?.decision).toMatchObject({ profile: "alternate", target: { provider: "alternate", model: "three" } });
	});

	test("@profile alias override resolves through the registry", async () => {
		const aliasConfig: RouterConfig = { ...config, aliases: { alt: ["alternate"] } };
		const state = { ...createState(), registry: new ProfileRegistry(aliasConfig) };
		const runtime = new RouterRuntime(state, createHost([{ type: "done", message: {} }]));

		for await (const _event of runtime.stream(request("@profile:alt plain prompt"))) { /* drain */ }

		expect(state.lastDecision?.decision).toMatchObject({ profile: "alternate", target: { provider: "alternate", model: "three" } });
	});

	test("unknown @profile override stays on the session profile instead of throwing", async () => {
		const state = createState();
		const runtime = new RouterRuntime(state, createHost([{ type: "done", message: {} }]));

		for await (const _event of runtime.stream(request("@profile:nope plain prompt"))) { /* drain */ }

		expect(state.lastDecision?.decision.profile).toBe("default");
		expect(state.lastDecision?.decision.reasoning.join("\n")).toContain("@profile:nope unknown");
	});

	test("fails over before substantive output and cools only the failed target", async () => {
		const state = createState();
		let calls = 0;
		const host = createHost([{ type: "done", message: {} }]);
		host.streamTarget = (target) =>
			(async function* () {
				calls++;
				if (calls === 1) throw new Error("retry please");
				yield { type: "done", message: {}, target };
			})();
		const runtime = new RouterRuntime(state, host);

		const received: string[] = [];
		for await (const event of runtime.stream(request("plain prompt"))) received.push(event.type);

		expect(received).toEqual(["done"]);
		expect(state.cooldowns.has("first/one")).toBe(true);
		expect(state.circuit.state("first/one", Date.now())).toBe("closed");
		expect(state.sessionUsage.calls.get("second/two")).toBe(1);
	});

	test("repeated partial-output failures accumulate in the circuit breaker", async () => {
		const state = createState();
		const runtime = new RouterRuntime(state, createHost([
			{ type: "text_delta", delta: "partial" },
			{ type: "error", status: 500, message: "upstream failed" },
		]));
		for (let attempt = 0; attempt < 3; attempt++) {
			for await (const _event of runtime.stream(request("plain prompt"))) { /* drain */ }
			// Cooldown suppresses immediate retries, but must not erase failure history.
			state.cooldowns.clear();
		}
		expect(state.circuit.state("first/one", 1_700_000_000_000)).toBe("open");
		expect(state.sessionUsage.calls.get("first/one")).toBeUndefined();
	});


	test("mixed-phase prompts are adjudicated through the host hook, fail open", async () => {
		const state = createState();
		const host = createHost([{ type: "done", message: {} }]);
		let adjudications = 0;
		host.adjudicate = async () => {
			adjudications++;
			return { tier: "complex", model: "first/one" };
		};
		const runtime = new RouterRuntime(state, host);
		// "按方案实现" mixes implementation phrasing with soft planning words.
		for await (const _event of runtime.stream(request("按照设计方案实现登录功能模块"))) { /* drain */ }

		expect(adjudications).toBe(1);
		expect(state.lastDecision?.decision.tier).toBe("complex");
		expect(state.lastDecision?.decision.reasoning.some((line) => line.includes("llm adjudication by first/one → complex"))).toBe(true);
	});

	test("adjudication failure keeps the heuristic decision", async () => {
		const state = createState();
		const host = createHost([{ type: "done", message: {} }]);
		host.adjudicate = async () => {
			throw new Error("adjudicator down");
		};
		const runtime = new RouterRuntime(state, host);
		let decision: string | undefined;
		try {
			for await (const _event of runtime.stream(request("按照设计方案实现登录功能模块"))) { /* drain */ }
			decision = state.lastDecision?.decision.tier;
		} catch {
			decision = "threw";
		}
		// Fail-open means: the request completed and no adjudication line exists.
		expect(decision).toBe("standard");
		expect(state.lastDecision?.decision.reasoning.some((line) => line.includes("llm adjudication"))).toBe(false);
	});

	test("the adjudicator is the session's current model after a decision", async () => {
		const state = createState();
		const host = createHost([{ type: "done", message: {} }]);
		const adjudicatorTargets: string[] = [];
		host.adjudicate = async (target) => {
			adjudicatorTargets.push(`${target.provider}/${target.model}`);
			return { tier: "standard", model: "x" };
		};
		const runtime = new RouterRuntime(state, host);
		// Fresh session: falls back to the profile's standard-tier first target.
		for await (const _event of runtime.stream(request("按照设计方案实现登录功能模块"))) { /* drain */ }
		expect(adjudicatorTargets).toEqual(["first/one"]);

		// After the decision settled on second/two, adjudication follows it.
		state.decisions.record({
			...state.lastDecision!.decision,
			target: { provider: "second", model: "two" },
		});
		for await (const _event of runtime.stream(request("按照设计方案实现登录功能模块"))) { /* drain */ }
		expect(adjudicatorTargets).toEqual(["first/one", "second/two"]);
	});

	test("AUTO_ROUTER_LLM_ADJUDICATE=0 skips adjudication", async () => {
		const prior = process.env.AUTO_ROUTER_LLM_ADJUDICATE;
		process.env.AUTO_ROUTER_LLM_ADJUDICATE = "0";
		try {
			const state = createState();
			const host = createHost([{ type: "done", message: {} }]);
			let adjudications = 0;
			host.adjudicate = async () => {
				adjudications++;
				return { tier: "standard", model: "first/one" };
			};
			const runtime = new RouterRuntime(state, host);
			for await (const _event of runtime.stream(request("按照设计方案实现登录功能模块"))) { /* drain */ }
			expect(adjudications).toBe(0);
		} finally {
			if (prior === undefined) delete process.env.AUTO_ROUTER_LLM_ADJUDICATE;
			else process.env.AUTO_ROUTER_LLM_ADJUDICATE = prior;
		}
	});
});

describe("RouterRuntime role routing", () => {
	function roleRequest(prompt: string, role: string) {
		return { ...request(prompt), role };
	}

	test("non-default roles skip LLM adjudication even for mixed-phase prompts", async () => {
		const state = createState();
		const host = createHost([{ type: "done", message: {} }]);
		let adjudications = 0;
		host.adjudicate = async () => {
			adjudications++;
			return { tier: "complex", model: "first/one" };
		};
		const runtime = new RouterRuntime(state, host);
		for await (const _event of runtime.stream(roleRequest("按照设计方案实现登录功能模块", "task"))) { /* drain */ }

		expect(adjudications).toBe(0);
		expect(state.lastDecision?.decision.role).toBe("task");
	});

	test("fixed-chain role streams its own targets, not the tier chain", async () => {
		const roleConfig = structuredClone(config);
		roleConfig.profiles.default!.roles = {
			task: { targets: [{ provider: "third", model: "fixed" }] },
		};
		const state = { ...createState(), registry: new ProfileRegistry(roleConfig) };
		const runtime = new RouterRuntime(state, createHost([{ type: "done", message: {} }]));

		const received: string[] = [];
		for await (const event of runtime.stream(roleRequest("重构整个模块并迁移所有调用方", "task"))) received.push(event.type);

		expect(received).toEqual(["done"]);
		expect(state.lastDecision?.decision.target).toEqual({ provider: "third", model: "fixed" });
		expect(state.sessionUsage.calls.get("third/fixed")).toBe(1);
	});

	test("status line shows the role for non-default roles", async () => {
		const state = createState();
		const host = createHost([{ type: "done", message: {} }]);
		const statuses: string[] = [];
		host.setStatus = (text) => { statuses.push(text); };
		const runtime = new RouterRuntime(state, host);
		for await (const _event of runtime.stream(roleRequest("plain prompt", "task"))) { /* drain */ }

		expect(statuses[0]).toContain("default/task");
	});
});
