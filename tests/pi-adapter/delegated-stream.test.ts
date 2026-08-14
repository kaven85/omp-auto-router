import { describe, expect, test } from "bun:test";

import {
	delegatePiTarget,
	inspectPiModeACapabilities,
	PiDelegationError,
	type PiPublicModel,
} from "../../src/pi-adapter/delegated-stream";

const target = { provider: "anthropic", model: "claude-sonnet" };
const model = {
	provider: "anthropic",
	id: "claude-sonnet",
	api: "anthropic-messages",
	baseUrl: "https://catalog.example.test",
};
const context = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };

function createRegistry(overrides: Partial<Parameters<typeof delegatePiTarget>[0]> = {}) {
	const calls: Array<{ model: PiPublicModel; options: Record<string, unknown> | undefined }> = [];
	const provider = {
		streamSimple(modelArg: PiPublicModel, _context: unknown, options?: Record<string, unknown>) {
			calls.push({ model: modelArg, options });
			return (async function* () {
				yield { type: "start" };
				yield { type: "thinking_delta", delta: "considering" };
				yield { type: "toolcall_start" };
				yield {
					type: "done",
					reason: "stop",
					message: {
						provider: "anthropic",
						model: "claude-sonnet",
						usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 },
					},
				};
			})();
		},
	};
	return {
		calls,
		registry: {
			find: () => model,
			getProvider: () => provider,
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: "target-key",
				headers: { "x-target": "yes" },
				baseUrl: "https://resolved.example.test",
				env: { TARGET_REGION: "test" },
			}),
			...overrides,
		},
	};
}

describe("Pi public Mode A delegation seam", () => {
	test("delegates text, thinking, tool calls, and terminal usage with target authentication", async () => {
		const { registry, calls } = createRegistry();

		const stream = await delegatePiTarget(registry, target, context, {
			apiKey: "virtual-key",
			headers: { "x-virtual": "no" },
			env: { VIRTUAL_PROVIDER: "no" },
			reasoning: "low",
			signal: new AbortController().signal,
			cacheRetention: "long",
		});
		const events: Array<{ type: string }> = [];
		for await (const event of stream) events.push(event as { type: string });

		expect(events.map((event) => event.type)).toEqual(["start", "thinking_delta", "toolcall_start", "done"]);
		expect(events[3]).toMatchObject({
			type: "done",
			message: { usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 } },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			model: { ...model, baseUrl: "https://resolved.example.test" },
			options: {
				signal: expect.any(AbortSignal),
				cacheRetention: "long",
				apiKey: "target-key",
				headers: { "x-target": "yes" },
				env: { TARGET_REGION: "test" },
			},
		});
	});

	test("applies router-selected thinking only after virtual reasoning is removed", async () => {
		const { registry, calls } = createRegistry();

		await delegatePiTarget(registry, target, context, { reasoning: "low" }, { reasoning: "high" });

		expect(calls[0]?.options).toMatchObject({ reasoning: "high", apiKey: "target-key" });
	});

	test("preserves cancellation and safe behavioral options while replacing virtual credentials", async () => {
		const { registry, calls } = createRegistry();
		const controller = new AbortController();
		const onResponse = () => {};

		await delegatePiTarget(registry, target, context, {
			signal: controller.signal,
			onResponse,
			apiKey: "virtual-key",
			headers: { Authorization: "Bearer virtual-key" },
			env: { VIRTUAL: "1" },
			reasoning: "high",
		});

		expect(calls[0]?.options).toEqual({
			signal: controller.signal,
			onResponse,
			apiKey: "target-key",
			headers: { "x-target": "yes" },
			env: { TARGET_REGION: "test" },
		});
	});

	test("fails with an actionable error when a required public capability is absent", async () => {
		const { registry } = createRegistry({ getProvider: undefined });

		expect(inspectPiModeACapabilities(registry)).toEqual({
			supported: false,
			missing: ["getProvider"],
		});
		expect(delegatePiTarget(registry, target, context)).rejects.toEqual(
			expect.objectContaining({
			name: "PiDelegationError",
			message: "Pi Mode A delegation requires public ModelRegistry capability: getProvider",
		}),
		);
	});

	test("rejects missing targets, rejected authentication, and recursive virtual targets without consulting host internals", async () => {
		const { registry } = createRegistry({ find: () => undefined });

		await expect(delegatePiTarget(registry, target, context)).rejects.toBeInstanceOf(PiDelegationError);
		await expect(
			delegatePiTarget(
				createRegistry({ getApiKeyAndHeaders: async () => ({ ok: false, error: "login required" }) }).registry,
				target,
				context,
			),
		).rejects.toMatchObject({
			message: "Pi target authentication failed for anthropic/claude-sonnet: login required",
		});
		await expect(
			delegatePiTarget(createRegistry().registry, { provider: "auto-router", model: "premium" }, context),
		).rejects.toMatchObject({ message: "auto-router cannot delegate to its virtual provider" });
	});
});
