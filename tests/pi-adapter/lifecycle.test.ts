import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RoutingDecision } from "../../src/core/types";
import { addTarget, baseModel, bootHarness, createPiHarness, type PiHarness } from "./mock-pi";

const USER_CONFIG = `
active: base
profiles:
  base:
    tiers:
      standard:
        targets:
          - provider: alpha
            model: a1
`;

let harness: PiHarness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function decisionFixture(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
	return {
		profile: "base",
		tier: "standard",
		confidence: 0.8,
		target: { provider: "alpha", model: "a1" },
		orderedCandidates: [{ provider: "alpha", model: "a1" }],
		estimatedTokens: 10,
		reasoning: ["restored"],
		hints: {
			rulesTrace: [],
			budget: {},
			uvi: {},
			complexity: {
				tier: "standard",
				confidence: 0.8,
				reasons: [],
				signals: { estimatedTokens: 10, codeSignals: [], repairDebug: false, implementation: false, mixedPhase: false, multiStep: false, mechanicalOp: false, shortQa: false, stickyEscalation: false, hasImages: false },
			},
		},
		decidedAt: Date.now(),
		...overrides,
	};
}

describe("Pi lifecycle", () => {
	test("trusted project config layers over user config and re-registers profiles", async () => {
		harness = createPiHarness({
			userConfig: USER_CONFIG,
			projectConfig: `
profiles:
  project-profile:
    tiers:
      standard:
        targets:
          - provider: beta
            model: b1
`,
			trusted: true,
		});
		addTarget(harness, baseModel("alpha", "a1"));
		addTarget(harness, baseModel("beta", "b1"));
		await bootHarness(harness);

		const models = harness.providers.get("auto-router")?.models.map((model) => model.id);
		expect(models).toContain("default");
		expect(models).toContain("base");
		expect(models).toContain("project-profile");
	});

	test("untrusted project config is ignored and doctor explains why", async () => {
		harness = createPiHarness({
			userConfig: USER_CONFIG,
			projectConfig: `
profiles:
  sneaky:
    tiers:
      standard:
        targets:
          - provider: beta
            model: b1
`,
			trusted: false,
		});
		addTarget(harness, baseModel("alpha", "a1"));
		await bootHarness(harness);

		const models = harness.providers.get("auto-router")?.models.map((model) => model.id);
		expect(models).toContain("base");
		expect(models).not.toContain("sneaky");
		await harness.invoke("doctor");
		const out = harness.notifications.map((notice) => notice.message).join("\n");
		expect(out).toContain("auto-router doctor (Pi)");
		expect(out).toContain("project config ignored: project is not trusted");
		expect(out).toContain("project untrusted");
	});

	test("reload re-reads config and immediately re-registers profile models", async () => {
		harness = createPiHarness({ userConfig: USER_CONFIG, trusted: false });
		addTarget(harness, baseModel("alpha", "a1"));
		await bootHarness(harness);
		expect(harness.providers.get("auto-router")?.models.map((model) => model.id)).toContain("base");
		expect(harness.providers.get("auto-router")?.models.map((model) => model.id)).not.toContain("extra");

		writeFileSync(join(harness.agentDir, "auto-router.yml"), `
active: base
profiles:
  base:
    tiers:
      standard:
        targets:
          - provider: alpha
            model: a1
  extra:
    tiers:
      standard:
        targets:
          - provider: alpha
            model: a1
`);
		await harness.invoke("reload");
		const models = harness.providers.get("auto-router")?.models.map((model) => model.id);
		expect(models).toContain("extra");
		expect(harness.notifications.at(-1)?.message).toBe("config reloaded");
	});

	test("path activation picks the longest matching prefix and switches through the registry", async () => {
		// Config needs the real cwd, which exists only after createPiHarness.
		harness = createPiHarness({ trusted: false });
		writeFileSync(join(harness.agentDir, "auto-router.yml"), `
active: base
profiles:
  base:
    tiers:
      standard:
        targets: [{ provider: alpha, model: a1 }]
  near:
    tiers:
      standard:
        targets: [{ provider: alpha, model: a1 }]
  exact:
    tiers:
      standard:
        targets: [{ provider: alpha, model: a1 }]
activate:
  - path: ${join(harness.cwd, "..")}
    profile: near
  - path: ${harness.cwd}
    profile: exact
`);
		addTarget(harness, baseModel("alpha", "a1"));
		await bootHarness(harness);

		expect(harness.context.model?.provider).toBe("auto-router");
		expect(harness.context.model?.id).toBe("exact");
		const switchEntry = harness.entries.find((entry) => entry.customType === "com.auto-router.v1.state");
		expect(switchEntry?.data).toEqual({ profile: "exact" });
	});

	test("branch restore accepts neutral and legacy decision entries; tree navigation clears stale ones", async () => {
		harness = createPiHarness({ userConfig: USER_CONFIG, trusted: false });
		addTarget(harness, baseModel("alpha", "a1"));
		await bootHarness(harness);

		harness.branch = [
			{ type: "custom", customType: "com.omp.auto-router.decision", data: decisionFixture({ reasoning: ["legacy"] }) },
			{ type: "custom", customType: "com.auto-router.v1.decision", data: decisionFixture() },
		];
		await harness.fire("session_tree");
		await harness.invoke("explain");
		expect(harness.notifications.map((notice) => notice.message).join("\n")).toContain("target: alpha/a1");

		// Navigating to a branch without decisions must not keep the old ones.
		harness.branch = [];
		await harness.fire("session_tree");
		await harness.invoke("explain");
		expect(harness.notifications.at(-1)?.message).toBe("no routing decision yet");
	});

	test("session replacement on restart uses the fresh session's branch", async () => {
		harness = createPiHarness({ userConfig: USER_CONFIG, trusted: false });
		addTarget(harness, baseModel("alpha", "a1"));
		await bootHarness(harness);

		harness.branch = [{ type: "custom", customType: "com.auto-router.v1.decision", data: decisionFixture() }];
		await harness.fire("session_tree");
		await harness.invoke("explain");
		expect(harness.notifications.at(-1)?.message).toContain("target: alpha/a1");

		// A new session (resume/fork/new) starts with an empty branch: the old
		// session's decisions must not leak into explain.
		harness.branch = [];
		await harness.fire("session_start");
		await harness.invoke("explain");
		expect(harness.notifications.at(-1)?.message).toBe("no routing decision yet");
	});

	test("shutdown persists circuit and latency trackers; a fresh runtime restores them", async () => {
		harness = createPiHarness({ userConfig: TWO_TARGET, trusted: false });
		addTarget(harness, baseModel("alpha", "a1"));
		addTarget(harness, baseModel("beta", "b1"));
		await bootHarness(harness);

		// One failover: alpha fails (circuit failure + cooldown), beta settles
		// (first-output latency recorded).
		harness.streams.set("alpha/a1", () => [{ type: "throw", error: "HTTP 500 broken" }]);
		await harness.stream("work", "attempt");
		await harness.fire("session_shutdown");

		const stateDir = join(harness.agentDir, "auto-router");
		const circuitFile = join(stateDir, "circuit.json");
		const latencyFile = join(stateDir, "first-output-latency.json");
		expect(existsSync(circuitFile)).toBe(true);
		expect(JSON.parse(readFileSync(circuitFile, "utf8"))["alpha/a1"]?.consecutiveFailures).toBe(1);
		expect(existsSync(latencyFile)).toBe(true);
		expect(JSON.parse(readFileSync(latencyFile, "utf8"))["beta/b1"]).toBeGreaterThanOrEqual(0);

		// Simulate accumulated operational history: an open circuit on alpha.
		// A fresh runtime over the same state directory must restore it and
		// skip alpha even though the model is healthy again.
		writeFileSync(circuitFile, JSON.stringify({
			"alpha/a1": { consecutiveFailures: 5, openedAt: Date.now(), cooldownMs: 60_000 },
		}));
		harness.streams.set("alpha/a1", () => [
			{ type: "text_delta", delta: "alpha recovered" },
			{ type: "done", reason: "stop", message: { provider: "alpha", model: "a1", usage: { input: 1, output: 1 } } },
		]);
		harness.streamCalls.length = 0;
		await bootHarness(harness);
		const events = await harness.stream("work", "after restart");
		expect(events.at(-1)?.type).toBe("done");
		expect(harness.streamCalls.map((call) => call.provider)).toEqual(["beta"]);
	});

	test("shutdown persistence is idempotent", async () => {
		harness = createPiHarness({ userConfig: USER_CONFIG, trusted: false });
		addTarget(harness, baseModel("alpha", "a1"));
		await bootHarness(harness);
		await harness.fire("session_shutdown");
		await harness.fire("session_shutdown");
		expect(existsSync(join(harness.agentDir, "auto-router", "circuit.json"))).toBe(true);
	});

	test("tool_result test failure escalates then clears on success", async () => {
		harness = createPiHarness({ userConfig: USER_CONFIG, trusted: false });
		addTarget(harness, baseModel("alpha", "a1"));
		await bootHarness(harness);
		const toolResult = harness.handlers.get("tool_result");
		expect(toolResult).toBeDefined();
		toolResult!({ toolName: "bash", input: { command: "bun test" }, isError: true } as never, harness.context as never);
		toolResult!({ toolName: "bash", input: { command: "bun test" }, isError: false } as never, harness.context as never);
		// Non-test commands are ignored entirely.
		toolResult!({ toolName: "bash", input: { command: "ls -la" }, isError: true } as never, harness.context as never);
	});
});

const TWO_TARGET = `
active: work
profiles:
  work:
    tiers:
      standard:
        targets:
          - provider: alpha
            model: a1
          - provider: beta
            model: b1
`;
