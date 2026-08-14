/**
 * LLM adjudication (adapter side): when the keyword classifier flags a
 * mixed-phase prompt (`signals.mixedPhase`), the RouterRuntime asks the
 * host to pick the tier via `RouterRuntimeHost.adjudicate`. The runtime
 * owns enablement (env chain), adjudicator-target picking, and the
 * fail-open contract; this module is only the OMP stream call.
 * Fail-open: any error, timeout, or unparseable reply yields undefined.
 */

import { streamSimple } from "@oh-my-pi/pi-ai";

import type { HostPorts } from "../core/host-ports";
import { buildAdjudicationPrompt, parseAdjudicationResponse } from "../core/llm-adjudication";
import type { ComplexityTier, RouteTarget } from "../core/types";
import type { AdapterState } from "./state";

/** Bounded wait for the adjudication stream; the real request is waiting. */
const ADJUDICATION_TIMEOUT_MS = 15_000;

/**
 * Cap on accumulated reply text — a runaway or hostile stream must not grow
 * memory unbounded; the tier word arrives in the first bytes anyway.
 */
const ADJUDICATION_MAX_CHARS = 4_096;

export interface AdjudicationResult {
	tier: ComplexityTier;
	/** "provider/model" that answered, for the decision reasoning trace. */
	model: string;
}

/**
 * One-shot adjudication call. Isolated from circuit breaker / cooldown
 * bookkeeping on purpose: a flaky adjudicator must not poison the routing
 * health state of the model it happens to use.
 */
export async function adjudicateTier(
	state: AdapterState,
	host: Pick<HostPorts, "getApiKey">,
	target: RouteTarget,
	userPrompt: string,
	signal?: AbortSignal,
): Promise<AdjudicationResult | undefined> {
	const resolved = state.ctx?.models.resolve(`${target.provider}/${target.model}`);
	if (!resolved) return undefined;
	try {
		const apiKey = await host.getApiKey(target);
		const timeout = AbortSignal.timeout(ADJUDICATION_TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const stream = streamSimple(
			resolved as never,
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: buildAdjudicationPrompt(userPrompt) }] },
				],
			} as never,
			{ signal: combined, ...(apiKey !== undefined ? { apiKey } : {}) } as never,
		);
		let text = "";
		for await (const event of stream) {
			const e = event as { type?: unknown; delta?: unknown };
			if (e.type === "text_delta" && typeof e.delta === "string" && text.length < ADJUDICATION_MAX_CHARS) {
				text += e.delta;
			}
		}
		const tier = parseAdjudicationResponse(text);
		if (tier === undefined) return undefined;
		return { tier, model: `${target.provider}/${target.model}` };
	} catch {
		return undefined;
	}
}
