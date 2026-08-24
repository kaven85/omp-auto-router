/**
 * Config loading for the omp adapter: user config (~/.omp/agent/auto-router.yml)
 * layered with project config (<cwd>/.omp/auto-router.yml), merged over
 * built-in defaults. Failure is non-fatal — an invalid config falls back to
 * defaults with errors surfaced via /auto-router doctor.
 *
 * The layering, stripping and merge logic lives once in the host-neutral
 * runtime loader (src/runtime/config.ts); this module only wires the omp
 * paths and exposes the loader shapes the adapter's tests exercise.
 */

import * as os from "node:os";
import * as path from "node:path";

import {
	loadRouterConfiguration,
	loadRouterConfigurationSync,
	projectConfigPath as sharedProjectConfigPath,
	userConfigPath as sharedUserConfigPath,
	type LoadedRouterConfig,
} from "../runtime/config";

export type LoadedConfig = LoadedRouterConfig;

/** Agent dir honoring omp's PI_CODING_AGENT_DIR override. */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
}

/** ~/.omp/agent/auto-router.yml */
export function userConfigPath(): string {
	return sharedUserConfigPath(agentDir());
}

/** <cwd>/.omp/auto-router.yml */
export function projectConfigPath(cwd: string): string {
	return sharedProjectConfigPath(cwd, ".omp");
}

/** Async layered load (user then project over defaults), collecting non-fatal errors. */
export async function loadAdapterConfig(cwd: string): Promise<LoadedConfig> {
	return loadRouterConfiguration({
		userFile: userConfigPath(),
		projectFile: projectConfigPath(cwd),
	});
}

/**
 * Synchronous variant for the extension factory: registerProvider must run
 * during the load phase (before model resolution), which is synchronous.
 * Same layering as {@link loadAdapterConfig}.
 */
export function loadAdapterConfigSync(cwd: string): LoadedConfig {
	return loadRouterConfigurationSync({
		userFile: userConfigPath(),
		projectFile: projectConfigPath(cwd),
	});
}
