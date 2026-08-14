/**
 * Host-neutral environment variable resolution.
 *
 * Precedence (spec decision 31): host-neutral `AUTO_ROUTER_*` first, then the
 * legacy `OMP_AUTO_ROUTER_*` alias, then the host-specific
 * `PI_AUTO_ROUTER_*` alias. New writes and documentation use the neutral
 * prefix only; the prefixed aliases exist so existing OMP automation keeps
 * working and Pi users can scope a host-specific override.
 */

function readEnvNumber(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * First defined numeric value across the neutral → OMP-legacy → Pi-alias key
 * chain for a suffix (e.g. `COOLDOWN_MS`). Invalid values fall through to the
 * next alias; `min` floors the accepted value (values below it are treated as
 * absent); `fallback` applies when no alias yields a usable number.
 */
export function routerEnvNumber(suffix: string, options: { min: number; fallback: number }): number {
	for (const prefix of ["AUTO_ROUTER_", "OMP_AUTO_ROUTER_", "PI_AUTO_ROUTER_"]) {
		const value = readEnvNumber(`${prefix}${suffix}`);
		if (value !== undefined && value >= options.min) return value;
	}
	return options.fallback;
}

/** First defined boolean flag across the alias chain; "1"/"true" enable, anything else (when defined) disables. */
export function routerEnvFlag(suffix: string, fallback: boolean): boolean {
	for (const prefix of ["AUTO_ROUTER_", "OMP_AUTO_ROUTER_", "PI_AUTO_ROUTER_"]) {
		const raw = process.env[`${prefix}${suffix}`];
		if (raw !== undefined) return raw === "1" || raw === "true";
	}
	return fallback;
}

/** Exclude stressed-UVI providers entirely (UVI_HARD chain; default off). */
export function uviHardMode(): boolean {
	return routerEnvFlag("UVI_HARD", false);
}

/** Classifier confidence gate (CONFIDENCE_THRESHOLD chain; default 0.45). */
export function confidenceThreshold(): number {
	for (const prefix of ["AUTO_ROUTER_", "OMP_AUTO_ROUTER_", "PI_AUTO_ROUTER_"]) {
		const value = readEnvNumber(`${prefix}CONFIDENCE_THRESHOLD`);
		if (value !== undefined) return value;
	}
	return 0.45;
}

/** LLM adjudication of mixed-phase prompts (LLM_ADJUDICATE chain; default on; "0"/"false" disable). */
export function llmAdjudicationEnabled(): boolean {
	for (const prefix of ["AUTO_ROUTER_", "OMP_AUTO_ROUTER_", "PI_AUTO_ROUTER_"]) {
		const raw = process.env[`${prefix}LLM_ADJUDICATE`];
		if (raw !== undefined) return raw !== "0" && raw !== "false";
	}
	return true;
}

/**
 * Effective post-failure cooldown: env override floored at 5s. Kept short by
 * default — a cooled target with no fallback leaves the profile with no
 * eligible candidates.
 */
export function cooldownAfterFailureMs(): number {
	return routerEnvNumber("COOLDOWN_MS", { min: 5_000, fallback: 60_000 });
}

/**
 * Effective quota-refresh cadence: env override floored at 10s — provider
 * usage reports update at minute granularity, so polling faster buys nothing
 * and wastes auth-chain calls.
 */
export function quotaRefreshMs(): number {
	return routerEnvNumber("QUOTA_REFRESH_MS", { min: 10_000, fallback: 30_000 });
}
