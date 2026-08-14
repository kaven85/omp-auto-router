/**
 * OMP-authenticated prepaid-balance fetch. The endpoint knowledge and payload
 * parsing live in the host-neutral provider dictionary; only the credential
 * lookup (ctx.modelRegistry) and the bearer request are adapter-private.
 *
 * Best-effort: any failure (no model, no key, network, shape) yields
 * undefined so callers can render "unknown". The request carries a 10s
 * timeout so a hung endpoint cannot block the caller.
 */

import type { AdapterState } from "./state";
import type { OmpExtensionContext, OmpModel } from "./omp-api";
import { parseProviderBalance, type ProviderBalance } from "../runtime/provider-dictionary";

/**
 * Fetch a provider's remaining balance via its resolved endpoint, bearer-
 * authenticated with the host-resolved API key of any model from that
 * provider.
 */
export async function fetchOmpBalance(
	ctx: OmpExtensionContext,
	state: AdapterState,
	provider: string,
	endpoint: string,
): Promise<ProviderBalance | undefined> {
	const model: OmpModel | undefined =
		[...state.modelsByKey.values(), ...ctx.models.list()].find((candidate) => candidate.provider === provider);
	if (!model) return undefined;
	try {
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) return undefined;
		const response = await fetch(endpoint, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		return parseProviderBalance(provider, payload);
	} catch {
		return undefined;
	}
}
