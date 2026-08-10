import { describe, expect, test, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The router delegates to the host-bundled `@oh-my-pi/pi-ai` modules at
 * runtime (resolved by the omp loader). In this standalone test env they
 * don't exist, so we intercept them with bun's mock.module BEFORE importing
 * the router.
 */

const streamCalls: Array<{ provider: string; model: string }> = [];
let streamBehavior: (model: { provider: string; id: string }) => AsyncGenerator<{ type: string; [k: string]: unknown }>;
let retryableBehavior: (error: unknown) => boolean;

mock.module("@oh-my-pi/pi-ai", () => ({
	streamSimple(model: { provider: string; id: string }) {
		streamCalls.push({ provider: model.provider, model: model.id });
		return streamBehavior(model);
	},
}));
mock.module("@oh-my-pi/pi-ai/error", () => ({
	isProviderRetryableError: (error: unknown) => retryableBehavior(error),
}));

const { createStreamHandler, buildWidgetLines, renderWidget, waitForSessionContext } = await import("../../src/omp-adapter/router");
const { createAdapterState } = await import("../../src/omp-adapter/state");
const { refreshModels } = await import("../../src/omp-adapter/state");
const { CircuitBreaker } = await import("../../src/core/circuit-breaker");
const { MockExtensionApi } = await import("./mock-omp");
import type { OmpModel } from "../../src/omp-adapter/omp-api";
import type { RouterConfig } from "../../src/core/types";

const CONFIG: RouterConfig = {
	active: "premium",
	profiles: {
		premium: {
			description: "订阅优先",
			defaultTier: "standard",
			tiers: {
				trivial: {
					thinking: "low",
					targets: [{ provider: "deepseek", model: "flash", billing: "per-token" }],
				},
				simple: {
					thinking: "low",
					targets: [{ provider: "deepseek", model: "flash", billing: "per-token" }],
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
						{ provider: "google", model: "gemini", billing: "per-token" },
					],
				},
			},
		},
	},
};

const MODELS: OmpModel[] = [
	{ provider: "anthropic", id: "sonnet", api: "anthropic-messages", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	{ provider: "anthropic", id: "opus", api: "anthropic-messages", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.5 } },
	{ provider: "deepseek", id: "flash", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 } },
	{ provider: "google", id: "gemini", api: "google-generative-ai", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 65_536, cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 } },
];

function setup() {
	const api = new MockExtensionApi();
	api.models = MODELS;
	const dir = mkdtempSync(join(tmpdir(), "ar-router-"));
	const state = createAdapterState(CONFIG, dir, "/tmp/work");
	const ctx = api.makeCtx();
	refreshModels(state, ctx);
	streamCalls.length = 0;
	streamBehavior = async function* () {};
	retryableBehavior = () => true;
	return { api, state, ctx, dir };
}

function contextWithPrompt(prompt: string) {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [
			{ role: "user" as const, content: [{ type: "text", text: prompt }] },
		],
		tools: [],
	};
}

describe("adapter router (Mode A)", () => {
	test("basic stream: routes, strips shortcut, forwards events", async () => {
		const { api, state, ctx, dir } = setup();
		streamBehavior = async function* () {
			yield { type: "start", contentIndex: 0, partial: {} };
			yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		const context = contextWithPrompt("@reasoning prove primes");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});

		const types: string[] = [];
		for await (const event of handler) types.push(event.type);
		expect(types).toEqual(["start", "text_delta", "done"]);
		// Shortcut stripped from the context the delegate sees.
		expect((context.messages[0]!.content as Array<{ text?: string }>)[0]!.text).toBe("prove primes");
		// Delegated to the complex-tier target (opus).
		expect(streamCalls).toEqual([{ provider: "anthropic", model: "opus" }]);
		// Decision recorded + persisted.
		expect(state.lastDecision?.decision.tier).toBe("complex");
		expect(api.entries.some((e) => e.customType === "com.omp.auto-router.decision")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
	test("thinking level is applied during the delegate stream and restored afterwards", async () => {
		const { api, state } = setup();
		streamBehavior = async function* () {
			yield { type: "done", reason: "stop", message: {} };
		};
		state.ctx = api.makeCtx();
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context: contextWithPrompt("@reasoning prove primes"),
			options: {},
		});
		for await (const _event of handler) { /* drain */ }
		// complex tier config thinking=high; mock's pre-existing level is "medium".
		expect(api.thinkingLevels).toEqual(["high", "medium"]);
	});

	test("configured thinking is clamped into the target model's supported range", async () => {
		// deepseek-v4-pro accepts only high/max; a tier configured at "low" must
		// steer the host with "high", never "low".
		const api = new MockExtensionApi();
		api.models = [
			...MODELS,
			{ provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions", reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 } },
		];
		const config: RouterConfig = {
			active: "capped",
			profiles: {
				capped: {
					defaultTier: "complex",
					tiers: {
						complex: {
							thinking: "low",
							targets: [{ provider: "deepseek", model: "deepseek-v4-pro", billing: "per-token" }],
						},
					},
				},
			},
		};
		const dir = mkdtempSync(join(tmpdir(), "ar-clamp-"));
		const state = createAdapterState(config, dir, "/tmp/work");
		state.ctx = api.makeCtx();
		refreshModels(state, state.ctx);
		streamCalls.length = 0;
		streamBehavior = async function* () {
			yield { type: "done", reason: "stop", message: {} };
		};
		retryableBehavior = () => true;
		try {
			const handler = createStreamHandler(state, api, {
				model: { provider: "auto-router", id: "capped" },
				context: contextWithPrompt("@reasoning prove primes"),
				options: {},
			});
			for await (const _event of handler) { /* drain */ }
			// "low" clamped up to "high" (registry cap), then prior level restored.
			expect(api.thinkingLevels[0]).toBe("high");
			expect(api.thinkingLevels[0]).not.toBe("low");
			// A clamp warning is recorded for diagnosis.
			const events = state.eventLog.readAll();
			expect(
				events.some(
					(e) =>
						e.type === "warn" &&
						e.what === "thinking-clamped" &&
						e.target === "deepseek/deepseek-v4-pro" &&
						e.from === "low" &&
						e.to === "high",
				),
			).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("thinking level is not touched in shadow mode", async () => {
		const { api, state } = setup();
		state.shadowEnabled = true;
		streamBehavior = async function* () {
			yield { type: "done", reason: "stop", message: {} };
		};
		state.ctx = api.makeCtx();
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context: contextWithPrompt("@reasoning prove primes"),
			options: {},
		});
		for await (const _event of handler) { /* drain */ }
		expect(api.thinkingLevels).toEqual([]);
	});

	test("circuit and latency snapshots persist after a stream settles", async () => {
		const { api, state, dir } = setup();
		streamBehavior = async function* () {
			yield { type: "done", reason: "stop", message: {} };
		};
		state.ctx = api.makeCtx();
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context: contextWithPrompt("@reasoning prove primes"),
			options: {},
		});
		for await (const _event of handler) { /* drain */ }
		// A fresh state over the same dir warm-starts from the persisted snapshots.
		const revived = createAdapterState(CONFIG, dir, "/tmp/work");
		expect(revived.latency.average("anthropic/opus")).toBeGreaterThanOrEqual(0);
	});

	test("a failed target is cooled down and skipped on the next request", async () => {
		const { api, state, ctx } = setup();
		state.ctx = ctx;
		streamBehavior = (model) =>
			model.provider === "anthropic"
				? (async function* (): AsyncGenerator<{ type: string; [k: string]: unknown }> {
						throw new Error("overloaded");
					})()
				: (async function* () {
						yield { type: "done", reason: "stop", message: {} };
					})();
		const run = async () => {
			const handler = createStreamHandler(state, api, {
				model: { provider: "auto-router", id: "premium" },
				context: contextWithPrompt("@reasoning prove primes"),
				options: {},
			});
			for await (const _event of handler) { /* drain */ }
		};
		await run();
		expect(streamCalls).toEqual([
			{ provider: "anthropic", model: "opus" },
			{ provider: "google", model: "gemini" },
		]);
		streamCalls.length = 0;
		await run();
		// anthropic/opus failed last time → cooldown excludes it; gemini serves directly.
		expect(streamCalls).toEqual([{ provider: "google", model: "gemini" }]);
	});

	test("poorly rated candidates are demoted behind the rest of the chain", async () => {
		const { api, state, ctx } = setup();
		state.ctx = ctx;
		// flash is cheaper and would normally sort first; 5 bad ratings demote it.
		for (let i = 0; i < 5; i++) {
			state.ratings.rate({ provider: "deepseek", model: "flash", rating: "bad", tier: "standard", profile: "premium" });
		}
		streamBehavior = async function* () {
			yield { type: "done", reason: "stop", message: {} };
		};
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context: contextWithPrompt("summarize this document"),
			options: {},
		});
		for await (const _event of handler) { /* drain */ }
		expect(streamCalls[0]).toEqual({ provider: "anthropic", model: "sonnet" });
		expect(state.lastDecision?.decision.orderedCandidates.at(-1)).toEqual({ provider: "deepseek", model: "flash", billing: "per-token" });
	});

	test("uses ctx.getContextUsage() as the authoritative token estimate", async () => {
		const { api, state, ctx } = setup();
		streamBehavior = async function* () {
			yield { type: "done", reason: "stop", message: {} };
		};
		state.ctx = api.makeCtx({ getContextUsage: () => ({ totalTokens: 150_000 }) });
		const context = contextWithPrompt("hi");
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		for await (const _event of handler) { /* drain */ }
		expect(state.lastDecision?.decision.estimatedTokens).toBe(150_000);
	});

	test("falls back to summing all context text when getContextUsage returns nothing usable", async () => {
		const { api, state } = setup();
		streamBehavior = async function* () {
			yield { type: "done", reason: "stop", message: {} };
		};
		state.ctx = api.makeCtx({ getContextUsage: () => undefined });
		const context = contextWithPrompt("hello world");
		context.systemPrompt = ["sys"];
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		for await (const _event of handler) { /* drain */ }
		expect(state.lastDecision?.decision.estimatedTokens).toBe(4);
	});

	test("models discovered after the initial snapshot remain routable", async () => {
		const api = new MockExtensionApi();
		const dir = mkdtempSync(join(tmpdir(), "ar-router-late-model-"));
		const state = createAdapterState(CONFIG, dir, "/tmp/work");
		const ctx = api.makeCtx({
			setTimeout: (fn) => {
				queueMicrotask(fn);
				return 0;
			},
		});
		refreshModels(state, ctx);
		queueMicrotask(() => {
			api.models = MODELS;
		});
		streamCalls.length = 0;
		streamBehavior = async function* () {
			yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		retryableBehavior = () => true;
		state.ctx = ctx;

		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context: contextWithPrompt("@reasoning prove primes"),
			options: {},
		});
		const types: string[] = [];
		for await (const event of handler) types.push(event.type);

		expect(types).toEqual(["text_delta", "done"]);
		expect(streamCalls).toEqual([{ provider: "anthropic", model: "opus" }]);
		rmSync(dir, { recursive: true, force: true });
	});
	test("reload retains session context for subsequent streams", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "ar-router-reload-"));
		mkdirSync(join(configDir, "auto-router"), { recursive: true });
		writeFileSync(
			join(configDir, "auto-router.yml"),
			[
				"active: premium",
				"profiles:",
				"  premium:",
				"    description: test",
				"    defaultTier: standard",
				"    tiers:",
				"      trivial: { thinking: low, targets: [{ provider: anthropic, model: sonnet }] }",
				"      simple: { thinking: low, targets: [{ provider: anthropic, model: sonnet }] }",
				"      standard: { thinking: medium, targets: [{ provider: anthropic, model: sonnet }] }",
				"      complex: { thinking: high, targets: [{ provider: anthropic, model: opus }] }",
			].join("\n"),
		);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = configDir;
		try {
			const { default: autoRouterExtension } = await import("../../src/omp-adapter/index");
			const api = new MockExtensionApi();
			api.models = MODELS;
			autoRouterExtension(api);
			const ctx = api.makeCtx();
			await api.fire("session_start", ctx);
			await api.commands.get("auto-router")!.handler("reload", ctx);
			streamBehavior = async function* () {
				yield { type: "done", reason: "stop", message: {} };
			};
			const stream = api.providers.get("auto-router")!.streamSimple!(
				{ provider: "auto-router", id: "premium", api: "auto-router" },
				contextWithPrompt("hello"),
			);
			const events = [];
			for await (const event of stream) events.push(event);
			expect(events).toEqual([{ type: "done", reason: "stop", message: {} }]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(configDir, { recursive: true, force: true });
		}
	});
	test("stream before session_start waits for the boot event and routes", async () => {
		const { api, state, ctx, dir } = setup();
		streamBehavior = async function* () {
			yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		// ctx lands on a microtask, as a slow session_start would.
		queueMicrotask(() => {
			state.ctx = ctx;
		});
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context: contextWithPrompt("@reasoning prove primes"),
			options: {},
		});
		const types: string[] = [];
		for await (const event of handler) types.push(event.type);
		expect(types).toEqual(["text_delta", "done"]);
		expect(streamCalls).toEqual([{ provider: "anthropic", model: "opus" }]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("stream with no session context fails with an actionable error", async () => {
		const { api, state, dir } = setup();
		const controller = new AbortController();
		controller.abort();
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context: contextWithPrompt("@reasoning prove primes"),
			options: { signal: controller.signal },
		});
		const events: Array<{ type: string; [k: string]: unknown }> = [];
		for await (const event of handler) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("error");
		// failWith contract: adapter errors carry an assistant message.
		const errorMessage = events[0]!.error as { content?: Array<{ text?: string }> };
		expect(errorMessage.content?.[0]?.text ?? "").toContain("session context not ready");
		rmSync(dir, { recursive: true, force: true });
	});

	test("waitForSessionContext returns immediately when ctx is already set", async () => {
		const { state, ctx } = setup();
		state.ctx = ctx;
		await expect(waitForSessionContext(state, undefined, 5_000)).resolves.toBe(ctx);
	});

	test("waitForSessionContext returns ctx that lands mid-wait", async () => {
		const { state, ctx } = setup();
		queueMicrotask(() => {
			state.ctx = ctx;
		});
		const got = await waitForSessionContext(state, undefined, 1_000);
		expect(got).toBe(ctx);
	});

	test("waitForSessionContext times out with undefined", async () => {
		const { state } = setup();
		const started = Date.now();
		const got = await waitForSessionContext(state, undefined, 30);
		expect(got).toBeUndefined();
		expect(Date.now() - started).toBeGreaterThanOrEqual(20);
	});

	test("waitForSessionContext aborts immediately on signal", async () => {
		const { state } = setup();
		const controller = new AbortController();
		controller.abort();
		const got = await waitForSessionContext(state, controller.signal, 5_000);
		expect(got).toBeUndefined();
	});

	test("rewriting user text keeps image parts", async () => {
		const { api, state, ctx, dir } = setup();
		streamBehavior = async function* () {
			yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		const context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{
					role: "user" as const,
					content: [
						{ type: "text", text: "@reasoning describe this photo" },
						{ type: "image", data: "base64data", mediaType: "image/png" },
					],
				},
			],
			tools: [],
		};
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		for await (const _event of handler) {
			// drain
		}
		const content = context.messages[0]!.content as Array<{ type: string; [k: string]: unknown }>;
		// Shortcut stripped, image preserved, text replaced.
		expect(content.filter((p) => p.type === "text").map((p) => p.text).join("")).toBe("describe this photo");
		expect(content.some((p) => p.type === "image" && p.data === "base64data")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});


	test("failover: first target errors, second target settles", async () => {
		const { api, state, ctx, dir } = setup();
		// One failure must open the breaker for this assertion.
		state.circuit = new CircuitBreaker({ failureThreshold: 1 });
		streamBehavior = async function* (model) {
			if (model.provider === "anthropic" && model.id === "opus") {
				throw new Error("upstream 503 service unavailable");
			}
			yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		const context = contextWithPrompt("@reasoning hard problem");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});

		const types: string[] = [];
		for await (const event of handler) types.push(event.type);
		expect(types).toEqual(["text_delta", "done"]);
		expect(streamCalls).toEqual([
			{ provider: "anthropic", model: "opus" },
			{ provider: "google", model: "gemini" },
		]);
		// Failover + settle recorded.
		const events = state.eventLog.readAll();
		expect(events.some((e) => e.type === "failover" && e.from === "anthropic/opus" && e.to === "google/gemini")).toBe(true);
		// Circuit: opus failed, gemini succeeded.
		expect(state.circuit.state("anthropic/opus", Date.now())).toBe("open");
		expect(state.circuit.state("google/gemini", Date.now())).toBe("closed");
		// Latency recorded for the settled target.
		expect(state.latency.average("google/gemini")).toBeGreaterThanOrEqual(0);
		rmSync(dir, { recursive: true, force: true });
	});
	test("failover on quota exhaustion even when host classifier says non-retryable", async () => {
		const { api, state, ctx, dir } = setup();
		// omp's classifier does NOT treat a 403 permission_error as retryable —
		// the module wording classifier (usage-limit/overloaded) must still
		// trigger failover so an exhausted provider never hard-stops the chain.
		retryableBehavior = () => false;
		streamBehavior = async function* (model) {
			if (model.provider === "anthropic" && model.id === "opus") {
				throw {
					status: 403,
					error: {
						type: "permission_error",
						message:
							"You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
					},
				};
			}
			yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		const context = contextWithPrompt("@reasoning hard problem");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});

		const types: string[] = [];
		for await (const event of handler) types.push(event.type);
		expect(types).toEqual(["text_delta", "done"]);
		expect(streamCalls).toEqual([
			{ provider: "anthropic", model: "opus" },
			{ provider: "google", model: "gemini" },
		]);
		const events = state.eventLog.readAll();
		expect(events.some((e) => e.type === "failover" && e.from === "anthropic/opus" && e.to === "google/gemini")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("kimi profile: exhausted kimi fails over to deepseek (mirrors real config)", async () => {
		const api = new MockExtensionApi();
		// Mirrors ~/.omp/agent/auto-router.yml:kimi — kimi first, deepseek fallback.
		api.models = [
			{ provider: "kimi-code", id: "kimi-for-coding", api: "kimi-code", reasoning: false, input: ["text"], contextWindow: 256_000, maxTokens: 32_768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ provider: "deepseek", id: "deepseek-v4-flash", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 } },
		];
		const kimiConfig: RouterConfig = {
			active: "kimi",
			profiles: {
				kimi: {
					description: "kimi with deepseek fallback",
					defaultTier: "standard",
					tiers: {
						trivial: {
							thinking: "low",
							targets: [
								{ provider: "kimi-code", model: "kimi-for-coding" },
								{ provider: "deepseek", model: "deepseek-v4-flash" },
							],
						},
						simple: {
							thinking: "low",
							targets: [
								{ provider: "kimi-code", model: "kimi-for-coding" },
								{ provider: "deepseek", model: "deepseek-v4-flash" },
							],
						},
						standard: {
							thinking: "high",
							targets: [
								{ provider: "kimi-code", model: "k3-256k" },
								{ provider: "deepseek", model: "deepseek-v4-flash" },
							],
						},
					},
				},
			},
		};
		const dir = mkdtempSync(join(tmpdir(), "ar-kimi-"));
		const state = createAdapterState(kimiConfig, dir, "/tmp/work");
		const ctx = api.makeCtx();
		refreshModels(state, ctx);
		retryableBehavior = () => false; // host classifier treats 403 as non-retryable
		streamCalls.length = 0;
		streamBehavior = async function* (model) {
			if (model.provider === "kimi-code") {
				throw {
					status: 403,
					error: {
						type: "permission_error",
						message:
							"You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage: https://www.kimi.com/code/#pricing",
					},
				};
			}
			yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "kimi" },
			context: contextWithPrompt("hello"),
			options: {},
		});

		const types: string[] = [];
		for await (const event of handler) types.push(event.type);
		// kimi exhausted → deepseek settles.
		expect(types).toEqual(["text_delta", "done"]);
		expect(streamCalls).toEqual([
			{ provider: "kimi-code", model: "kimi-for-coding" },
			{ provider: "deepseek", model: "deepseek-v4-flash" },
		]);
		const events = state.eventLog.readAll();
		expect(
			events.some(
				(e) => e.type === "failover" && e.from === "kimi-code/kimi-for-coding" && e.to === "deepseek/deepseek-v4-flash",
			),
		).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});


	test("no failover after substantive output", async () => {
		const { api, state, ctx, dir } = setup();
		streamBehavior = async function* (model) {
			if (model.provider === "anthropic" && model.id === "opus") {
				yield { type: "text_delta", contentIndex: 0, delta: "partial answer", partial: {} };
				throw new Error("late failure after content");
			}
			yield { type: "text_delta", contentIndex: 0, delta: "should not happen", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		const context = contextWithPrompt("@reasoning hard problem");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});

		// Once substantive content was emitted the engine rethrows late failures:
		// no failover, no error event — the host owns the failure now.
		const consume = async () => {
			for await (const _event of handler) {
				// drain
			}
		};
		await expect(consume()).rejects.toThrow("late failure after content");
		// Only the first target was tried.
		expect(streamCalls).toEqual([{ provider: "anthropic", model: "opus" }]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("thinking-only partials still allow failover", async () => {
		const { api, state, ctx, dir } = setup();
		streamBehavior = async function* (model) {
			if (model.provider === "anthropic" && model.id === "opus") {
				yield { type: "thinking_delta", contentIndex: 0, delta: "…", partial: {} };
				throw new Error("died after thinking, before text");
			}
			yield { type: "text_delta", contentIndex: 0, delta: "survived", partial: {} };
			yield { type: "done", reason: "stop", message: {} };
		};
		const context = contextWithPrompt("@reasoning hard problem");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});

		const types: string[] = [];
		for await (const event of handler) types.push(event.type);
		expect(types).toEqual(["text_delta", "done"]);
		expect(streamCalls.length).toBe(2);
		rmSync(dir, { recursive: true, force: true });
	});

	test("unknown profile yields a terminal error event without crashing", async () => {
		const { api, state, ctx, dir } = setup();
		const context = contextWithPrompt("hello");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "does-not-exist" },
			context,
			options: {},
		});
		const events: Array<{ type: string; [key: string]: unknown }> = [];
		for await (const event of handler) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(streamCalls).toEqual([]);
		// OMP clones terminal assistant messages via `{ ...message.usage.cost }`.
		// Keep this deliberately exact so a malformed adapter error reproduces
		// the host's "undefined is not an object (evaluating 'A.usage.cost')".
		const errorMessage = events[0]?.error as unknown as {
			usage: { cost: Record<string, number> };
		};
		expect(() => ({ ...errorMessage.usage.cost })).not.toThrow();
		rmSync(dir, { recursive: true, force: true });
	});

	test("quota feeds UVI and excludes critical providers", async () => {
		const { api, state, ctx, dir } = setup();
		// google just-started window with full usage → critical UVI
		const criticalReport = {
			provider: "google",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "5h",
					window: { windowSeconds: 3600, resetsAt: Date.now() + 3600_000 },
					amount: { usedFraction: 1.0 },
				},
			],
		};
		ctx.modelRegistry.authStorage.fetchUsageReports = async () => [criticalReport];
		state.ctx = ctx;
		const context = contextWithPrompt("@reasoning design a distributed system");
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		for await (const _event of handler) {
			// drain
		}
		expect(state.lastDecision?.decision.hints.uvi.google?.status).toBe("critical");
		// critical google excluded → settled on opus
		expect(streamCalls).toEqual([{ provider: "anthropic", model: "opus" }]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("usage from done event is recorded into budgets and event log", async () => {
		const { api, state, ctx, dir } = setup();
		streamBehavior = async function* () {
			yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} };
			yield {
				type: "done",
				reason: "stop",
				message: { usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 } },
			};
		};
		const context = contextWithPrompt("@reasoning hard problem");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		for await (const _event of handler) {
			// drain
		}
		// settled on opus (cheapest complex target) → usage attributed to anthropic
		const usage = state.budgets.usage("anthropic", new Date());
		expect(usage.daily?.inputTokens).toBe(1000);
		expect(usage.daily?.outputTokens).toBe(500);
		expect(usage.daily!.cost).toBeGreaterThan(0);
		const settled = state.eventLog.readAll().filter((e) => e.type === "settled");
		expect(settled.length).toBe(1);
		expect(settled[0]!.provider).toBe("anthropic");
		rmSync(dir, { recursive: true, force: true });
	});

	test("shadow mode routes in config order instead of partitioned order", async () => {
		const { api, state, ctx, dir } = setup();
		state.shadowEnabled = true;
		// @swe → standard tier [sonnet (cost 18), flash (cost 1.37)]; partitioned
		// order would put flash first; shadow keeps config order.
		const context = contextWithPrompt("@swe implement a function");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		for await (const _event of handler) {
			// drain
		}
		expect(state.lastDecision?.decision.orderedCandidates).toEqual([
			{ provider: "anthropic", model: "sonnet" },
			{ provider: "deepseek", model: "flash", billing: "per-token" },
		]);
		expect(streamCalls[0]).toEqual({ provider: "anthropic", model: "sonnet" });
		rmSync(dir, { recursive: true, force: true });
	});

	test("no eligible candidates yields actionable error instead of throwing", async () => {
		const { api, state, ctx, dir } = setup();
		// Open the breaker for every complex-tier target so @reasoning has
		// nothing to fail over to.
		state.circuit = new CircuitBreaker({ failureThreshold: 1 });
		state.circuit.recordFailure("anthropic/opus", Date.now());
		state.circuit.recordFailure("google/gemini", Date.now());
		const context = contextWithPrompt("@reasoning hard problem");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		const events: Array<{ type: string; [k: string]: unknown }> = [];
		for await (const event of handler) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("error");
		const text = errorText(events[0]!);
		expect(text).toContain("no eligible candidates");
		expect(text).toContain("circuit breaker open");
		// Nothing delegated downstream; decision still recorded for explain.
		expect(streamCalls).toEqual([]);
		expect(state.lastDecision?.decision.orderedCandidates).toEqual([]);
		expect(api.entries.some((e) => e.customType === "com.omp.auto-router.decision")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("shadow mode with no healthy targets yields actionable error instead of throwing", async () => {
		const { api, state, dir } = setup();
		// Empty host registry → host.isHealthy(t) false for every target.
		api.models = [];
		const ctx = api.makeCtx();
		state.shadowEnabled = true;
		// Skip the async discovery grace loop — mock ctx.setTimeout never fires.
		state.modelsReady = true;
		const context = contextWithPrompt("@swe implement a function");
		state.ctx = ctx;
		const handler = createStreamHandler(state, api, {
			model: { provider: "auto-router", id: "premium" },
			context,
			options: {},
		});
		const events: Array<{ type: string; [k: string]: unknown }> = [];
		for await (const event of handler) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("error");
		expect(errorText(events[0]!)).toContain("no eligible candidates");
		expect(streamCalls).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});
});

/** Narrow an adapter `error` event to its assistant text payload. */
function errorText(event: { type: string; [k: string]: unknown }): string {
	const err = event.error;
	if (err === null || typeof err !== "object" || !("content" in err)) return "";
	const content = err.content;
	if (!Array.isArray(content)) return "";
	const first = content[0];
	if (first === null || typeof first !== "object" || !("text" in first)) return "";
	return typeof first.text === "string" ? first.text : "";
}

describe("widget rendering", () => {
	test("uvi window past resetsAt renders as freshly reset", () => {
		const { state, dir } = setup();
		state.quotaCache = {
			at: Date.now(),
			data: [
				{
					provider: "roll-a",
					fetchedAt: Date.now() - 60_000,
					windows: [{ id: "5h", usedFraction: 0.8, resetsAt: Date.now() - 1_000 }],
				},
				{
					provider: "roll-b",
					fetchedAt: Date.now() - 60_000,
					windows: [{ id: "5h", usedFraction: 0.8, resetsAt: Date.now() + 3_600_000 }],
				},
			],
		};
		const lines = buildWidgetLines(state);
		expect(lines).toEqual(["uvi: roll-a 100% left · roll-b 20% left"]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("without a decision the widget shows status lines only", () => {
		const { state, dir } = setup();
		state.quotaCache = {
			at: Date.now(),
			data: [{ provider: "solo-p", fetchedAt: Date.now(), windows: [{ id: "7d", usedFraction: 0.5 }] }],
		};
		const lines = buildWidgetLines(state);
		expect(lines).toEqual(["uvi: solo-p 50% left"]);
		rmSync(dir, { recursive: true, force: true });
	});

	test("renderWidget suppresses identical re-renders", () => {
		const { state, dir } = setup();
		state.quotaCache = {
			at: Date.now(),
			data: [{ provider: "dedupe-p", fetchedAt: Date.now(), windows: [{ id: "7d", usedFraction: 0.25 }] }],
		};
		const calls: string[][] = [];
		const host = { setWidget: (lines: string[]) => calls.push(lines) };
		renderWidget(state, host);
		renderWidget(state, host);
		expect(calls).toHaveLength(1);
		// Fresh data changes the payload → renders again.
		state.quotaCache = {
			at: Date.now(),
			data: [{ provider: "dedupe-p", fetchedAt: Date.now(), windows: [{ id: "7d", usedFraction: 0.5 }] }],
		};
		renderWidget(state, host);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(["uvi: dedupe-p 50% left"]);
		rmSync(dir, { recursive: true, force: true });
	});
});
