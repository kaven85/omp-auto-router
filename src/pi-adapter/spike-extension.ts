/**
 * Manual Pi compatibility probe for Mode A delegation.
 *
 * Run with `pi -e ./src/pi-adapter/spike-extension.ts`, select
 * `auto-router-spike/probe`, then send a prompt. The probe delegates to the
 * real model that was selected immediately before the virtual model.
 *
 * It is intentionally not in the package manifest: this is a tracer bullet,
 * not the user-facing auto-router extension.
 */

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { delegatePiTarget, PiDelegationError, type PiTarget } from "./delegated-stream";
import { toPiPublicModelRegistry } from "./public-registry";

const PROVIDER_ID = "auto-router-spike";
const MODEL_ID = "probe";
const VIRTUAL_API_KEY = "AUTO_ROUTER_SPIKE_VIRTUAL_KEY";

export default function spikeExtension(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let target: PiTarget | undefined;

	const rememberTarget = (model: ExtensionContext["model"]): void => {
		if (model && model.provider !== PROVIDER_ID) {
			target = { provider: model.provider, model: model.id };
		}
	};

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		rememberTarget(ctx.model);
	});
	pi.on("model_select", (event, ctx) => {
		context = ctx;
		rememberTarget(event.previousModel);
		rememberTarget(event.model);
	});

	pi.registerProvider(PROVIDER_ID, {
		name: "Auto Router Probe",
		baseUrl: "http://127.0.0.1:0",
		apiKey: VIRTUAL_API_KEY,
		api: "openai-completions",
		models: [
			{
				id: MODEL_ID,
				name: "Auto Router Probe",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
			},
		],
		streamSimple(model, streamContext, options) {
			return delegateProbe(model, streamContext, options, context, target);
		},
	});
}

function delegateProbe(
	virtualModel: Model<Api>,
	streamContext: Context,
	options: SimpleStreamOptions | undefined,
	context: ExtensionContext | undefined,
	target: PiTarget | undefined,
) {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			if (!context) throw new PiDelegationError("Pi session has not started; select a real model, then select auto-router-spike/probe");
			if (!target) throw new PiDelegationError("Select a real model before selecting auto-router-spike/probe");
			const stream = await delegatePiTarget(
				toPiPublicModelRegistry(context.modelRegistry),
				target,
				streamContext,
				options as Record<string, unknown> | undefined,
			);
			for await (const event of stream) output.push(event as AssistantMessageEvent);
		} catch (error) {
			output.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: virtualModel.api,
					provider: virtualModel.provider,
					model: virtualModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
		} finally {
			output.end();
		}
	})();
	return output;
}
