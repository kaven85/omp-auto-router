/**
 * omp-auto-router extension entry (Mode A).
 *
 * Load phase (synchronous — must finish before omp resolves models):
 *   sync-load config → state → register virtual provider `auto-router`
 *   (one model per profile) → commands → event observers.
 * session_start boot (async): refresh model index, restore persisted state,
 *   path-scoped profile activation.
 *
 * Decoupling contract (design doc §3.2): no omp internal imports, no settings
 * mutation, no monkey patching. Everything runs through the documented
 * ExtensionAPI surface; failures degrade to warnings, never crashes.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { AdapterState } from "./state";
import { createAdapterState, refreshModels, collectProfileBudgets, persistTrackers } from "./state";
import { agentDir, loadAdapterConfigSync } from "./config";
import { registerCommands } from "./commands";
import { createStreamHandler } from "./router";
import type { OmpExtensionApi, OmpExtensionContext, OmpProviderConfig } from "./omp-api";
import { pickSafeEvent } from "./redact";
import type { RoutingDecision } from "../core/types";

/** Placeholder endpoint/key: the virtual provider never sends requests itself. */
const VIRTUAL_BASE_URL = "http://127.0.0.1:0";
const VIRTUAL_API_KEY = "OMP_AUTO_ROUTER_VIRTUAL_KEY";

export default function autoRouterExtension(pi: OmpExtensionApi): void {
	pi.setLabel("Auto Router");

	/** Mutable holder so reload and session events can swap state atomically. */
	const stateRef: { current: AdapterState | undefined } = { current: undefined };

	const cwd = process.cwd();
	const loaded = loadAdapterConfigSync(cwd);
	const state = createAdapterState(loaded.config, path.join(agentDir(), "auto-router"), cwd, loaded.errors);
	stateRef.current = state;

	// ── Virtual provider registration (LOAD PHASE — before model resolution).
	//    Metadata is static (cosmetic for /model display); the pipeline routes
	//    against real models resolved per request.
	const models: NonNullable<OmpProviderConfig["models"]> = Object.keys(state.config.profiles).map((name) => ({
		id: name,
		name: `Auto Router: ${name}`,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	}));

	try {
		pi.registerProvider("auto-router", {
			baseUrl: VIRTUAL_BASE_URL,
			apiKey: VIRTUAL_API_KEY,
			api: "auto-router",
			models,
			streamSimple: (model, context, options) =>
				createStreamHandler(stateRef.current ?? state, pi, {
					model: { provider: "auto-router", id: model.id },
					context: context as never,
					options: options as never,
				}),
		});
		state.doctorProbes.registerProvider = true;
	} catch (error) {
		state.doctorProbes.registerProvider = false;
		pi.logger.error("auto-router: registerProvider failed", error);
	}

	// ── Capability probes (those computable at load) ─────────────────────────
	state.doctorProbes.setModel = typeof pi.setModel === "function";
	state.doctorProbes.appendEntry = typeof pi.appendEntry === "function";

	// ── Commands: registered once at load; read state through the ref ───────
	registerCommands(pi, {
		getState: () => stateRef.current,
		pi,
		reloadConfig: () => {
			const current = stateRef.current;
			const cwd2 = current?.cwd ?? process.cwd();
			const loaded2 = loadAdapterConfigSync(cwd2);
			const fresh = createAdapterState(loaded2.config, path.join(agentDir(), "auto-router"), cwd2, loaded2.errors);
			fresh.budgets.mergeProfileLimits(collectProfileBudgets(fresh.config));
			if (current?.ctx) {
				fresh.ctx = current.ctx;
				fresh.sessionId = current.sessionId;
				refreshModels(fresh, current.ctx);
				restoreDecisions(fresh, current.ctx);
			}
			stateRef.current = fresh;
			return Promise.resolve(loaded2.errors);
		},
	});

	// Safe scalar fields whitelisted from opaque host events before persistence.
	// Anything else the host emits (request content, nested payloads) is dropped.
	const SAFE_EVENT_FIELDS = ["provider", "model", "attempt", "reason"] as const;
	pi.on("auto_retry_start", (event) => {
		stateRef.current?.eventLog.append({
			type: "error",
			at: Date.now(),
			what: "core-retry-start",
			...pickSafeEvent(event, SAFE_EVENT_FIELDS),
		});
	});
	pi.on("auto_retry_end", (event) => {
		stateRef.current?.eventLog.append({
			type: "error",
			at: Date.now(),
			what: "core-retry-end",
			...pickSafeEvent(event, SAFE_EVENT_FIELDS),
		});
	});
	pi.on("retry_fallback_applied", (event) => {
		stateRef.current?.eventLog.append({
			type: "failover",
			at: Date.now(),
			what: "core-fallback-applied",
			...pickSafeEvent(event, SAFE_EVENT_FIELDS),
		});
	});
	pi.on("credential_disabled", (event) => {
		stateRef.current?.eventLog.append({
			type: "error",
			at: Date.now(),
			what: "credential-disabled",
			...pickSafeEvent(event, SAFE_EVENT_FIELDS),
		});
	});

	const boot = async (ctx: OmpExtensionContext): Promise<void> => {
		state.ctx = ctx;
		state.doctorProbes.models = ctx.models.list().length > 0;
		state.doctorProbes.ui = typeof ctx.ui?.notify === "function" && typeof ctx.ui?.setStatus === "function";
		state.doctorProbes.quota = typeof ctx.modelRegistry?.authStorage?.fetchUsageReports === "function";
		refreshModels(state, ctx);
		restoreDecisions(state, ctx);

		// ── Path-scoped profile activation (activate:) ──────────────────────
		const pathProfile = matchPathActivation(state, ctx.cwd);
		if (pathProfile) {
			const current = ctx.models.current();
			const already = current?.provider === "auto-router" && current.id === pathProfile;
			if (!already) {
				const ok = await pi.setModel({ provider: "auto-router", id: pathProfile, api: "auto-router" });
				if (ok) {
					pi.appendEntry("com.omp.auto-router.state", { profile: pathProfile });
					state.eventLog.append({ type: "profile-switch", at: Date.now(), profile: pathProfile, reason: "path-activation" });
				} else {
					pi.logger.warn(`auto-router: path activation to "${pathProfile}" failed`);
				}
			}
		}
	};

	pi.on("session_start", (event, ctx) => {
		// Subagent (task) sessions fire session_start too, with an EMPTY event
		// payload and hasUI:false ctx. Our state/ctx are process-global
		// singletons (Bun module cache shares the factory instance), so adopting
		// a subagent ctx would clobber the main session's ctx and break the
		// status line / session restore afterwards. Rule: first session wins,
		// interactive sessions always win (main interactive has UI; subagents
		// never do). Print-mode mains adopt first and hold.
		const current = stateRef.current;
		const adoptable = !current?.ctx || ctx.hasUI === true;
		if (!adoptable) {
			pi.logger.debug("auto-router: ignoring subagent session_start (no ctx adoption)");
			return;
		}
		void boot(ctx).catch((error) => {
			pi.logger.error("auto-router: boot failed", error);
			try {
				ctx.ui.notify(`auto-router failed to start: ${String(error)}`, "error");
			} catch {
				// no UI context — swallow
			}
		});
	});

	pi.on("session_branch", (event, ctx) => {
		const current = stateRef.current;
		if (!current) return;
		refreshModels(current, ctx);
		current.lastDecision = undefined;
		restoreDecisions(current, ctx);
	});

	pi.on("session_tree", (event, ctx) => {
		const current = stateRef.current;
		if (!current) return;
		refreshModels(current, ctx);
		current.lastDecision = undefined;
	});

	pi.on("session_shutdown", () => {
		const current = stateRef.current;
		if (!current) return;
		persistTrackers(current);
	});

	// Reserved for Mode B (setModel-based routing) — inert in Mode A.
	pi.on("input", () => {});
}

function restoreDecisions(state: AdapterState, ctx: OmpExtensionContext): void {
	const prior: RoutingDecision[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "com.omp.auto-router.decision") {
			prior.push(entry.data as RoutingDecision);
		}
	}
	if (prior.length > 0) state.decisions.restore(prior);
}

/** Longest `activate[].path` prefix of cwd, `~` expanded; undefined when none match. */
function matchPathActivation(state: AdapterState, cwd: string): string | undefined {
	const entries = state.config.activate;
	if (!entries || entries.length === 0) return undefined;
	let best: { len: number; profile: string } | undefined;
	for (const entry of entries) {
		if (!state.config.profiles[entry.profile]) continue;
		const expanded = entry.path.replace(/^~(?=\/|$)/, os.homedir());
		const prefix = expanded.replace(/\/+$/, "");
		if (prefix.length === 0) continue;
		if (cwd === prefix || cwd.startsWith(`${prefix}/`)) {
			if (best === undefined || prefix.length > best.len) {
				best = { len: prefix.length, profile: entry.profile };
			}
		}
	}
	return best?.profile;
}
