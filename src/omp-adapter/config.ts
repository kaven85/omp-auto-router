/**
 * Config loading for the omp adapter: user config (~/.omp/agent/auto-router.yml)
 * layered with project config (<cwd>/.omp/auto-router.yml), merged over
 * built-in defaults. Failure is non-fatal — an invalid config falls back to
 * defaults with errors surfaced via /auto-router doctor.
 */

import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";

import { loadRouterConfigFile, mergeRouterConfigs, parseRouterConfig } from "../core/config-loader";
import type { ConfigLoadResult } from "../core/config-loader";
import type { RouterConfig } from "../core/types";

export interface LoadedConfig {
	config: RouterConfig;
	/** Dotted-path validation errors (non-fatal when a fallback exists). */
	errors: string[];
	/** Which layers were actually loaded. */
	layers: string[];
}

/** Built-in minimal default so the extension is usable with zero config. */
export const DEFAULT_CONFIG: RouterConfig = {
	active: "default",
	profiles: {
		default: {
			description: "内置默认：按复杂度分级，订阅优先",
			defaultTier: "standard",
			tiers: {
				trivial: {
					thinking: "low",
					targets: [{ provider: "deepseek", model: "deepseek-v4-flash", billing: "per-token" }],
				},
				simple: {
					thinking: "low",
					targets: [{ provider: "deepseek", model: "deepseek-v4-flash", billing: "per-token" }],
				},
				standard: {
					thinking: "medium",
					targets: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
				},
				complex: {
					thinking: "high",
					targets: [{ provider: "anthropic", model: "claude-opus-4-5" }],
				},
			},
		},
	},
};

/** Agent dir honoring omp's PI_CODING_AGENT_DIR override. */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
}

/** ~/.omp/agent/auto-router.yml */
export function userConfigPath(): string {
	return path.join(agentDir(), "auto-router.yml");
}

/** <cwd>/.omp/auto-router.yml */
export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".omp", "auto-router.yml");
}

/** Shared layering: user config then project config over DEFAULT_CONFIG, collecting non-fatal errors. */
function assemble(results: ReadonlyArray<readonly [label: string, layer: "user" | "project", result: ConfigLoadResult]>): LoadedConfig {
	const errors: string[] = [];
	const layers: string[] = [];
	const parts: (RouterConfig | undefined)[] = [];
	for (const [label, layer, result] of results) {
		if (result.errors.length > 0) {
			errors.push(`${label}: ${result.errors.join("; ")}`);
		}
		if (result.config) {
			if (layer === "project") {
				let stripped = 0;
				for (const profile of Object.values(result.config.profiles)) {
					for (const tier of Object.values(profile.tiers)) {
						if (!tier) continue;
						for (const target of tier.targets) {
							if (target.balanceEndpoint !== undefined) {
								delete target.balanceEndpoint;
								stripped++;
							}
						}
					}
				}
				if (stripped > 0) {
					errors.push(
						`${label}: balanceEndpoint is only honored from the user config layer; stripped ${stripped} target override(s)`,
					);
				}
			}
			layers.push(layer);
			parts.push(result.config);
		}
	}
	return { config: mergeRouterConfigs(DEFAULT_CONFIG, ...parts), errors, layers };
}

/** Synchronous file read mirroring loadRouterConfigFile: ENOENT/ENOTDIR is not an error. */
function readConfigFileSync(file: string): ConfigLoadResult {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { errors: [] };
		return { errors: [String(error)] };
	}
	return parseRouterConfig(text);
}

export async function loadAdapterConfig(cwd: string): Promise<LoadedConfig> {
	return assemble([
		["~/.omp/agent/auto-router.yml", "user", await loadRouterConfigFile(userConfigPath())],
		[".omp/auto-router.yml", "project", await loadRouterConfigFile(projectConfigPath(cwd))],
	]);
}

/**
 * Synchronous variant for the extension factory: registerProvider must run
 * during the load phase (before model resolution), which is synchronous.
 * Same layering as {@link loadAdapterConfig}.
 */
export function loadAdapterConfigSync(cwd: string): LoadedConfig {
	return assemble([
		["~/.omp/agent/auto-router.yml", "user", readConfigFileSync(userConfigPath())],
		[".omp/auto-router.yml", "project", readConfigFileSync(projectConfigPath(cwd))],
	]);
}
