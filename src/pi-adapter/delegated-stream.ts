/**
 * Pi Mode A public-interface delegation seam.
 *
 * This module deliberately uses only the documented ModelRegistry and Provider
 * methods. It neither imports Pi internals nor needs access to a host runtime.
 * The concrete Pi Adapter supplies these structural public shapes.
 */

export interface PiTarget {
	provider: string;
	model: string;
}

export interface PiPublicModel {
	provider: string;
	id: string;
	api: string;
	baseUrl?: string;
}

export interface PiResolvedAuth {
	ok: true;
	apiKey?: string;
	headers?: Record<string, string | null>;
	baseUrl?: string;
	env?: Record<string, string>;
}

export interface PiFailedAuth {
	ok: false;
	error: string;
}

export interface PiPublicProvider {
	streamSimple(
		model: PiPublicModel,
		context: unknown,
		options?: Record<string, unknown>,
	): AsyncIterable<unknown>;
}

/** Documented public subset of Pi's ModelRegistry used for Mode A. */
export interface PiPublicModelRegistry {
	find?: (provider: string, model: string) => PiPublicModel | undefined;
	getProvider?: (provider: string) => PiPublicProvider | undefined;
	getApiKeyAndHeaders?: (model: PiPublicModel) => Promise<PiResolvedAuth | PiFailedAuth>;
}

export interface PiModeACapabilities {
	supported: boolean;
	missing: string[];
}

export class PiDelegationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiDelegationError";
	}
}

const REQUIRED_CAPABILITIES = ["find", "getProvider", "getApiKeyAndHeaders"] as const;
const VIRTUAL_AUTH_OPTIONS = new Set(["apiKey", "headers", "env", "reasoning"]);

/**
 * Check the small public capability set required for same-request Mode A
 * delegation. This is a feature probe, not a Pi version check.
 */
export function inspectPiModeACapabilities(registry: PiPublicModelRegistry): PiModeACapabilities {
	const missing = REQUIRED_CAPABILITIES.filter((name) => typeof registry[name] !== "function");
	return { supported: missing.length === 0, missing: [...missing] };
}

/**
 * Delegate a virtual auto-router request to a real target Provider. Virtual
 * credentials and reasoning controls are intentionally stripped; target auth
 * always wins. Behavioral options such as signal and callbacks pass through.
 */
export async function delegatePiTarget(
	registry: PiPublicModelRegistry,
	target: PiTarget,
	context: unknown,
	options?: Record<string, unknown>,
): Promise<AsyncIterable<unknown>> {
	const capabilities = inspectPiModeACapabilities(registry);
	if (!capabilities.supported) {
		throw new PiDelegationError(
			`Pi Mode A delegation requires public ModelRegistry capability: ${capabilities.missing[0]}`,
		);
	}
	if (target.provider === "auto-router") {
		throw new PiDelegationError("auto-router cannot delegate to its virtual provider");
	}

	const model = registry.find!(target.provider, target.model);
	if (!model) {
		throw new PiDelegationError(`Pi target model not found: ${target.provider}/${target.model}`);
	}
	const provider = registry.getProvider!(target.provider);
	if (!provider) {
		throw new PiDelegationError(`Pi target provider not found: ${target.provider}`);
	}
	const auth = await registry.getApiKeyAndHeaders!(model);
	if (!auth.ok) {
		throw new PiDelegationError(`Pi target authentication failed for ${target.provider}/${target.model}: ${auth.error}`);
	}

	const targetModel: PiPublicModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	return provider.streamSimple(targetModel, context, {
		...withoutVirtualAuth(options),
		...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
		...(auth.headers !== undefined ? { headers: auth.headers } : {}),
		...(auth.env !== undefined ? { env: auth.env } : {}),
	});
}

function withoutVirtualAuth(options?: Record<string, unknown>): Record<string, unknown> {
	if (!options) return {};
	return Object.fromEntries(Object.entries(options).filter(([key]) => !VIRTUAL_AUTH_OPTIONS.has(key)));
}
