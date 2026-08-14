/**
 * Host-neutral path activation: the longest configured `activate[].path`
 * prefix of the session cwd selects the profile, with `~` expanded against
 * the user's home directory. Shared verbatim by both adapters.
 */

import { homedir } from "node:os";

import type { RouterConfig } from "../core/types";

/** Longest `activate[].path` prefix of cwd, `~` expanded; undefined when none match. */
export function matchPathActivation(config: RouterConfig, cwd: string): string | undefined {
	const entries = config.activate;
	if (!entries || entries.length === 0) return undefined;
	let best: { len: number; profile: string } | undefined;
	for (const entry of entries) {
		if (!config.profiles[entry.profile]) continue;
		const expanded = entry.path.replace(/^~(?=\/|$)/, homedir());
		const prefix = expanded.replace(/\/+$/, "");
		if (prefix.length === 0) continue;
		if (cwd === prefix || cwd.startsWith(`${prefix}/`)) {
			if (best === undefined || prefix.length > best.len) {
				best = { len: prefix.length, profile: entry.profile };
			}
		}
	}
	return best?.profile;
}
