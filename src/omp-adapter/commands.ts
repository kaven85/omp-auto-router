/**
 * /auto-router command registration for OMP.
 *
 * All command behavior (subcommands, quota table, rules editing, help,
 * completions) lives in the host-neutral runtime layer; this module only
 * wires the OMP host mapping: notifications, virtual-model switching,
 * session persistence, capability probes and authenticated quota/balance
 * fetch.
 */

import { buildRouterCompletions, runRouterCommand, type RouterCommandHost } from "../runtime/commands";
import { persistClassifierOverrides } from "../runtime/state";
import { VIRTUAL_MODEL_BASE } from "../runtime/adapter-kit";
import { fetchOmpBalance } from "./balance";
import { agentDir } from "./config";
import { createHostPorts } from "./host-ports";
import { probeModelRoles } from "./model-roles";
import type { OmpExtensionApi, OmpExtensionContext } from "./omp-api";
import type { AdapterState } from "./state";

export interface CommandDeps {
	/** Current adapter state (undefined until session_start boot). */
	getState: () => AdapterState | undefined;
	reloadConfig: () => Promise<string[]>;
	pi: OmpExtensionApi;
}

export function registerCommands(pi: OmpExtensionApi, deps: CommandDeps): void {
	pi.registerCommand("auto-router", {
		description: "omp-auto-router：profile/复杂度路由控制",
		getArgumentCompletions: (argumentPrefix) => buildRouterCompletions(argumentPrefix ?? "", deps.getState()),
		handler: async (args, ctx) => {
			const state = deps.getState();
			if (!state) {
				ctx.ui.notify("auto-router not ready yet (session still booting) — try again in a moment", "warning");
				return;
			}
			await runRouterCommand(args ?? "", state, createOmpCommandHost(state, deps, ctx));
		},
	});
}

/** OMP host mapping for the shared command interpreter. */
function createOmpCommandHost(state: AdapterState, deps: CommandDeps, ctx: OmpExtensionContext): RouterCommandHost {
	return {
		hostName: "OMP",
		notify(message, level) {
			try {
				ctx.ui.notify(message, level);
			} catch {
				// headless/no-ui contexts: notify is a no-op; never crash on it
			}
		},
		activeVirtualProfile() {
			// Raw virtual model id (may be `<profile>/<role>`); the shared
			// command layer reduces it to its profile.
			const current = state.ctx?.models.current();
			return current?.provider === "auto-router" ? current.id : undefined;
		},
		async setVirtualProfile(name) {
			// Prefer the registered virtual model; fall back to the static
			// construction so hosts without the provider models indexed (tests,
			// partial boots) still switch.
			const model =
				state.ctx?.models.resolve(`auto-router/${name}`) ?? {
					provider: "auto-router",
					id: name,
					api: "auto-router",
					...VIRTUAL_MODEL_BASE,
				};
			return deps.pi.setModel(model);
		},
		appendProfileSwitch(name) {
			deps.pi.appendEntry("com.auto-router.v1.state", { profile: name });
		},
		reloadConfig: () => deps.reloadConfig(),
		doctorLines() {
			const checks: Array<[string, boolean, string]> = [
				["H1 registerProvider/stream", state.doctorProbes.registerProvider, "virtual provider + stream delegation"],
				["H2 ctx.models", state.doctorProbes.models, `${state.modelsByKey.size} models indexed`],
				["H3 setModel/thinking", state.doctorProbes.setModel, "model + thinking switching"],
				["H4 retry events", state.doctorProbes.retryEvents, "auto_retry_* observers"],
				["H5 appendEntry", state.doctorProbes.appendEntry, "session state persistence"],
				["H6 ui notify/status", state.doctorProbes.ui, "status line + notifications"],
				["H7 authStorage quota", state.doctorProbes.quota, "fetchUsageReports → UVI"],
			];
			return [
				...checks.map(([id, ok, desc]) => `${ok ? "✅" : "⚠️"} ${id} — ${desc}`),
				...probeModelRoles({
					registry: state.registry,
					agentDir: agentDir(),
					cwd: state.cwd,
					isRegistered: (virtualId) =>
						state.modelsByKey.has(`auto-router/${virtualId}`) ||
						ctx.models.resolve(`auto-router/${virtualId}`) !== undefined,
				}),
			];
		},
		quotaAvailable: () => typeof ctx.modelRegistry?.authStorage?.fetchUsageReports === "function",
		fetchQuota: (providers) => createHostPorts(ctx, state).fetchQuota(providers),
		fetchBalance: (provider, endpoint) => fetchOmpBalance(ctx, state, provider, endpoint),
		persistClassifierOverrides: () => persistClassifierOverrides(state),
	};
}
