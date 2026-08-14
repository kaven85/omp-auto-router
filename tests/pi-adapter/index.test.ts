import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piAutoRouterExtension from "../../src/pi-adapter/index";

describe("Pi auto-router adapter", () => {
	test("registers configured profiles and routes a virtual request through the effective target provider", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-router-"));
		const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "auto-router.yml"), `
active: work
profiles:
  work:
    tiers:
      standard:
        targets:
          - provider: target
            model: model-a
`);
		const providers = new Map<string, Record<string, unknown>>();
		const handlers = new Map<string, (event: never, context: never) => Promise<void> | void>();
		const notifications: string[] = [];
		const targetCalls: Array<{ apiKey?: string; prompt?: string }> = [];
		const targetModel = {
			provider: "target",
			id: "model-a",
			api: "openai-completions",
			reasoning: true,
			input: ["text"] as const,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		};
		const registry = {
			find(provider: string, id: string) {
				return provider === "target" && id === "model-a" ? targetModel : provider === "auto-router" ? providers.get("auto-router")?.models && { ...targetModel, provider, id } : undefined;
			},
			getAvailable: () => [targetModel],
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "target-key" }),
			getProvider: () => ({
				streamSimple(_model: unknown, context: { messages: Array<{ content: Array<{ text?: string }> }> }, options?: { apiKey?: string }) {
					targetCalls.push({ apiKey: options?.apiKey, prompt: context.messages.at(-1)?.content[0]?.text });
					return (async function* () {
						yield { type: "text_delta", delta: "routed" };
						yield { type: "done", reason: "stop", message: { provider: "target", model: "model-a", usage: { input: 2, output: 1 } } };
					})();
				},
			}),
		};
		const context = {
			cwd: "/work",
			mode: "print" as const,
			hasUI: false,
			model: targetModel,
			modelRegistry: registry,
			scopedModels: [],
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: 4, contextWindow: 200_000, percent: 0 }),
			sessionManager: { getBranch: () => [] },
			ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {} },
		};
		const pi = {
			registerProvider(name: string, config: Record<string, unknown>) { providers.set(name, config); },
			registerCommand() {},
			on(name: string, handler: (event: never, context: never) => Promise<void> | void) { handlers.set(name, handler); },
			appendEntry() {},
			setModel: async () => true,
		};

		try {
			piAutoRouterExtension(pi as never);
			await handlers.get("session_start")?.({} as never, context as never);
			const config = providers.get("auto-router");
			expect(config?.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "work" })]));
			const streamSimple = config?.streamSimple as (model: typeof targetModel, streamContext: unknown, options?: unknown) => AsyncIterable<{ type: string }>;
			const events = [];
			for await (const event of streamSimple({ ...targetModel, provider: "auto-router", id: "work" }, { messages: [{ role: "user", content: [{ type: "text", text: "@reasoning solve" }] }] }, {})) events.push(event);
			expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
			expect(targetCalls).toEqual([{ apiKey: "target-key", prompt: "solve" }]);
			expect(notifications).toEqual([]);
		} finally {
			if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
