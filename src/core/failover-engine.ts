/**
 * Failover engine — the heart of Mode A.
 *
 * Walks an ordered candidate chain, delegating actual streaming to the host
 * via StreamFactory. A target that fails (thrown error or terminal error
 * event) BEFORE producing substantive output is recorded and the chain moves
 * on; once substantive output has been seen, the stream passes through
 * untouched and failover is over.
 */

import type {
	FailoverHooks,
	RouteTarget,
	StreamEventLike,
	StreamFactory,
} from "./types";

/** Stream event types that count as substantive assistant output. */
const SUBSTANTIVE_TYPES: Record<string, true> = {
	text_delta: true,
	image_end: true,
	toolcall_start: true,
	toolcall_delta: true,
	toolcall_end: true,
	done: true,
};

/**
 * Default substantive-event classifier: true once the stream has emitted real
 * assistant content (text/image, tool-call lifecycle, or a done sentinel).
 *
 * Deliberately EXCLUDES thinking deltas: matching omp's TurnRecovery
 * replay-safety semantics, thinking-only partials are safe to discard, so a
 * model that thinks for minutes and then errors pre-text is still eligible
 * for failover to the next candidate.
 */
export function defaultIsSubstantive(event: StreamEventLike): boolean {
	return SUBSTANTIVE_TYPES[event.type] === true;
}

/** HTTP-ish statuses that justify trying the next target. */
const RETRYABLE_STATUSES: Record<number, true> = {
	429: true,
	500: true,
	502: true,
	503: true,
	504: true,
};

/** Status codes embedded in free-text error messages. */
const RETRYABLE_STATUS_RE = /\b(?:429|500|502|503|504)\b/;

/** Transient-failure wording (word-boundary, case-insensitive). */
const RETRYABLE_WORDING_RE =
	/\b(?:overloaded?|rate[-\s]?limit(?:ed)?|usage[-\s]?limit(?:ed)?|timeout|timed\s+out|socket)\b/i;

/** Best-effort message extraction from Error / string / {message} / {error:{message}} shapes. */
function extractMessage(error: unknown): string | undefined {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (typeof error !== "object" || error === null) return undefined;
	if ("message" in error && typeof error.message === "string") return error.message;
	if ("error" in error) {
		const inner: unknown = error.error;
		if (typeof inner === "string") return inner;
		if (
			typeof inner === "object" &&
			inner !== null &&
			"message" in inner &&
			typeof inner.message === "string"
		) {
			return inner.message;
		}
	}
	return undefined;
}

/** Best-effort numeric status extraction from {status} / {statusCode} shapes. */
function extractStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if ("status" in error && typeof error.status === "number") return error.status;
	if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
	return undefined;
}

/**
 * Default retryability classifier: retry on 429/500/502/503/504 statuses and
 * on overload / rate-limit / usage-limit / timeout / socket wording found in
 * Error.message or {status} / {error.message}-shaped values.
 */
export function defaultIsRetryable(error: unknown): boolean {
	const status = extractStatus(error);
	if (status !== undefined && RETRYABLE_STATUSES[status] === true) return true;
	const message = extractMessage(error);
	if (message === undefined) return false;
	return RETRYABLE_STATUS_RE.test(message) || RETRYABLE_WORDING_RE.test(message);
}

/**
 * Stream from the candidate chain with failover.
 *
 * For each candidate in order: obtain a stream from `factory` and yield its
 * events. A failure (thrown error or terminal `type: "error"` event) before
 * any substantive event is reported via `hooks.onTargetFailed`; when
 * `hooks.isRetryable` accepts it and another candidate remains, the chain
 * fails over (`hooks.onFailover`) and continues. Non-retryable thrown errors
 * propagate; non-retryable terminal error events are yielded and end the
 * stream. Once a substantive event has been yielded, `hooks.onTargetSettled`
 * fires exactly once and everything after — including error events — passes
 * through untouched. When every candidate fails, throws an Error whose
 * message carries the attempted target chain, with the last error as `cause`.
 * An aborted `opts.signal` stops cleanly between candidates; AbortError
 * failures are rethrown.
 *
 * @throws when `candidates` is empty (programmer error).
 */
export async function* failoverStream(
	candidates: RouteTarget[],
	factory: StreamFactory,
	hooks: FailoverHooks,
	opts?: { signal?: AbortSignal },
): AsyncGenerator<StreamEventLike> {
	if (candidates.length === 0) {
		throw new Error("failoverStream: candidates must not be empty");
	}
	const signal = opts?.signal;
	const attempted: string[] = [];
	let lastError: unknown;

	// Pre-substantive events are buffered, not yielded: thinking-only partials
	// are safe to discard (omp replay-safety), and yielding them before a
	// failover would contaminate the host's accumulated message with another
	// model's content. The buffer flushes in order when substantive content
	// arrives or the stream completes cleanly.
	const THINKING_BUFFER_CAP = 64 * 1024; // chars of buffered thinking deltas

	for (const [index, target] of candidates.entries()) {
		if (signal?.aborted) return; // clean stop between candidates
		attempted.push(target.label ?? `${target.provider}/${target.model}`);

		let substantive = false;
		let failed = false;
		let failedError: unknown;
		let failedEvent: StreamEventLike | undefined;
		const buffer: StreamEventLike[] = [];
		let bufferedDeltaChars = 0;

		const flush = function* (): Generator<StreamEventLike> {
			for (const event of buffer) yield event;
			buffer.length = 0;
			bufferedDeltaChars = 0;
		};

		let stream: AsyncIterable<StreamEventLike> | undefined;
		try {
			stream = await factory(target, { signal });
		} catch (error) {
			failed = true;
			failedError = error;
		}

		if (stream !== undefined) {
			try {
				for await (const event of stream) {
					if (!substantive && event.type === "error") {
						// terminal error event before any content
						failed = true;
						failedError = event;
						failedEvent = event;
						break;
					}
					if (!substantive) {
						buffer.push(event);
						if (typeof event.delta === "string") {
							bufferedDeltaChars += event.delta.length;
							// Drop oldest thinking deltas past the cap; thinking is
							// regenerable, so truncation only loses context, not content.
							while (bufferedDeltaChars > THINKING_BUFFER_CAP && buffer.length > 0) {
								const dropped = buffer.shift();
								if (dropped && typeof dropped.delta === "string") {
									bufferedDeltaChars -= dropped.delta.length;
								}
							}
						}
						if (hooks.isSubstantive(event)) {
							substantive = true;
							hooks.onTargetSettled?.(target);
							yield* flush();
						}
						continue;
					}
					yield event;
				}
			} catch (error) {
				if (substantive) throw error; // pass-through: failover is over
				failed = true;
				failedError = error;
			}
		}

		if (!failed) {
			// Clean end (possibly without substantive events): hand over whatever
			// was buffered so the host sees a complete, ordered stream.
			yield* flush();
			return;
		}

		lastError = failedError;
		hooks.onTargetFailed?.(target, failedError);
		if (
			typeof failedError === "object" &&
			failedError !== null &&
			"name" in failedError &&
			failedError.name === "AbortError"
		) {
			throw failedError; // host abort wins over retryability
		}

		const retryable = hooks.isRetryable(failedError);
		const next = candidates[index + 1];
		if (retryable && next !== undefined) {
			hooks.onFailover?.(target, next, failedError);
			continue;
		}
		if (retryable) break; // chain exhausted — aggregate below
		if (failedEvent !== undefined) {
			// non-retryable terminal error event: hand it to the host and stop
			yield failedEvent;
			return;
		}
		throw failedError; // non-retryable thrown error
	}

	throw new Error(
		`failoverStream: all ${attempted.length} candidate(s) failed (${attempted.join(" -> ")}): ${extractMessage(lastError) ?? String(lastError)}`,
		{ cause: lastError },
	);
}
