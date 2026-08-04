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

export async function loadAdapterConfig(cwd: string): Promise<LoadedConfig> {
	const errors: string[] = [];
	const layers: string[] = [];
	const parts: (RouterConfig | undefined)[] = [];

	const user = await loadRouterConfigFile(userConfigPath());
	if (user.errors.length > 0) {
		errors.push(`~/.omp/agent/auto-router.yml: ${user.errors.join("; ")}`);
	}
	if (user.config) {
		layers.push("user");
		parts.push(user.config);
	}

	const project = await loadRouterConfigFile(projectConfigPath(cwd));
	if (project.errors.length > 0) {
		errors.push(`.omp/auto-router.yml: ${project.errors.join("; ")}`);
	}
	if (project.config) {
		layers.push("project");
		parts.push(project.config);
	}

	const config = mergeRouterConfigs(DEFAULT_CONFIG, ...parts);
	return { config, errors, layers };
}

/**
 * Synchronous variant for the extension factory: registerProvider must run
 * during the load phase (before model resolution), which is synchronous.
 * Same layering as {@link loadAdapterConfig}.
 */
export function loadAdapterConfigSync(cwd: string): LoadedConfig {
	const errors: string[] = [];
	const layers: string[] = [];
	const parts: (RouterConfig | undefined)[] = [];

	for (const [label, file] of [
		["~/.omp/agent/auto-router.yml", userConfigPath()],
		[".omp/auto-router.yml", projectConfigPath(cwd)],
	] as const) {
		try {
			const text = readFileSync(file, "utf8");
			const parsed = parseRouterConfig(text);
			if (parsed.errors.length > 0) {
				errors.push(`${label}: ${parsed.errors.join("; ")}`);
			}
			if (parsed.config) {
				layers.push(label.startsWith("~") ? "user" : "project");
				parts.push(parsed.config);
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				errors.push(`${label}: ${String(error)}`);
			}
		}
	}

	const config = mergeRouterConfigs(DEFAULT_CONFIG, ...parts);
	return { config, errors, layers };
}
