import { afterEach, describe, expect, test } from "bun:test";

import { addTarget, baseModel, bootHarness, createPiHarness, type PiHarness } from "./mock-pi";

const TWO_TARGET_CONFIG = `
active: work
profiles:
  work:
    tiers:
      standard:
        thinking: high
        targets:
          - provider: alpha
            model: a1
          - provider: beta
            model: b1
`;

let harness: PiHarness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

async function boot(config: string, options: { trusted?: boolean } = {}): Promise<PiHarness> {
	harness = createPiHarness({ userConfig: config, trusted: options.trusted ?? false });
	await bootHarness(harness);
	return harness;
}

describe("Pi stream contract", () => {
	test("scope exclusion: targets outside a non-empty scopedModels allowlist are ineligible", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		const alpha = addTarget(h, baseModel("alpha", "a1"));
		addTarget(h, baseModel("beta", "b1"));
		// Scoped to beta only — alpha must never be attempted.
		h.context.scopedModels = [{ model: addTarget(h, baseModel("beta", "b1")) }];
		const events = await h.stream("work", "plain prompt");
		expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
		expect(h.streamCalls.map((call) => `${call.provider}/${call.model}`)).toEqual(["beta/b1"]);
		expect(alpha.provider).toBe("alpha");
	});

	test("empty scopedModels allows every available model", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"));
		addTarget(h, baseModel("beta", "b1"));
		const events = await h.stream("work", "plain prompt");
		expect(events.at(-1)?.type).toBe("done");
		expect(h.streamCalls[0]?.provider).toBe("alpha");
	});

	test("unauthenticated targets are rejected before streaming", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"));
		addTarget(h, baseModel("beta", "b1"));
		h.auth.set("alpha", { ok: false, error: "missing key" });
		const events = await h.stream("work", "plain prompt");
		expect(events.at(-1)?.type).toBe("done");
		expect(h.streamCalls.map((call) => call.provider)).toEqual(["beta"]);
	});

	test("all targets unauthenticated yields a structured assistant error event", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		h.auth.set("alpha", { ok: false, error: "missing key" });
		h.auth.set("beta", { ok: false, error: "missing key" });
		const events = await h.stream("work", "plain prompt");
		expect(events).toHaveLength(1);
		const error = events[0]!;
		expect(error.type).toBe("error");
		const message = error.error as {
			provider: string; model: string; stopReason: string; timestamp: number;
			usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };
			content: Array<{ type: string; text: string }>;
		};
		expect(message.provider).toBe("auto-router");
		expect(message.stopReason).toBe("error");
		expect(message.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
		expect(message.usage.cost.total).toBe(0);
		expect(message.content[0]?.text).toContain("no eligible candidates");
		expect(h.streamCalls).toEqual([]);
	});

	test("recursive auto-router targets are excluded from the candidate chain", async () => {
		const h = await boot(`
active: work
profiles:
  work:
    tiers:
      standard:
        targets:
          - provider: auto-router
            model: work
          - provider: beta
            model: b1
`);
		addTarget(h, baseModel("beta", "b1"));
		const events = await h.stream("work", "plain prompt");
		expect(events.at(-1)?.type).toBe("done");
		expect(h.streamCalls.map((call) => call.provider)).toEqual(["beta"]);
	});

	test("failover before substantive output cools only the failed target", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"), () => [{ type: "throw", error: "HTTP 429 rate limited" }]);
		addTarget(h, baseModel("beta", "b1"));
		const events = await h.stream("work", "plain prompt");
		expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
		expect(h.streamCalls.map((call) => call.provider)).toEqual(["alpha", "beta"]);

		// The cooled alpha is skipped on the next request.
		const second = await h.stream("work", "again");
		expect(second.at(-1)?.type).toBe("done");
		expect(h.streamCalls.map((call) => call.provider)).toEqual(["alpha", "beta", "beta"]);
	});

	test("thinking-only partial output does not block failover or leak into the reply", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"), () => [
			{ type: "thinking_delta", delta: "secret reasoning" },
			{ type: "throw", error: "HTTP 503 overloaded" },
		]);
		addTarget(h, baseModel("beta", "b1"));
		const events = await h.stream("work", "plain prompt");
		const text = events.filter((event) => event.type === "text_delta").map((event) => String(event.delta)).join("");
		expect(text).toBe("ok from beta/b1");
		expect(events.some((event) => event.type === "thinking_delta")).toBe(false);
	});

	test("no failover once substantive output started; the mid-stream error surfaces", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"), () => [
			{ type: "text_delta", delta: "partial" },
			{ type: "throw", error: "HTTP 500 exploded" },
		]);
		addTarget(h, baseModel("beta", "b1"));
		const events = await h.stream("work", "plain prompt");
		expect(events.map((event) => event.type)).toEqual(["text_delta", "error"]);
		expect(h.streamCalls.map((call) => call.provider)).toEqual(["alpha"]);
	});

	test("abort does not cool down the target", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"), () => [{ type: "throw", error: "aborted", name: "AbortError" }]);
		addTarget(h, baseModel("beta", "b1"));
		const events = await h.stream("work", "plain prompt");
		expect(events.at(-1)?.type).toBe("error");
		expect(h.streamCalls.map((call) => call.provider)).toEqual(["alpha"]);

		// A later request still starts with alpha — the abort recorded no failure.
		h.streams.set("alpha/a1", () => [
			{ type: "text_delta", delta: "recovered" },
			{ type: "done", reason: "stop", message: { provider: "alpha", model: "a1", usage: { input: 1, output: 1 } } },
		]);
		const second = await h.stream("work", "again");
		expect(second.map((event) => event.type)).toEqual(["text_delta", "done"]);
		expect(h.streamCalls.map((call) => call.provider)).toEqual(["alpha", "alpha"]);
	});

	test("tier thinking is forwarded and clamped to the target's declared levels", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		// high is unsupported on this model; medium is the nearest lower level.
		addTarget(h, baseModel("alpha", "a1", { thinkingLevelMap: { high: null } }));
		addTarget(h, baseModel("beta", "b1"));
		const events = await h.stream("work", "plain prompt");
		expect(events.at(-1)?.type).toBe("done");
		expect(h.streamCalls[0]?.reasoning).toBe("medium");
	});

	test("virtual credentials never reach the target; target auth wins", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"));
		addTarget(h, baseModel("beta", "b1"));
		h.auth.set("alpha", { ok: true, apiKey: "real-alpha-key", headers: { "X-Tenant": "acme" } });
		const events = await h.stream("work", "plain prompt", { apiKey: "AUTO_ROUTER_VIRTUAL_KEY", headers: { "X-Virtual": "yes" } });
		expect(events.at(-1)?.type).toBe("done");
		expect(h.streamCalls[0]?.apiKey).toBe("real-alpha-key");
		expect(h.streamCalls[0]?.headers).toEqual({ "X-Tenant": "acme" });
	});

	test("headless UI surfaces degrade to no-ops without breaking the stream", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"));
		addTarget(h, baseModel("beta", "b1"));
		h.uiThrows = true;
		const events = await h.stream("work", "plain prompt");
		expect(events.at(-1)?.type).toBe("done");
		await h.invoke("status");
		await h.invoke("explain");
	});

	test("shortcut pins are stripped before the target request", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"));
		addTarget(h, baseModel("beta", "b1"));
		await h.stream("work", "@fast fix the typo");
		expect(h.streamCalls[0]?.prompt).toBe("fix the typo");
	});

	test("mixed-phase prompts are adjudicated through the public complete() API, fail open", async () => {
		const h = await boot(TWO_TARGET_CONFIG);
		addTarget(h, baseModel("alpha", "a1"));
		addTarget(h, baseModel("beta", "b1"));
		// No prior decision: the adjudicator is the profile's standard-tier first target.
		h.adjudicationReplies.set("alpha/a1", "complex");
		const events = await h.stream("work", "按照设计方案实现登录功能模块");
		expect(events.at(-1)?.type).toBe("done");
		expect(h.completions).toEqual(["alpha/a1"]);

		// Fail-open: a broken adjudicator never breaks the routed request.
		h.adjudicationReplies.set("alpha/a1", new Error("adjudicator down"));
		const second = await h.stream("work", "按照设计方案实现登录功能模块");
		expect(second.at(-1)?.type).toBe("done");
	});
});
