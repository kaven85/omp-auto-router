/**
 * Narrow adapter from Pi's documented public types to the Mode A seam.
 *
 * This is deliberately the only place that knows Pi's concrete public types.
 * It does not import from a dist/internal path or inspect ModelRegistry state.
 */

import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { PiPublicModel, PiPublicModelRegistry } from "./delegated-stream";

export function toPiPublicModelRegistry(registry: ModelRegistry): PiPublicModelRegistry {
	return {
		find(provider, model) {
			return registry.find(provider, model) as PiPublicModel | undefined;
		},
		getProvider(providerId) {
			const provider = registry.getProvider(providerId);
			if (!provider) return undefined;
			return {
				streamSimple(model, context, options) {
					// `model` originates from registry.find above and remains the
					// effective Pi model. The narrowing crosses only this public seam.
					return provider.streamSimple(
						model as unknown as Model<Api>,
						context as Context,
						options as SimpleStreamOptions | undefined,
					);
				},
			};
		},
		async getApiKeyAndHeaders(model) {
			const resolved = await registry.getApiKeyAndHeaders(model as unknown as Model<Api>);
			if (!resolved.ok) return { ok: false, error: resolved.error };
			return {
				ok: true,
				...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
				...(resolved.headers !== undefined ? { headers: resolved.headers } : {}),
				...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
				...(resolved.env !== undefined ? { env: resolved.env } : {}),
			};
		},
	};
}
