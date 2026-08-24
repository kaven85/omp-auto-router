/**
 * profile-registry — runtime view over RouterConfig profiles.
 *
 * Resolves the active profile (explicit switch > path activation >
 * config.active > first profile), resolves aliases to profile names, and
 * serves tier configs with ladder fallback so sparse profiles (e.g. only
 * `standard` defined) can answer every tier.
 */

import { homedir } from "node:os";
import type { ComplexityTier, ProfileConfig, RoleConfig, RouteTarget, RouterConfig, TierConfig } from "./types";
import { COMPLEXITY_TIERS } from "./types";

/** Role assumed when the virtual model id carries no role segment. */
export const DEFAULT_ROLE = "default";

/** The resolved active profile and its name. */
export interface ActiveProfile {
	name: string;
	profile: ProfileConfig;
}

/** One row of `ProfileRegistry.list()`. */
export interface ProfileListEntry {
	name: string;
	description?: string;
	isActive: boolean;
}

/** Options for ProfileRegistry. */
export interface ProfileRegistryOptions {
	/** Working directory used for path-scoped activation. Defaults to process.cwd(). */
	cwd?: string;
}

/**
 * Search order for tier fallback: the requested tier first, then UP the
 * ladder toward "complex" (nearest first), then DOWN toward "trivial"
 * (nearest first). Lets sparse profiles (e.g. only `standard` defined)
 * serve every tier.
 */
function tierSearchOrder(tier: ComplexityTier): ComplexityTier[] {
	const idx = COMPLEXITY_TIERS.indexOf(tier);
	const up = COMPLEXITY_TIERS.slice(idx);
	const down = COMPLEXITY_TIERS.slice(0, idx).reverse();
	return [...up, ...down];
}

/** Expand a leading `~` (or `~/`) to the user's home directory. */
function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}

/** Segment-aware prefix match: `/a/b` matches `/a/b` and `/a/b/c`, not `/a/bc`. */
function pathPrefixMatches(prefix: string, cwd: string): boolean {
	return cwd === prefix || cwd.startsWith(`${prefix}/`);
}

/**
 * Longest `activate[].path` prefix of cwd, `~` expanded; undefined when none
 * match. The single implementation of path activation — both adapters and the
 * registry's own active-profile resolution go through it.
 */
export function matchPathActivation(config: RouterConfig, cwd: string): string | undefined {
	const entries = config.activate;
	if (!entries || entries.length === 0) return undefined;
	let best: { len: number; profile: string } | undefined;
	for (const entry of entries) {
		if (!config.profiles[entry.profile]) continue;
		const expanded = expandHome(entry.path).replace(/\/+$/, "");
		if (expanded.length === 0) continue;
		if (!pathPrefixMatches(expanded, cwd)) continue;
		if (best === undefined || expanded.length > best.len) {
			best = { len: expanded.length, profile: entry.profile };
		}
	}
	return best?.profile;
}

/** Every route target a profile can serve: tier targets plus fixed role chains. */
export function profileTargets(profile: ProfileConfig): RouteTarget[] {
	return [
		...Object.values(profile.tiers).flatMap((tier) => tier?.targets ?? []),
		...Object.values(profile.roles ?? {}).flatMap((role) => role.targets ?? []),
	];
}

/**
 * Runtime registry over RouterConfig profiles. Holds no global state and
 * performs no I/O; cwd and home directory are read from the environment.
 */
export class ProfileRegistry {
	private readonly config: RouterConfig;
	private readonly cwd: string;
	private switched: string | undefined;

	constructor(config: RouterConfig, opts: ProfileRegistryOptions = {}) {
		this.config = config;
		this.cwd = opts.cwd ?? process.cwd();
	}

	/**
	 * Resolve the active profile. Order: explicit `switch()` > path
	 * activation (longest matching `activate[].path` prefix of cwd, with `~`
	 * expansion; entries naming unknown profiles are skipped) >
	 * `config.active` > first profile in `profiles`.
	 */
	active(): ActiveProfile {
		const name = this.resolveActiveName();
		if (name === undefined) {
			throw new Error("ProfileRegistry: config defines no profiles");
		}
		const profile = this.config.profiles[name];
		if (profile === undefined) {
			throw new Error(`ProfileRegistry: resolved profile "${name}" is missing`);
		}
		return { name, profile };
	}

	/** Name of the active profile (see `active()` for resolution order). */
	current(): string {
		return this.active().name;
	}

	/**
	 * Explicitly switch the active profile by name (alias resolution is NOT
	 * applied; use `resolveAlias` first). Returns false and changes nothing
	 * for unknown profile names.
	 */
	switch(name: string): boolean {
		if (this.config.profiles[name] === undefined) return false;
		this.switched = name;
		return true;
	}

	/** Raw profile lookup by exact name (alias resolution NOT applied). */
	profile(name: string): ProfileConfig | undefined {
		return this.config.profiles[name];
	}

	/** Role config inside a profile, or undefined when the role is undeclared. */
	roleConfig(profileName: string, role: string): RoleConfig | undefined {
		return this.config.profiles[profileName]?.roles?.[role];
	}

	/**
	 * Split a virtual model id (`<profile>` or `<profile>/<role>`) into its
	 * parts. Profile names are matched registry-aware: the full id wins, then
	 * the longest `head/role` split whose head is a known profile. Unknown
	 * profiles come back as `{ profile: id, role: "default" }` so the runtime
	 * can report the unknown profile rather than mis-slicing the id.
	 */
	parseVirtualModelId(id: string): { profile: string; role: string } {
		if (this.config.profiles[id] !== undefined) return { profile: id, role: DEFAULT_ROLE };
		const slash = id.lastIndexOf("/");
		if (slash > 0 && slash < id.length - 1) {
			const head = id.slice(0, slash);
			if (this.config.profiles[head] !== undefined) {
				return { profile: head, role: id.slice(slash + 1) };
			}
		}
		return { profile: id, role: DEFAULT_ROLE };
	}

	/** All profiles with an isActive flag, in config order. */
	list(): ProfileListEntry[] {
		const currentName = this.current();
		return Object.entries(this.config.profiles).map(([name, profile]) => {
			const entry: ProfileListEntry = { name, isActive: name === currentName };
			if (profile.description !== undefined) entry.description = profile.description;
			return entry;
		});
	}

	/**
	 * Resolve an alias to a profile name: the first element of
	 * `aliases[alias]` that names an existing profile, or undefined.
	 */
	resolveAlias(alias: string): string | undefined {
		const targets = this.config.aliases?.[alias];
		if (targets === undefined) return undefined;
		for (const target of targets) {
			if (this.config.profiles[target] !== undefined) return target;
		}
		return undefined;
	}

	/**
	 * Tier config for a profile with ladder fallback (see TIER_LADDER):
	 * exact tier first, then UP toward "complex", then DOWN toward
	 * "trivial". Undefined when the profile is unknown or defines no tiers.
	 */
	tierConfig(profileName: string, tier: ComplexityTier): TierConfig | undefined {
		const profile = this.config.profiles[profileName];
		if (profile === undefined) return undefined;
		for (const candidate of tierSearchOrder(tier)) {
			const config = profile.tiers[candidate];
			if (config !== undefined) return config;
		}
		return undefined;
	}

	private resolveActiveName(): string | undefined {
		if (this.switched !== undefined && this.config.profiles[this.switched] !== undefined) {
			return this.switched;
		}
		const byPath = this.matchPathActivation();
		if (byPath !== undefined) return byPath;
		const configured = this.config.active;
		if (configured !== undefined && this.config.profiles[configured] !== undefined) {
			return configured;
		}
		return Object.keys(this.config.profiles)[0];
	}

	/** Longest matching `activate[].path` prefix of cwd wins; `~` expanded. */
	private matchPathActivation(): string | undefined {
		return matchPathActivation(this.config, this.cwd);
	}
}
