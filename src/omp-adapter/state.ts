/**
 * Adapter-side state shared across the extension entry: the persistent
 * runtime state (src/runtime/state) plus the omp-specific host mappings.
 * One instance per session.
 */

import { createPersistentRuntimeState, type PersistentRuntimeState } from "../runtime/state";
import type { RouterConfig } from "../core/types";
import type { OmpExtensionContext, OmpModel } from "./omp-api";

export interface AdapterState extends PersistentRuntimeState {
	/** Raw omp models by "provider/id" key, from ctx.models.list(). */
	modelsByKey: Map<string, OmpModel>;
	/** Configured target keys observed in the live registry, scoped per chain instead of globally. */
	readyModelKeys: Set<string>;
	/** Resolved project path for path-activation; mirrors ctx.cwd. */
	cwd: string;
	/** Capability-probe results (H1..H7) filled by the entry / doctor. */
	doctorProbes: {
		registerProvider: boolean;
		models: boolean;
		setModel: boolean;
		retryEvents: boolean;
		appendEntry: boolean;
		ui: boolean;
		quota: boolean;
	};
	/** Host extension context captured at session_start (streams run outside ctx). */
	ctx?: OmpExtensionContext;
}

export function createAdapterState(
	config: RouterConfig,
	stateDir: string,
	cwd: string,
	configErrors: string[] = [],
): AdapterState {
	return {
		...createPersistentRuntimeState(config, stateDir, cwd, configErrors),
		modelsByKey: new Map(),
		readyModelKeys: new Set(),
		cwd,
		doctorProbes: {
			registerProvider: false,
			models: false,
			setModel: false,
			retryEvents: false,
			appendEntry: false,
			ui: false,
			quota: false,
		},
	};
}

/** Refresh the raw-model index from the host (ctx.models). */
export function refreshModels(state: AdapterState, ctx: OmpExtensionContext): void {
	state.modelsByKey.clear();
	for (const model of ctx.models.list()) {
		state.modelsByKey.set(`${model.provider}/${model.id}`, model);
	}
}
