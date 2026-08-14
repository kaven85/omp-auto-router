import { homedir } from "node:os";

import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CandidateInfo, RouteTarget, RoutingDecision, StreamEventLike } from "../core/types";
import { loadInitialRouterConfiguration, loadRouterConfiguration, projectConfigPath, userConfigPath } from "../runtime/config";
import { ROUTER_DECISION_ENTRY, LEGACY_OMP_DECISION_ENTRY, RouterRuntime, RouterRuntimeError, type RouterRuntimeHost } from "../runtime/router-runtime";
import { createPersistentRuntimeState, persistRuntimeTrackers, type PersistentRuntimeState } from "../runtime/state";
import { delegatePiTarget, inspectPiModeACapabilities } from "./delegated-stream";
import { toPiPublicModelRegistry } from "./public-registry";

const PROVIDER_ID = "auto-router";
const VIRTUAL_API_KEY = "AUTO_ROUTER_VIRTUAL_KEY";
const VIRTUAL_BASE_URL = "http://127.0.0.1:0";

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
		pi.registerProvider(PROVIDER_ID, {
			name: "Auto Router",
			baseUrl: VIRTUAL_BASE_URL,
			apiKey: VIRTUAL_API_KEY,
			api: "openai-completions",
			models: Object.keys(state.config.profiles).map((id) => ({
				id,
				name: `Auto Router: ${id}`,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
			})),
			streamSimple(model, streamContext, options) {
				return bridgeRuntimeStream(stateRef.current, context, pi, model, streamContext, options);
			},
		});
	};
	registerProfiles();

	pi.registerCommand("auto-router", {
		description: "Profile-based auto-router controls",
		async handler(args, commandContext) {
			context = commandContext;
			await runCommand(args, stateRef, context, pi, registerProfiles);
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
		fresh.quotaAvailable = false;
		stateRef.current = fresh;
		restoreDecisions(fresh, ctx);
		registerProfiles();
		await activatePathProfile(fresh, ctx, pi);
	});
	pi.on("session_tree", (_event, ctx) => {
		context = ctx;
		restoreDecisions(stateRef.current, ctx);
	});
	pi.on("session_shutdown", () => persistRuntimeTrackers(stateRef.current));
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build)\b|\b(?:vitest|jest|pytest|go\s+test|cargo\s+test)\b|\btsc\b/.test(command)) {
			stateRef.current.testFailureAt = event.isError ? Date.now() : undefined;
			stateRef.current.eventLog.append({ type: event.isError ? "error" : "decision", at: Date.now(), what: event.isError ? "test-failure" : "test-pass" });
		}
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
			const runtime = new RouterRuntime(state, createPiRuntimeHost(context, pi));
			for await (const event of runtime.stream({
				profile: virtualModel.id,
				context: streamContext,
				options: options as Record<string, unknown> | undefined,
				estimatedTokens: context.getContextUsage()?.tokens ?? undefined,
			})) output.push(event as AssistantMessageEvent);
		} catch (error) {
			output.push(errorEvent(virtualModel, error));
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
			const publicRegistry = toPiPublicModelRegistry(context.modelRegistry);
			const candidates: CandidateInfo[] = [];
			for (const target of targets) {
				const key = `${target.provider}/${target.model}`;
				const model = target.provider === PROVIDER_ID || (allowed && !allowed.has(key))
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
		setStatus(text) {
			try {
				context.ui.setStatus("auto-router", text);
				context.ui.setWidget("auto-router", [text]);
			} catch {
				// Pi print/JSON modes may not expose interactive UI; routing still works.
			}
		},
		now: () => Date.now(),
	};
}

async function runCommand(
	rawArgs: string,
	stateRef: { current: PersistentRuntimeState },
	context: ExtensionContext,
	pi: ExtensionAPI,
	registerProfiles: () => void,
): Promise<void> {
	const [sub = "status", ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
	const argument = rest.join(" ");
	const state = stateRef.current;
	const activeProfile = context.model?.provider === PROVIDER_ID && state.registry.profile(context.model.id)
		? context.model.id
		: state.registry.current();
	const notify = (message: string, level: "info" | "warning" | "error" = "info") => context.ui.notify(message, level);
	switch (sub) {
		case "status":
			return notify(`profile: ${activeProfile}\nlast: ${state.lastDecision ? `${state.lastDecision.decision.tier} → ${state.lastDecision.decision.target.provider}/${state.lastDecision.decision.target.model}` : "—"}\nmode: A (stream delegation)`);
		case "profiles":
			return notify(state.registry.list().map((profile) => `${profile.name === activeProfile ? "▶" : " "} ${profile.name}${profile.description ? ` — ${profile.description}` : ""}`).join("\n"));
		case "current":
			return notify(activeProfile);
		case "use": {
			const name = state.registry.resolveAlias(argument) ?? argument;
			const model = context.modelRegistry.find(PROVIDER_ID, name);
			if (!name || !state.registry.profile(name) || !model) return notify(`unknown profile: ${argument}`, "error");
			if (!await pi.setModel(model)) return notify(`model switch to ${PROVIDER_ID}/${name} failed`, "error");
			state.registry.switch(name);
			pi.appendEntry("com.auto-router.v1.state", { profile: name });
			return notify(`switched to profile: ${name}`);
		}
		case "explain":
			return notify(state.lastDecision ? formatDecision(state.lastDecision.decision) : "no routing decision yet");
		case "doctor": {
			const capability = inspectPiModeACapabilities(toPiPublicModelRegistry(context.modelRegistry));
			return notify([
				"auto-router doctor (Pi)",
				capability.supported ? "✅ Mode A public registry/provider delegation" : `❌ missing: ${capability.missing.join(", ")}`,
				"⚠️ UVI usage reports unavailable through Pi public interface; local budgets and failover remain enabled",
				...state.configErrors.map((error) => `⚠️ ${error}`),
			].join("\n"));
		}
		case "reload": {
			const loaded = await loadRouterConfiguration({ userFile: userConfigPath(getAgentDir()), ...(context.isProjectTrusted() ? { projectFile: projectConfigPath(context.cwd, ".pi") } : {}) });
			stateRef.current = createPersistentRuntimeState(loaded.config, `${getAgentDir()}/auto-router`, context.cwd, loaded.errors);
			restoreDecisions(stateRef.current, context);
			registerProfiles();
			return notify(loaded.errors.length ? `config reloaded with warnings: ${loaded.errors.join("; ")}` : "config reloaded");
		}
		case "help":
			return notify("/auto-router status|profiles|current|use <profile>|explain|doctor|reload");
		default:
			return notify(`unsupported Pi command: ${sub} — run /auto-router help`, "warning");
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
	const decisions = context.sessionManager.getBranch()
		.filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom")
		.filter((entry) => entry.customType === ROUTER_DECISION_ENTRY || entry.customType === LEGACY_OMP_DECISION_ENTRY)
		.map((entry) => entry.data)
		.filter((value): value is RoutingDecision => Boolean(value && typeof value === "object"));
	state.decisions.restore(decisions);
	const decision = decisions.at(-1);
	if (decision) state.lastDecision = { at: decision.decidedAt, decision, cleanPrompt: "" };
}

async function activatePathProfile(state: PersistentRuntimeState, context: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const matchingActivation = state.config.activate?.some((entry) => {
		const prefix = entry.path.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "");
		return prefix.length > 0 && (context.cwd === prefix || context.cwd.startsWith(`${prefix}/`));
	});
	if (!matchingActivation) return;
	const name = state.registry.active().name;
	if (context.model?.provider === PROVIDER_ID && context.model.id === name) return;
	const model = context.modelRegistry.find(PROVIDER_ID, name);
	if (model) await pi.setModel(model);
}

function formatDecision(decision: RoutingDecision): string {
	return [
		`profile=${decision.profile} tier=${decision.tier} (conf ${decision.confidence.toFixed(2)})`,
		`target: ${decision.target.provider}/${decision.target.model}`,
		`chain: ${decision.orderedCandidates.map((target) => `${target.provider}/${target.model}`).join(" → ")}`,
		`tokens≈${decision.estimatedTokens}`,
		...decision.reasoning.map((line) => `· ${line}`),
	].join("\n");
}

function errorEvent(model: Model<Api>, error: unknown): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			timestamp: Date.now(),
		},
	};
}
