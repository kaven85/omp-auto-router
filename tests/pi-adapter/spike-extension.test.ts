import { describe, expect, test } from "bun:test";

import spikeExtension from "../../src/pi-adapter/spike-extension";

const realModel = {
	provider: "anthropic",
	id: "claude-sonnet",
	api: "anthropic-messages",
	reasoning: true,
	input: ["text"] as const,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 16_384,
};

describe("Pi Mode A spike extension", () => {
	test("registers a selectable virtual model and delegates it to the preceding real model", async () => {
		const providers = new Map<string, Record<string, unknown>>();
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
		const targetCalls: Array<{ provider: string; model: string; apiKey?: string }> = [];
		const pi = {
			registerProvider(name: string, config: Record<string, unknown>) {
				providers.set(name, config);
			},
			on(name: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
				handlers.set(name, handler);
			},
		};

		spikeExtension(pi as never);
		const config = providers.get("auto-router-spike");
		expect(config?.models).toEqual([
			expect.objectContaining({ id: "probe", name: "Auto Router Probe", reasoning: true }),
		]);

		const registry = {
			find: () => realModel,
			getProvider: () => ({
				streamSimple(model: typeof realModel, _context: unknown, options?: { apiKey?: string }) {
					targetCalls.push({ provider: model.provider, model: model.id, apiKey: options?.apiKey });
					return (async function* () {
						yield { type: "text_delta", delta: "delegated" };
						yield {
							type: "done",
							reason: "stop",
							message: { provider: model.provider, model: model.id, usage: { input: 1, output: 1 } },
						};
					})();
				},
			}),
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "target-key" }),
		};
		await handlers.get("session_start")?.({}, { model: realModel, modelRegistry: registry });

		const streamSimple = config?.streamSimple as (
			model: unknown,
			context: unknown,
			options?: { signal?: AbortSignal },
		) => AsyncIterable<{ type: string; [key: string]: unknown }>;
		const events = [];
		for await (const event of streamSimple({}, { messages: [] }, {})) events.push(event);

		expect(targetCalls).toEqual([{ provider: "anthropic", model: "claude-sonnet", apiKey: "target-key" }]);
		expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
	});
});
