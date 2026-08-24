/**
 * omp-auto-router extension entry.
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

import * as path from "node:path";

import type { AdapterState } from "./state";
import { createAdapterState, refreshModels } from "./state";
import { persistRuntimeTrackers } from "../runtime/state";
import { agentDir, loadAdapterConfigSync } from "./config";
import { registerCommands } from "./commands";
import { createStreamHandler } from "./router";
import { createHostPorts } from "./host-ports";
import type { OmpExtensionApi, OmpExtensionContext, OmpProviderConfig } from "./omp-api";
import { pickSafeEvent } from "../core/redact";
import { matchPathActivation } from "../core/profile-registry";
import { quotaRefreshMs } from "../runtime/env";
import { renderRouterWidget } from "../runtime/widget";
import {
	buildVirtualModels,
	configuredTargets,
	decisionEntries,
	recordTestOutcome,
	TEST_COMMAND_RE,
	VIRTUAL_API_KEY,
	VIRTUAL_BASE_URL,
} from "../runtime/adapter-kit";

/** Handle of the background quota-refresh timer; at most one runs per process. */
let quotaRefreshTimer: unknown;

/**
 * Refresh UVI quota snapshots in the background so requests never block on
 * the auth chain when the cache just expired. Managed by the host ctx so the
 * timer dies with the session (omp requirement).
 */
/**
 * One background quota-refresh tick: re-fetch UVI snapshots into the cache,
 * then push-render the widget so the display tracks the cache within one
 * cadence instead of waiting for the next request. Exported for tests; the
 * session interval below just schedules it.
 */
export async function refreshQuotaAndRender(
	stateRef: { current: AdapterState | undefined },
	pi: OmpExtensionApi,
): Promise<void> {
	const current = stateRef.current;
	if (!current?.ctx) return;
	// Tier targets plus fixed-role chains — role-only providers need warmed
	// quota snapshots just as much as tier providers.
	const providers = new Set(configuredTargets(current.registry).map((target) => target.provider));
	if (providers.size === 0) return;
	const host = createHostPorts(current.ctx, current);
	try {
		const snapshots = await host.fetchQuota([...providers]);
		current.quotaCache = { at: Date.now(), data: snapshots };
		renderRouterWidget(current, (lines) => host.setWidget(lines), current.lastDecision?.decision);
	} catch {
		// best-effort background refresh; request-path refresh retries
	}
}

function startQuotaRefresh(stateRef: { current: AdapterState | undefined }, pi: OmpExtensionApi, ctx: OmpExtensionContext): void {
	stopQuotaRefresh(ctx);
	const state = stateRef.current;
	if (!state?.uviEnabled) return;
	quotaRefreshTimer = ctx.setInterval(() => {
		void refreshQuotaAndRender(stateRef, pi);
	}, quotaRefreshMs());
}

function stopQuotaRefresh(ctx: OmpExtensionContext): void {
	if (quotaRefreshTimer !== undefined) {
		ctx.clearTimer(quotaRefreshTimer);
		quotaRefreshTimer = undefined;
	}
}

/** Provider models can only be registered during OMP's load phase. */
function virtualModelCatalog(profiles: Parameters<typeof buildVirtualModels>[0]): string {
	return buildVirtualModels(profiles).map((model) => model.id).sort().join("\u0000");
}


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
	const models: NonNullable<OmpProviderConfig["models"]> = buildVirtualModels(state.config.profiles);

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
	state.doctorProbes.retryEvents = typeof pi.on === "function";

	// ── Commands: registered once at load; read state through the ref ───────
	registerCommands(pi, {
		getState: () => stateRef.current,
		pi,
		reloadConfig: () => {
			const current = stateRef.current;
			const cwd2 = current?.cwd ?? process.cwd();
			const loaded2 = loadAdapterConfigSync(cwd2);
			// OMP indexes provider models during the synchronous load phase. Do not
			// install a config that advertises profiles/roles the host cannot select.
			if (current && virtualModelCatalog(current.config.profiles) !== virtualModelCatalog(loaded2.config.profiles)) {
				return Promise.resolve([
					...loaded2.errors,
					"virtual model catalog changed; restart OMP to apply profile/role additions or removals",
				]);
			}
			const fresh = createAdapterState(loaded2.config, path.join(agentDir(), "auto-router"), cwd2, loaded2.errors);
			if (current?.ctx) {
				fresh.ctx = current.ctx;
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
		// Write through the live ref: `reloadConfig` swaps stateRef.current to a
		// fresh object, and booting the stale closure would orphan the ctx.
		const current = stateRef.current;
		if (!current) return;
		current.ctx = ctx;
		current.doctorProbes.models = ctx.models.list().length > 0;
		current.doctorProbes.ui = typeof ctx.ui?.notify === "function" && typeof ctx.ui?.setStatus === "function";
		current.doctorProbes.quota = typeof ctx.modelRegistry?.authStorage?.fetchUsageReports === "function";
		refreshModels(current, ctx);
		restoreDecisions(current, ctx);

		// ── Path-scoped profile activation (activate:) ──────────────────────
		const pathProfile = matchPathActivation(current.config, ctx.cwd);
		if (pathProfile) {
			const activeModel = ctx.models.current();
			// A role-scoped virtual model (`<profile>/<role>`) of the activated
			// profile already satisfies the activation — don't reset its role.
			const already =
				activeModel?.provider === "auto-router" &&
				current.registry.parseVirtualModelId(activeModel.id).profile === pathProfile;
			if (!already) {
				const ok = await pi.setModel({ provider: "auto-router", id: pathProfile, api: "auto-router" });
				if (ok) {
					pi.appendEntry("com.omp.auto-router.state", { profile: pathProfile });
					current.eventLog.append({ type: "profile-switch", at: Date.now(), profile: pathProfile, reason: "path-activation" });
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
		startQuotaRefresh(stateRef, pi, ctx);
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
		if (current.ctx) stopQuotaRefresh(current.ctx);
		persistRuntimeTrackers(current);
	});

	// Test/build outcome detection: a failed test command temporarily raises
	// the tier floor (see TEST_FAILURE_ESCALATION_MS in router-runtime).
	pi.on("tool_result", (event) => {
		const current = stateRef.current;
		if (!current || typeof event !== "object" || event === null) return;
		if (!("toolName" in event) || event.toolName !== "bash") return;
		const input = "input" in event ? event.input : undefined;
		const command =
			typeof input === "object" && input !== null && "command" in input && typeof input.command === "string"
				? input.command
				: "";
		if (!TEST_COMMAND_RE.test(command)) return;
		recordTestOutcome(current, command, "isError" in event && event.isError === true);
	});
}

function restoreDecisions(state: AdapterState, ctx: OmpExtensionContext): void {
	const prior = decisionEntries(ctx.sessionManager.getBranch());
	if (prior.length > 0) state.decisions.restore(prior);
}
