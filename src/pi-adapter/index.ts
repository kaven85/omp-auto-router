import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CandidateInfo, StreamEventLike } from "../core/types";
import { buildAdjudicationPrompt, parseAdjudicationResponse, ADJUDICATION_MAX_CHARS, ADJUDICATION_TIMEOUT_MS } from "../core/llm-adjudication";
import { matchPathActivation } from "../core/profile-registry";
import {
	buildVirtualModels,
	configuredTargets,
	decisionEntries,
	recordTestOutcome,
	refreshSettledBalanceAndWidget,
	routerErrorEvent,
	ROUTER_PROVIDER_ID,
	TEST_COMMAND_RE,
	VIRTUAL_API_KEY,
	VIRTUAL_BASE_URL,
} from "../runtime/adapter-kit";
import { buildRouterCompletions, runRouterCommand, type RouterCommandHost } from "../runtime/commands";
import { loadInitialRouterConfiguration, loadRouterConfiguration, projectConfigPath, userConfigPath } from "../runtime/config";
import { parseProviderBalance } from "../runtime/provider-dictionary";
import { RouterRuntime, RouterRuntimeError, type RouterRuntimeHost } from "../runtime/router-runtime";
import { createPersistentRuntimeState, persistClassifierOverrides, persistRuntimeTrackers, type PersistentRuntimeState } from "../runtime/state";
import { delegatePiTarget, inspectPiDelegationCapabilities } from "./delegated-stream";
import { toPiPublicModelRegistry } from "./public-registry";

/** Host-neutral, versioned custom entry types (legacy OMP entries are read back too). */
const PROFILE_STATE_ENTRY = "com.auto-router.v1.state";

/** Pi's production adapter. It only calls documented public extension APIs. */
export default function piAutoRouterExtension(pi: ExtensionAPI): void {
	const userFile = userConfigPath(getAgentDir());
	const initial = loadInitialRouterConfiguration(userFile);
	const stateRef: { current: PersistentRuntimeState } = {
		current: createPersistentRuntimeState(initial.config, `${getAgentDir()}/auto-router`, process.cwd(), initial.errors),
	};
	let context: ExtensionContext | undefined;

	const registerProfiles = (): void => {
		const state = stateRef.current;
		pi.registerProvider(ROUTER_PROVIDER_ID, {
			name: "Auto Router",
			baseUrl: VIRTUAL_BASE_URL,
			apiKey: VIRTUAL_API_KEY,
			api: "openai-completions",
			models: buildVirtualModels(state.config.profiles),
			streamSimple(model, streamContext, options) {
				return bridgeRuntimeStream(stateRef.current, context, pi, model, streamContext, options);
			},
		});
	};
	registerProfiles();

	pi.registerCommand("auto-router", {
		description: "Profile-based auto-router controls",
		getArgumentCompletions(argumentPrefix) {
			return (buildRouterCompletions(argumentPrefix ?? "", stateRef.current) ?? []).map((item) => ({
				value: item.value,
				label: item.label,
				...(item.description !== undefined ? { description: item.description } : {}),
			}));
		},
		async handler(args, commandContext) {
			context = commandContext;
			await runRouterCommand(args ?? "", stateRef.current, createPiCommandHost(commandContext, pi, stateRef, registerProfiles));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		const loaded = await loadRouterConfiguration({
			userFile,
			...(ctx.isProjectTrusted() ? { projectFile: projectConfigPath(ctx.cwd, ".pi") } : {}),
		});
		const fresh = createPersistentRuntimeState(loaded.config, `${getAgentDir()}/auto-router`, ctx.cwd, [
			...loaded.errors,
			...(ctx.isProjectTrusted() ? [] : ["project config ignored: project is not trusted"]),
		]);
		stateRef.current = fresh;
		restoreDecisions(fresh, ctx);
		registerProfiles();
		await activatePathProfile(fresh, ctx, pi);
	});
	pi.on("session_tree", (_event, ctx) => {
		context = ctx;
		// Tree navigation swaps the active branch: stale decisions from the
		// previous branch must not survive into explain or LLM adjudication.
		stateRef.current.lastDecision = undefined;
		restoreDecisions(stateRef.current, ctx);
	});
	pi.on("session_shutdown", () => persistRuntimeTrackers(stateRef.current));
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!TEST_COMMAND_RE.test(command)) return;
		recordTestOutcome(stateRef.current, command, event.isError === true);
	});
}

function bridgeRuntimeStream(
	state: PersistentRuntimeState,
	context: ExtensionContext | undefined,
	pi: ExtensionAPI,
	virtualModel: Model<Api>,
	streamContext: Context,
	options: SimpleStreamOptions | undefined,
) {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			if (!context) throw new RouterRuntimeError("Pi session has not started; retry after session initialization");
			const { profile: profileName, role } = state.registry.parseVirtualModelId(virtualModel.id);
			const runtime = new RouterRuntime(state, createPiRuntimeHost(context, pi));
			for await (const event of runtime.stream({
				profile: profileName,
				role,
				context: streamContext,
				options: options as Record<string, unknown> | undefined,
				estimatedTokens: context.getContextUsage()?.tokens ?? undefined,
			})) output.push(event as AssistantMessageEvent);
		} catch (error) {
			output.push(errorEvent(virtualModel, error));
		} finally {
			persistRuntimeTrackers(state);
		}
		// Post-stream visibility: refresh the settled provider's prepaid balance
		// (public authenticated auth, no host usage reports involved) and render
		// the shared widget.
		if (context) {
			await refreshSettledBalanceAndWidget(
				state,
				configuredTargets(state.registry),
				(provider, endpoint) => fetchPiBalance(context, provider, endpoint),
				(lines) => setPiWidget(context, lines),
			);
		}
	})();
	return output;
}

function createPiRuntimeHost(context: ExtensionContext, pi: ExtensionAPI): RouterRuntimeHost {
	return {
		async candidatesFor(targets, cooldowns) {
			const allowed = context.scopedModels.length
				? new Set(context.scopedModels.map(({ model }) => `${model.provider}/${model.id}`))
				: undefined;
			const candidates: CandidateInfo[] = [];
			for (const target of targets) {
				const key = `${target.provider}/${target.model}`;
				const model = target.provider === ROUTER_PROVIDER_ID || (allowed && !allowed.has(key))
					? undefined
					: context.modelRegistry.find(target.provider, target.model);
				const auth = model ? await context.modelRegistry.getApiKeyAndHeaders(model) : undefined;
				const cooldown = cooldowns.get(key);
				candidates.push({
					target,
					key,
					...(model ? { capabilities: modelCapabilities(model) } : {}),
					healthy: Boolean(model && auth?.ok),
					...(cooldown && cooldown.until > Date.now() ? { cooldownUntil: cooldown.until, cooldownReason: cooldown.reason } : {}),
				});
			}
			return candidates;
		},
		async streamTarget(target, streamContext, options, thinking) {
			return delegatePiTarget(
				toPiPublicModelRegistry(context.modelRegistry),
				target,
				streamContext,
				options,
				thinking ? { reasoning: thinking } : undefined,
			) as Promise<AsyncIterable<StreamEventLike>>;
		},
		clampThinking(target, requested) {
			const model = context.modelRegistry.find(target.provider, target.model);
			const map = model?.thinkingLevelMap;
			if (!map || map[requested] !== null) return requested;
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			const requestedIndex = levels.indexOf(requested);
			for (let index = requestedIndex - 1; index >= 0; index--) {
				const level = levels[index];
				if (level && map[level] !== null) return level;
			}
			for (let index = requestedIndex + 1; index < levels.length; index++) {
				const level = levels[index];
				if (level && map[level] !== null) return level;
			}
			return "off";
		},
		persistDecision(type, decision) {
			pi.appendEntry(type, decision);
		},
		async adjudicate(target, prompt, signal) {
			// One-shot tier adjudication through Pi's public complete() — the
			// registry resolves effective provider + auth itself. Fail-open.
			const model = context.modelRegistry.find(target.provider, target.model);
			if (!model) return undefined;
			try {
				const timeout = AbortSignal.timeout(ADJUDICATION_TIMEOUT_MS);
				const reply = await context.modelRegistry.complete(model, {
					messages: [{ role: "user", content: [{ type: "text", text: buildAdjudicationPrompt(prompt) }] }],
				} as Context, { ...(signal !== undefined ? { signal: AbortSignal.any([signal, timeout]) } : { signal: timeout }) });
				const text = reply.content
					.filter((part) => part.type === "text")
					.map((part) => ("text" in part ? part.text : ""))
					.join("")
					.slice(0, ADJUDICATION_MAX_CHARS);
				const tier = parseAdjudicationResponse(text);
				return tier === undefined ? undefined : { tier, model: `${target.provider}/${target.model}` };
			} catch {
				return undefined;
			}
		},
		setStatus(text) {
			try {
				context.ui.setStatus("auto-router", text);
			} catch {
				// Pi print/JSON modes may not expose interactive UI; routing still works.
			}
		},
		now: () => Date.now(),
	};
}

/** Command-side host mapping: shared behavior, Pi-specific UI/auth/reload. */
function createPiCommandHost(
	context: ExtensionContext,
	pi: ExtensionAPI,
	stateRef: { current: PersistentRuntimeState },
	registerProfiles: () => void,
): RouterCommandHost {
	return {
		hostName: "Pi",
		notify(message, level) {
			try {
				context.ui.notify(message, level);
			} catch {
				// print/JSON modes: notify may be absent; never crash on UI
			}
		},
		activeVirtualProfile() {
			const model = context.model;
			return model?.provider === ROUTER_PROVIDER_ID ? model.id : undefined;
		},
		async setVirtualProfile(name) {
			const model = context.modelRegistry.find(ROUTER_PROVIDER_ID, name);
			if (!model) return false;
			return pi.setModel(model);
		},
		appendProfileSwitch(name) {
			pi.appendEntry(PROFILE_STATE_ENTRY, { profile: name });
		},
		async reloadConfig() {
			const loaded = await loadRouterConfiguration({
				userFile: userConfigPath(getAgentDir()),
				...(context.isProjectTrusted() ? { projectFile: projectConfigPath(context.cwd, ".pi") } : {}),
			});
			stateRef.current = createPersistentRuntimeState(loaded.config, `${getAgentDir()}/auto-router`, context.cwd, loaded.errors);
			restoreDecisions(stateRef.current, context);
			registerProfiles();
			return loaded.errors;
		},
		doctorLines() {
			const capability = inspectPiDelegationCapabilities(toPiPublicModelRegistry(context.modelRegistry));
			return [
				capability.supported
					? "✅ required — public ModelRegistry find/getProvider/getApiKeyAndHeaders (stream delegation)"
					: `❌ required — missing public capability: ${capability.missing.join(", ")}`,
				"⚠️ optional — UVI usage reports unavailable through Pi public interface; local budgets, balances, ratings and failover remain enabled",
				context.isProjectTrusted()
					? "✅ project trust — project auto-router.yml loaded"
					: "⚠️ project untrusted — project auto-router.yml ignored",
			];
		},
		quotaAvailable: () => false,
		fetchBalance: (provider, endpoint) => fetchPiBalance(context, provider, endpoint),
		persistClassifierOverrides() {
			persistClassifierOverrides(stateRef.current);
		},
		persistTrackers() {
			persistRuntimeTrackers(stateRef.current);
		},
	};
}

/**
 * Authenticated prepaid-balance fetch through Pi's public auth resolution.
 * The RouterRuntime never sees credentials; this adapter resolves the target
 * provider's API key/headers and performs the request itself.
 */
async function fetchPiBalance(context: ExtensionContext, provider: string, endpoint: string) {
	const model = context.modelRegistry.getAvailable().find((candidate) => candidate.provider === provider);
	if (!model) return undefined;
	const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	try {
		const response = await fetch(endpoint, {
			headers: {
				...(auth.apiKey !== undefined ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
				...Object.fromEntries(Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return undefined;
		return parseProviderBalance(provider, await response.json());
	} catch {
		return undefined;
	}
}

function setPiWidget(context: ExtensionContext, lines: string[]): void {
	try {
		context.ui.setWidget("auto-router", lines);
	} catch {
		// headless contexts lack the widget surface; no-op
	}
}

function modelCapabilities(model: Model<Api>) {
	return {
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
	};
}

function restoreDecisions(state: PersistentRuntimeState, context: ExtensionContext): void {
	const decisions = decisionEntries(context.sessionManager.getBranch());
	state.decisions.restore(decisions);
	const decision = decisions.at(-1);
	if (decision) state.lastDecision = { at: decision.decidedAt, decision, cleanPrompt: "" };
}

async function activatePathProfile(state: PersistentRuntimeState, context: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const pathProfile = matchPathActivation(state.config, context.cwd);
	if (!pathProfile) return;
	const activeModel = context.model;
	// A role-scoped virtual model (`<profile>/<role>`) of the activated
	// profile already satisfies the activation — don't reset its role.
	if (
		activeModel?.provider === ROUTER_PROVIDER_ID &&
		state.registry.parseVirtualModelId(activeModel.id).profile === pathProfile
	) return;
	const model = context.modelRegistry.find(ROUTER_PROVIDER_ID, pathProfile);
	if (model && await pi.setModel(model)) {
		state.registry.switch(pathProfile);
		pi.appendEntry(PROFILE_STATE_ENTRY, { profile: pathProfile });
		state.eventLog.append({ type: "profile-switch", at: Date.now(), profile: pathProfile, reason: "path-activation" });
	}
}

function errorEvent(model: Model<Api>, error: unknown): AssistantMessageEvent {
	return routerErrorEvent(model, error instanceof Error ? error.message : String(error)) as AssistantMessageEvent;
}
