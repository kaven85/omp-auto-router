/**
 * LLM adjudication (adapter side): when the keyword classifier flags a
 * mixed-phase prompt (`signals.mixedPhase`), ask the session's current LLM
 * to pick the tier. Fail-open: any error, timeout, or unparseable reply
 * keeps the heuristic decision.
 *
 * Env:
 * - OMP_AUTO_ROUTER_LLM_ADJUDICATE=0|false disables (default: on).
 */

import { streamSimple } from "@oh-my-pi/pi-ai";

import type { HostPorts } from "../core/host-ports";
import { buildAdjudicationPrompt, parseAdjudicationResponse } from "../core/llm-adjudication";
import type { ComplexityTier, RouteTarget } from "../core/types";
import type { AdapterState } from "./state";

/** Bounded wait for the adjudication stream; the real request is waiting. */
const ADJUDICATION_TIMEOUT_MS = 15_000;

export function adjudicationEnabled(): boolean {
	const raw = process.env.OMP_AUTO_ROUTER_LLM_ADJUDICATE;
	return raw !== "0" && raw !== "false";
}

/**
 * Pick the adjudicator model: "the current LLM" — the target of the last
 * routing decision this session; on a fresh session, the profile's
 * standard-tier first target (registry ladder handles sparse profiles).
 */
export function pickAdjudicatorTarget(
	state: AdapterState,
	profileName: string,
): RouteTarget | undefined {
	const last = state.decisions.last();
	if (last) return last.target;
	return state.registry.tierConfig(profileName, "standard")?.targets[0];
}

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
			if (e.type === "text_delta" && typeof e.delta === "string") text += e.delta;
		}
		const tier = parseAdjudicationResponse(text);
		if (tier === undefined) return undefined;
		return { tier, model: `${target.provider}/${target.model}` };
	} catch {
		return undefined;
	}
}
