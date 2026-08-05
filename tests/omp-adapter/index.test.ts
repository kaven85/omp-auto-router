import { describe, expect, test, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Entry-level tests: boot flow, session ctx adoption rules, path activation,
 * and decision restore. The extension imports @oh-my-pi/pi-ai at module scope
 * (resolved by the omp loader at runtime), so we stub it before importing.
 */

const streamCalls: Array<{ provider: string; model: string }> = [];
mock.module("@oh-my-pi/pi-ai", () => ({
	streamSimple(model: { provider: string; id: string }) {
		streamCalls.push({ provider: model.provider, model: model.id });
		return (async function* () {
			yield { type: "done", reason: "stop", message: {} };
		})();
	},
}));
mock.module("@oh-my-pi/pi-ai/error", () => ({
	isProviderRetryableError: () => false,
}));

const { default: autoRouterExtension } = await import("../../src/omp-adapter/index");
const { MockExtensionApi } = await import("./mock-omp");
import type { OmpModel } from "../../src/omp-adapter/omp-api";

const MODELS: OmpModel[] = [
	{ provider: "anthropic", id: "sonnet", api: "anthropic-messages", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	{ provider: "deepseek", id: "flash", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 } },
];

function withAgentDir(yaml: string, fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ar-index-"));
	mkdirSync(join(dir, "auto-router"), { recursive: true });
	writeFileSync(join(dir, "auto-router.yml"), yaml);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return fn(dir).finally(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
}

const BASE_CONFIG = [
	"active: main",
	"profiles:",
	"  main:",
	"    tiers:",
	"      trivial: { targets: [{ provider: deepseek, model: flash }] }",
	"      simple: { targets: [{ provider: deepseek, model: flash }] }",
	"      standard: { targets: [{ provider: anthropic, model: sonnet }] }",
	"      complex: { targets: [{ provider: anthropic, model: sonnet }] }",
].join("\n");

async function flushBoot(): Promise<void> {
	// session_start kicks boot() without awaiting it; let the microtask queue drain.
	const first = Promise.withResolvers<void>();
	setImmediate(first.resolve);
	await first.promise;
	const second = Promise.withResolvers<void>();
	setImmediate(second.resolve);
	await second.promise;
}

describe("extension entry (boot + ctx adoption)", () => {
	test("path activation picks the longest matching prefix and switches the model", async () => {
		await withAgentDir(
			[
				BASE_CONFIG,
				"  premium:",
				"    tiers:",
				"      standard: { targets: [{ provider: anthropic, model: sonnet }] }",
				"  economy:",
				"    tiers:",
				"      standard: { targets: [{ provider: deepseek, model: flash }] }",
				"activate:",
				"  - { path: /tmp, profile: economy }",
				"  - { path: /tmp/work, profile: premium }",
			].join("\n"),
			async () => {
				const api = new MockExtensionApi();
				api.models = MODELS;
				autoRouterExtension(api);
				const ctx = api.makeCtx({ cwd: "/tmp/work/sub/dir" });
				await api.fire("session_start", ctx);
				await flushBoot();
				expect(api.modelSwitches).toContain("auto-router/premium");
				expect(api.modelSwitches).not.toContain("auto-router/economy");
				const stateEntry = api.entries.find((e) => e.customType === "com.omp.auto-router.state");
				expect(stateEntry?.data).toEqual({ profile: "premium" });
			},
		);
	});

	test("a subagent session_start (hasUI:false) does not clobber the main ctx", async () => {
		await withAgentDir(BASE_CONFIG, async () => {
			const api = new MockExtensionApi();
			api.models = MODELS;
			autoRouterExtension(api);
			await api.fire("session_start", api.makeCtx());
			await flushBoot();
			await api.fire("session_start", api.makeCtx({ hasUI: false }));
			await flushBoot();
			const debug = api.logs.filter((l) => l[0] === "debug").map((l) => String(l[1]));
			expect(debug.some((m) => m.includes("ignoring subagent session_start"))).toBe(true);
		});
	});

	test("an interactive session_start replaces an earlier headless ctx", async () => {
		await withAgentDir(
			[
				BASE_CONFIG,
				"  premium:",
				"    tiers:",
				"      standard: { targets: [{ provider: anthropic, model: sonnet }] }",
				"activate:",
				"  - { path: /tmp/work, profile: premium }",
			].join("\n"),
			async () => {
				const api = new MockExtensionApi();
				api.models = MODELS;
				autoRouterExtension(api);
				// Headless main adopts first, on a path that activates nothing…
				await api.fire("session_start", api.makeCtx({ hasUI: false, cwd: "/elsewhere" }));
				await flushBoot();
				expect(api.modelSwitches.length).toBe(0);
				// …then an interactive session boots again and path-activates.
				await api.fire("session_start", api.makeCtx({ hasUI: true }));
				await flushBoot();
				expect(api.modelSwitches).toEqual(["auto-router/premium"]);
				const debug = api.logs.filter((l) => l[0] === "debug").map((l) => String(l[1]));
				expect(debug.some((m) => m.includes("ignoring subagent session_start"))).toBe(false);
			},
		);
	});

	test("decisions persisted in the session branch are restored and drive sticky escalation", async () => {
		await withAgentDir(BASE_CONFIG, async () => {
			const api = new MockExtensionApi();
			api.models = MODELS;
			autoRouterExtension(api);
			// Pre-seed a prior complex decision in the branch (restoreDecisions reads it).
			api.entries.push({
				customType: "com.omp.auto-router.decision",
				data: { profile: "main", tier: "complex", confidence: 0.9, decidedAt: Date.now() - 1_000 },
			});
			await api.fire("session_start", api.makeCtx());
			await flushBoot();

			streamCalls.length = 0;
			const provider = api.providers.get("auto-router");
			expect(provider).toBeDefined();
			const stream = provider!.streamSimple!(
				{ provider: "auto-router", id: "main", api: "auto-router" },
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
				{},
			);
			for await (const _event of stream as AsyncGenerator<unknown>) { /* drain */ }
			// Trivial prompt, but sticky escalation from the restored complex tier
			// routes to the complex-tier target.
			expect(streamCalls).toEqual([{ provider: "anthropic", model: "sonnet" }]);
			const decision = api.entries.find(
				(e) => e.customType === "com.omp.auto-router.decision" && (e.data as { tier?: string })?.tier === "complex" && (e.data as { confidence?: number })?.confidence !== 0.9,
			);
			expect(decision).toBeDefined();
		});
	});

	test("a failing test command escalates the next request by one tier", async () => {
		await withAgentDir(BASE_CONFIG, async () => {
			const api = new MockExtensionApi();
			api.models = MODELS;
			autoRouterExtension(api);
			const ctx = api.makeCtx();
			await api.fire("session_start", ctx);
			await flushBoot();

			await api.fire("tool_result", ctx, {
				toolName: "bash",
				input: { command: "bun test tests/" },
				isError: true,
			});

			streamCalls.length = 0;
			const stream = api.providers.get("auto-router")!.streamSimple!(
				{ provider: "auto-router", id: "main", api: "auto-router" },
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
				{},
			);
			for await (const _event of stream as AsyncGenerator<unknown>) { /* drain */ }
			// Trivial prompt, but the recent test failure raises the floor to standard.
			expect(streamCalls).toEqual([{ provider: "anthropic", model: "sonnet" }]);
		});
	});

	test("a passing test command clears the escalation", async () => {
		await withAgentDir(BASE_CONFIG, async () => {
			const api = new MockExtensionApi();
			api.models = MODELS;
			autoRouterExtension(api);
			const ctx = api.makeCtx();
			await api.fire("session_start", ctx);
			await flushBoot();

			await api.fire("tool_result", ctx, { toolName: "bash", input: { command: "bun test" }, isError: true });
			await api.fire("tool_result", ctx, { toolName: "bash", input: { command: "bun test" }, isError: false });

			streamCalls.length = 0;
			const stream = api.providers.get("auto-router")!.streamSimple!(
				{ provider: "auto-router", id: "main", api: "auto-router" },
				{ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
				{},
			);
			for await (const _event of stream as AsyncGenerator<unknown>) { /* drain */ }
			expect(streamCalls).toEqual([{ provider: "deepseek", model: "flash" }]);
		});
	});
});
