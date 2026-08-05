/**
 * HostPorts — the ONLY surface router-core expects from the host (omp).
 *
 * Dependency inversion: core defines the port, `src/omp-adapter/` implements it
 * (M2). Nothing in src/core/ may import omp/@oh-my-pi modules; all host
 * capabilities flow through this interface, enabling the capability-probe
 * degradation matrix from the design doc.
 */

import type {
	CandidateInfo,
	ModelCapabilities,
	QuotaSnapshot,
	RouteTarget,
	ThinkingLevel,
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
	/** Authenticated models available this session (H2). */
	listModels(): HostModel[];
	/** Resolve "provider/id", bare id, or role alias to a concrete model (H2). */
	resolveModel(spec: string): HostModel | undefined;
	/** Resolve credentials for a target (full omp auth priority chain). */
	getApiKey(target: RouteTarget): Promise<string | undefined>;
	/** Auth/health check for a candidate. */
	isHealthy(target: RouteTarget): boolean;

	// ── model switching (Mode B; Mode A delegates streams instead) ──────────
	setModel(key: string): Promise<boolean>;
	setThinkingLevel(level: ThinkingLevel): void;

	// ── quota (H7) ──────────────────────────────────────────────────────────
	/** omp: AuthStorage.fetchUsageReports() mapped to QuotaSnapshot[]. */
	fetchQuota(providers: string[]): Promise<QuotaSnapshot[]>;

	// ── UI (H6) ─────────────────────────────────────────────────────────────
	notify(message: string, level: "info" | "warning" | "error"): void;
	setStatus(text: string): void;
	/** Dashboard widget (optional host surface; no-op when unsupported). */
	setWidget(lines: string[]): void;

	// ── misc ────────────────────────────────────────────────────────────────
	/** Epoch ms (injectable for tests). */
	now(): number;
	/** Current working directory (for path-scoped profile activation). */
	cwd(): string;
}
