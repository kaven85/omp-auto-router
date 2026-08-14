import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadRouterConfigFile, mergeRouterConfigs, parseRouterConfig, type ConfigLoadResult } from "../core/config-loader";
import type { RouterConfig } from "../core/types";

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
	active: "default",
	profiles: {
		default: {
			description: "Built-in complexity-aware routing profile",
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
	return assembleRouterConfiguration([[userFile, "user", readConfigFileSync(userFile)]]);
}

function assembleRouterConfiguration(results: ReadonlyArray<readonly [string, "user" | "project", ConfigLoadResult]>): LoadedRouterConfig {
	const errors: string[] = [];
	const layers: string[] = [];
	const configs: RouterConfig[] = [];
	for (const [file, layer, result] of results) {
		if (result.errors.length) errors.push(`${file}: ${result.errors.join("; ")}`);
		if (!result.config) continue;
		if (layer === "project") stripProjectBalanceEndpoints(result.config, errors, file);
		layers.push(layer);
		configs.push(result.config);
	}
	return { config: mergeRouterConfigs(DEFAULT_ROUTER_CONFIG, ...configs), errors, layers };
}

function stripProjectBalanceEndpoints(config: RouterConfig, errors: string[], file: string): void {
	let removed = 0;
	for (const profile of Object.values(config.profiles)) {
		for (const tier of Object.values(profile.tiers)) {
			if (!tier) continue;
			for (const target of tier.targets) {
				if (target.balanceEndpoint !== undefined) {
					delete target.balanceEndpoint;
					removed++;
				}
			}
		}
	}
	if (removed) errors.push(`${file}: ignored ${removed} project balanceEndpoint override(s)`);
}

function readConfigFileSync(file: string): ConfigLoadResult {
	try {
		return parseRouterConfig(readFileSync(file, "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { errors: [] } : { errors: [String(error)] };
	}
}
