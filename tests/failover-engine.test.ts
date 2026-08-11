import { describe, expect, test } from "bun:test";

import {
	defaultIsRetryable,
	defaultIsSubstantive,
	failoverStream,
	formatError,
} from "../src/core/failover-engine";
import type {
	FailoverHooks,
	RouteTarget,
	StreamEventLike,
	StreamFactory,
} from "../src/core/types";

function target(provider: string, model = "m"): RouteTarget {
	return { provider, model };
}

async function* streamOf(events: StreamEventLike[]): AsyncGenerator<StreamEventLike> {
	for (const event of events) yield event;
}

async function collect(iter: AsyncIterable<StreamEventLike>): Promise<StreamEventLike[]> {
	const out: StreamEventLike[] = [];
	for await (const event of iter) out.push(event);
	return out;
}

/** FailoverHooks backed by the default classifiers, recording every callback. */
function recordingHooks(overrides: Partial<FailoverHooks> = {}): {
	hooks: FailoverHooks;
	failed: Array<{ target: RouteTarget; error: unknown }>;
	failovers: Array<{ from: RouteTarget; to: RouteTarget; error: unknown }>;
	settled: RouteTarget[];
} {
	const failed: Array<{ target: RouteTarget; error: unknown }> = [];
	const failovers: Array<{ from: RouteTarget; to: RouteTarget; error: unknown }> = [];
	const settled: RouteTarget[] = [];
	return {
		failed,
		failovers,
		settled,
		hooks: {
			isRetryable: defaultIsRetryable,
			isSubstantive: defaultIsSubstantive,
			onTargetFailed: (t, error) => failed.push({ target: t, error }),
			onFailover: (from, to, error) => failovers.push({ from, to, error }),
			onTargetSettled: (t) => settled.push(t),
			...overrides,
		},
	};
}

describe("failoverStream", () => {
	test("first-target success streams everything and settles once", async () => {
		const a = target("a");
		const events: StreamEventLike[] = [
			{ type: "start" },
			{ type: "text_delta", text: "hi" },
			{ type: "text_delta", text: " there" },
			{ type: "done" },
		];
		const factory: StreamFactory = () => streamOf(events);
		const { hooks, failed, failovers, settled } = recordingHooks();

		const out = await collect(failoverStream([a], factory, hooks));
		expect(out).toEqual(events);
		expect(failed).toEqual([]);
		expect(failovers).toEqual([]);
		expect(settled).toEqual([a]); // exactly once despite several substantive events
	});

	test("fails over after a terminal error event before any content", async () => {
		const a = target("a");
		const b = target("b");
		const errorEvent: StreamEventLike = { type: "error", status: 503, message: "overloaded" };
		const factory: StreamFactory = (t) =>
			t.provider === "a" ? streamOf([errorEvent]) : streamOf([{ type: "text_delta" }, { type: "done" }]);
		const { hooks, failed, failovers, settled } = recordingHooks();

		const out = await collect(failoverStream([a, b], factory, hooks));
		expect(out).toEqual([{ type: "text_delta" }, { type: "done" }]);
		expect(failed).toEqual([{ target: a, error: errorEvent }]);
		expect(failovers).toEqual([{ from: a, to: b, error: errorEvent }]);
		expect(settled).toEqual([b]);
	});

	test("fails over when the factory throws a retryable error pre-content", async () => {
		const a = target("a");
		const b = target("b");
		const boom = new Error("rate limit exceeded");
		const factory: StreamFactory = (t) => {
			if (t.provider === "a") throw boom;
			return streamOf([{ type: "text_delta" }]);
		};
		const { hooks, failed, failovers, settled } = recordingHooks();

		const out = await collect(failoverStream([a, b], factory, hooks));
		expect(out).toEqual([{ type: "text_delta" }]);
		expect(failed).toEqual([{ target: a, error: boom }]);
		expect(failovers).toEqual([{ from: a, to: b, error: boom }]);
		expect(settled).toEqual([b]);
	});

	test("no failover once substantive output was seen — later errors pass through", async () => {
		const a = target("a");
		const b = target("b");
		const lateError: StreamEventLike = { type: "error", status: 500, message: "boom" };
		const factory: StreamFactory = (t) =>
			t.provider === "a"
				? streamOf([{ type: "text_delta", text: "partial" }, lateError])
				: streamOf([{ type: "text_delta", text: "from b" }]);
		const { hooks, failed, failovers, settled } = recordingHooks();

		const out = await collect(failoverStream([a, b], factory, hooks));
		expect(out).toEqual([{ type: "text_delta", text: "partial" }, lateError]);
		expect(failed).toEqual([]); // a post-content error is not a failover failure
		expect(failovers).toEqual([]);
		expect(settled).toEqual([a]);
	});

	test("errors thrown mid-stream after substantive output propagate", async () => {
		const a = target("a");
		const b = target("b");
		const boom = new Error("socket hang up"); // retryable, but failover is over
		const failing = (async function* (): AsyncGenerator<StreamEventLike> {
			yield { type: "text_delta" };
			throw boom;
		})();
		const factory: StreamFactory = (t) => (t.provider === "a" ? failing : streamOf([]));
		const { hooks, failovers } = recordingHooks();

		await expect(collect(failoverStream([a, b], factory, hooks))).rejects.toBe(boom);
		expect(failovers).toEqual([]);
	});

	test("non-retryable terminal error event is yielded and ends the stream", async () => {
		const a = target("a");
		const b = target("b");
		const badRequest: StreamEventLike = { type: "error", status: 400, message: "bad request" };
		const factory: StreamFactory = (t) =>
			t.provider === "a" ? streamOf([badRequest]) : streamOf([{ type: "text_delta" }]);
		const { hooks, failed, failovers, settled } = recordingHooks();

		const out = await collect(failoverStream([a, b], factory, hooks));
		expect(out).toEqual([badRequest]);
		expect(failed).toEqual([{ target: a, error: badRequest }]);
		expect(failovers).toEqual([]);
		expect(settled).toEqual([]);
	});

	test("non-retryable thrown error propagates without failover", async () => {
		const a = target("a");
		const b = target("b");
		const authError = new Error("invalid api key");
		const factory: StreamFactory = (t) => {
			if (t.provider === "a") throw authError;
			return streamOf([{ type: "text_delta" }]);
		};
		const { hooks, failed, failovers } = recordingHooks();

		await expect(collect(failoverStream([a, b], factory, hooks))).rejects.toBe(authError);
		expect(failed).toEqual([{ target: a, error: authError }]);
		expect(failovers).toEqual([]);
	});

	test("all candidates exhausted throws with the target chain and last error as cause", async () => {
		const a = target("prov-a", "claude");
		const b = target("prov-b", "gpt");
		const lastBoom = new Error("socket hang up");
		const factory: StreamFactory = (t) => {
			if (t.provider === "prov-a") throw new Error("HTTP 503 Service Unavailable");
			throw lastBoom;
		};
		const { hooks, failed, failovers } = recordingHooks();

		const error = await collect(failoverStream([a, b], factory, hooks)).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("prov-a/claude -> prov-b/gpt");
		expect(message).toContain("socket hang up");
		expect((error as Error).cause).toBe(lastBoom);
		expect(failed.map((f) => f.target)).toEqual([a, b]);
		expect(failovers).toHaveLength(1); // a -> b only
	});

	test("single retryable candidate failing yields the aggregate throw", async () => {
		const a = target("only");
		const factory: StreamFactory = () => streamOf([{ type: "error", message: "usage limit reached" }]);
		const { hooks } = recordingHooks();

		await expect(collect(failoverStream([a], factory, hooks))).rejects.toThrow(
			/all 1 candidate\(s\) failed \(only\/m\)/,
		);
	});

	test("pre-aborted signal stops cleanly without calling the factory", async () => {
		const a = target("a");
		const factoryCalls: string[] = [];
		const factory: StreamFactory = (t) => {
			factoryCalls.push(t.provider);
			return streamOf([{ type: "text_delta" }]);
		};
		const { hooks, failovers } = recordingHooks();

		const out = await collect(
			failoverStream([a], factory, hooks, { signal: AbortSignal.abort() }),
		);
		expect(out).toEqual([]);
		expect(factoryCalls).toEqual([]);
		expect(failovers).toEqual([]);
	});

	test("abort between candidates stops cleanly after the recorded failover", async () => {
		const a = target("a");
		const b = target("b");
		const controller = new AbortController();
		const factoryCalls: string[] = [];
		const factory: StreamFactory = (t) => {
			factoryCalls.push(t.provider);
			controller.abort();
			throw new Error("timeout waiting for response"); // retryable
		};
		const { hooks, failovers } = recordingHooks();

		const out = await collect(failoverStream([a, b], factory, hooks, { signal: controller.signal }));
		expect(out).toEqual([]);
		expect(factoryCalls).toEqual(["a"]); // b never attempted
		expect(failovers).toEqual([{ from: a, to: b, error: expect.any(Error) }]);
	});

	test("AbortError from the factory is rethrown even when it looks retryable", async () => {
		const a = target("a");
		const b = target("b");
		const abortError = new DOMException("socket timeout", "AbortError");
		const factory: StreamFactory = () => {
			throw abortError;
		};
		const { hooks, failovers } = recordingHooks();

		await expect(collect(failoverStream([a, b], factory, hooks))).rejects.toBe(abortError);
		expect(failovers).toEqual([]);
	});

	test("AbortError is not recorded as a target failure (no cooldown on user abort)", async () => {
		const a = target("a");
		const abortError = new DOMException("The operation was aborted", "AbortError");
		const factory: StreamFactory = () => {
			throw abortError;
		};
		const { hooks, failed } = recordingHooks();

		await expect(collect(failoverStream([a], factory, hooks))).rejects.toBe(abortError);
		expect(failed).toEqual([]);
	});

	test("aborted terminal error event stops cleanly without recording a failure", async () => {
		// pi-ai ends an Esc-aborted stream with {type:"error", reason:"aborted"} —
		// a user abort must not cool the target down or fail over.
		const a = target("a");
		const b = target("b");
		const factoryCalls: string[] = [];
		const factory: StreamFactory = (t) => {
			factoryCalls.push(t.provider);
			return streamOf([
				{ type: "thinking_delta", delta: "hmm" },
				{ type: "error", reason: "aborted", error: { stopReason: "aborted" } },
			]);
		};
		const { hooks, failed, failovers } = recordingHooks();

		const out = await collect(failoverStream([a, b], factory, hooks));
		expect(out).toEqual([]);
		expect(factoryCalls).toEqual(["a"]); // no failover to b
		expect(failed).toEqual([]);
		expect(failovers).toEqual([]);
	});

	test("empty candidate chain is a programmer error", async () => {
		const factory: StreamFactory = () => streamOf([]);
		const { hooks } = recordingHooks();
		await expect(collect(failoverStream([], factory, hooks))).rejects.toThrow(
			/candidates must not be empty/,
		);
	});
});

describe("defaultIsSubstantive", () => {
	test("covers the assistant-stream content types", () => {
		for (const type of [
			"text_delta",
			"image_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]) {
			expect(defaultIsSubstantive({ type })).toBe(true);
		}
	});

	test("thinking-only partials stay failover-eligible", () => {
		for (const type of ["thinking_start", "thinking_delta", "thinking_end", "start"]) {
			expect(defaultIsSubstantive({ type })).toBe(false);
		}
	});

	test("rejects lifecycle and error events", () => {
		for (const type of ["start", "error", "usage", "ping"]) {
			expect(defaultIsSubstantive({ type })).toBe(false);
		}
	});
});

describe("defaultIsRetryable", () => {
	test("matches retryable statuses on {status} shapes", () => {
		for (const status of [429, 500, 502, 503, 504]) {
			expect(defaultIsRetryable({ status })).toBe(true);
		}
		expect(defaultIsRetryable({ status: 400 })).toBe(false);
		expect(defaultIsRetryable({ status: 401 })).toBe(false);
	});

	test("matches status codes and transient wording in Error.message", () => {
		expect(defaultIsRetryable(new Error("HTTP 429 too many requests"))).toBe(true);
		expect(defaultIsRetryable(new Error("503 Service Unavailable"))).toBe(true);
		expect(defaultIsRetryable(new Error("The model is overloaded"))).toBe(true);
		expect(defaultIsRetryable(new Error("Rate limit exceeded"))).toBe(true);
		expect(defaultIsRetryable(new Error("usage-limit reached for this window"))).toBe(true);
		expect(defaultIsRetryable(new Error("request timeout"))).toBe(true);
		expect(defaultIsRetryable(new Error("socket hang up"))).toBe(true);
	});

	test("matches {error:{message}} and string shapes", () => {
		expect(defaultIsRetryable({ error: { message: "Overloaded" } })).toBe(true);
		expect(defaultIsRetryable({ error: "timed out" })).toBe(true);
		expect(defaultIsRetryable("502 Bad Gateway")).toBe(true);
	});

	test("matches status carried on Error objects", () => {
		const error = new Error("whatever") as Error & { status: number };
		error.status = 503;
		expect(defaultIsRetryable(error)).toBe(true);
	});

	test("rejects permanent failures", () => {
		expect(defaultIsRetryable(new Error("invalid api key"))).toBe(false);
		expect(defaultIsRetryable(new Error("model not found"))).toBe(false);
		expect(defaultIsRetryable({ status: 400, message: "bad request" })).toBe(false);
		expect(defaultIsRetryable(undefined)).toBe(false);
		expect(defaultIsRetryable(null)).toBe(false);
	});
});

describe("formatError", () => {
	test("renders Error and string shapes directly", () => {
		expect(formatError(new Error("boom"))).toBe("boom");
		expect(formatError("plain failure")).toBe("plain failure");
	});

	test("unwraps omp provider error objects instead of [object Object]", () => {
		const thrown = {
			status: 403,
			error: { type: "permission_error", message: "usage limit reached" },
		};
		expect(formatError(thrown)).toBe("usage limit reached [status 403]");
	});

	test("annotates status only when absent from the message", () => {
		expect(formatError({ status: 503, message: "503 service unavailable" })).toBe(
			"503 service unavailable",
		);
	});

	test("falls back to JSON for messageless objects", () => {
		expect(formatError({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
	});
});
