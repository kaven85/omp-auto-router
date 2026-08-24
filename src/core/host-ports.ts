/**
 * HostPorts — the omp-adapter's mapping from core needs to the omp
 * ExtensionAPI surface (ctx.models / ctx.modelRegistry / authStorage).
 *
 * Dependency inversion: core defines the port; nothing in src/core/ may
 * import omp/@oh-my-pi modules. This is the LOW-LEVEL port used by the
 * omp-adapter itself (candidate enrichment, quota, adjudication); the
 * host-neutral runtime consumes the higher-level RouterRuntimeHost /
 * RouterCommandHost seams (src/runtime/), which the adapters build on top
 * of this one. Only members with real callers belong here.
 */

import type {
	ModelCapabilities,
	QuotaSnapshot,
	RouteTarget,
} from "./types";

/** A model as exposed by the host's registry (omp: ctx.models / ModelRegistry). */
export interface HostModel {
	provider: string;
	id: string;
	/** "provider/id". */
	key: string;
	capabilities: ModelCapabilities;
}

export interface HostPorts {
	// ── model registry ──────────────────────────────────────────────────────
	/** Resolve "provider/id", bare id, or role alias to a concrete model (H2). */
	resolveModel(spec: string): HostModel | undefined;
	/** Resolve credentials for a target (full omp auth priority chain). */
	getApiKey(target: RouteTarget): Promise<string | undefined>;
	/** Auth/health check for a candidate. */
	isHealthy(target: RouteTarget): boolean;

	// ── quota (H7) ──────────────────────────────────────────────────────────
	/** omp: AuthStorage.fetchUsageReports() mapped to QuotaSnapshot[]. */
	fetchQuota(providers: string[]): Promise<QuotaSnapshot[]>;

	// ── UI (H6) ─────────────────────────────────────────────────────────────
	setStatus(text: string): void;
	/** Dashboard widget (optional host surface; no-op when unsupported). */
	setWidget(lines: string[]): void;
}
