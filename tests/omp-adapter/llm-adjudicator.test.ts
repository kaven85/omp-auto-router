import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * streamSimple is host-bundled (@oh-my-pi/pi-ai, resolved by the omp loader);
 * stub it before importing the adjudicator.
 */

let streamBehavior: () => AsyncGenerator<{ type: string; delta?: string }>;

mock.module("@oh-my-pi/pi-ai", () => ({
	streamSimple() {
		return streamBehavior();
	},
}));

const { adjudicateTier } = await import(
	"../../src/omp-adapter/llm-adjudicator"
);
const { createAdapterState } = await import("../../src/omp-adapter/state");
const { MockExtensionApi } = await import("./mock-omp");
import type { OmpModel } from "../../src/omp-adapter/omp-api";
import type { RouterConfig } from "../../src/core/types";

const CONFIG: RouterConfig = {
	active: "premium",
	profiles: {
		premium: {
			defaultTier: "standard",
			tiers: {
				standard: { targets: [{ provider: "anthropic", model: "sonnet" }] },
				complex: { targets: [{ provider: "anthropic", model: "opus" }] },
			},
		},
	},
};

const MODELS: OmpModel[] = [
	{ provider: "anthropic", id: "sonnet", api: "anthropic-messages", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	{ provider: "anthropic", id: "opus", api: "anthropic-messages", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16_384, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
];

const NO_AUTH = { getApiKey: async () => undefined };

function setup() {
	const api = new MockExtensionApi();
	api.models = MODELS;
	const dir = mkdtempSync(join(tmpdir(), "ar-adjudicate-"));
	const state = createAdapterState(CONFIG, dir, "/tmp/work");
	state.ctx = api.makeCtx();
	streamBehavior = async function* () {};
	return { state };
}

describe("llm adjudicator", () => {
	test("parses the tier word from the stream", async () => {
		const { state } = setup();
		streamBehavior = async function* () {
			yield { type: "text_delta", delta: "complex" };
		};
		const result = await adjudicateTier(
			state,
			NO_AUTH,
			{ provider: "anthropic", model: "sonnet" },
			"帮我设计并实现一个登录功能",
		);
		expect(result).toEqual({ tier: "complex", model: "anthropic/sonnet" });
	});

	test("unparseable reply → undefined (heuristic kept)", async () => {
		const { state } = setup();
		streamBehavior = async function* () {
			yield { type: "text_delta", delta: "I cannot tell" };
		};
		const result = await adjudicateTier(
			state,
			NO_AUTH,
			{ provider: "anthropic", model: "sonnet" },
			"帮我设计并实现一个登录功能",
		);
		expect(result).toBeUndefined();
	});

	test("accumulated reply is capped at 4096 chars", async () => {
		const { state } = setup();
		streamBehavior = async function* () {
			// First chunk fills past the cap; the tier word after it must be dropped.
			yield { type: "text_delta", delta: "x".repeat(5_000) };
			yield { type: "text_delta", delta: " complex" };
		};
		const result = await adjudicateTier(
			state,
			NO_AUTH,
			{ provider: "anthropic", model: "sonnet" },
			"帮我设计并实现一个登录功能",
		);
		expect(result).toBeUndefined();
	});

	test("stream errors fail open", async () => {
		const { state } = setup();
		streamBehavior = async function* () {
			throw new Error("provider down");
		};
		const result = await adjudicateTier(
			state,
			NO_AUTH,
			{ provider: "anthropic", model: "sonnet" },
			"帮我设计并实现一个登录功能",
		);
		expect(result).toBeUndefined();
	});

	test("unresolvable adjudicator model → undefined without a call", async () => {
		const { state } = setup();
		let called = false;
		streamBehavior = async function* () {
			called = true;
		};
		const result = await adjudicateTier(
			state,
			NO_AUTH,
			{ provider: "deepseek", model: "missing" },
			"帮我设计并实现一个登录功能",
		);
		expect(result).toBeUndefined();
		expect(called).toBe(false);
	});
});
