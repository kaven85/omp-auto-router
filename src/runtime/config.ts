import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadRouterConfigFile, mergeRouterConfigs, parseRouterConfig, stripBalanceEndpointOverrides, type ConfigLoadResult } from "../core/config-loader";
import type { RouterConfig } from "../core/types";

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
	active: "default",
	profiles: {
		default: {
			description: "内置默认：按复杂度分级，订阅优先",
			defaultTier: "standard",
			tiers: {
				trivial: { thinking: "low", targets: [{ provider: "deepseek", model: "deepseek-v4-flash", billing: "per-token" }] },
				simple: { thinking: "low", targets: [{ provider: "deepseek", model: "deepseek-v4-flash", billing: "per-token" }] },
				standard: { thinking: "medium", targets: [{ provider: "anthropic", model: "claude-sonnet-4-5" }] },
				complex: { thinking: "high", targets: [{ provider: "anthropic", model: "claude-opus-4-5" }] },
			},
		},
	},
};

export interface LoadedRouterConfig {
	config: RouterConfig;
	errors: string[];
	layers: string[];
}

export function userConfigPath(agentDir: string): string {
	return join(agentDir, "auto-router.yml");
}

export function projectConfigPath(cwd: string, configDirName: string): string {
	return join(cwd, configDirName, "auto-router.yml");
}

/** Load the trusted layers in precedence order without making config failure fatal. */
export async function loadRouterConfiguration(options: {
	userFile: string;
	projectFile?: string;
}): Promise<LoadedRouterConfig> {
	const results: Array<[string, "user" | "project", ConfigLoadResult]> = [
		[options.userFile, "user", await loadRouterConfigFile(options.userFile)],
	];
	if (options.projectFile) results.push([options.projectFile, "project", await loadRouterConfigFile(options.projectFile)]);
	return assembleRouterConfiguration(results);
}

/** Synchronous user-only load used when a Provider must be registered at extension load time. */
export function loadInitialRouterConfiguration(userFile: string): LoadedRouterConfig {
	return loadRouterConfigurationSync({ userFile });
}

/**
 * Synchronous layering load (user + optional project) for hosts that must
 * finish config before any async work (omp's load phase). Same layering and
 * stripping rules as the async {@link loadRouterConfiguration}.
 */
export function loadRouterConfigurationSync(options: {
	userFile: string;
	projectFile?: string;
}): LoadedRouterConfig {
	const results: Array<[string, "user" | "project", ConfigLoadResult]> = [
		[options.userFile, "user", readConfigFileSync(options.userFile)],
	];
	if (options.projectFile) results.push([options.projectFile, "project", readConfigFileSync(options.projectFile)]);
	return assembleRouterConfiguration(results);
}

function assembleRouterConfiguration(results: ReadonlyArray<readonly [string, "user" | "project", ConfigLoadResult]>): LoadedRouterConfig {
	const errors: string[] = [];
	const layers: string[] = [];
	const configs: RouterConfig[] = [];
	for (const [file, layer, result] of results) {
		if (result.errors.length) errors.push(`${file}: ${result.errors.join("; ")}`);
		if (!result.config) continue;
		if (layer === "project") {
			const removed = stripBalanceEndpointOverrides(result.config);
			if (removed) errors.push(`${file}: balanceEndpoint is only honored from the user config layer; stripped ${removed} target override(s)`);
		}
		layers.push(layer);
		configs.push(result.config);
	}
	return { config: mergeRouterConfigs(DEFAULT_ROUTER_CONFIG, ...configs), errors, layers };
}

function readConfigFileSync(file: string): ConfigLoadResult {
	try {
		return parseRouterConfig(readFileSync(file, "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { errors: [] } : { errors: [String(error)] };
	}
}
