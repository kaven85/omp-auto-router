/**
 * config-loader — YAML loading, hand-rolled validation, and layered merging
 * for RouterConfig (auto-router.yml).
 *
 * No external validation deps: every problem is collected into an `errors`
 * list with a dotted path (e.g. `profiles.premium.tiers.standard.targets[0].provider: required`)
 * instead of throwing on user input. A result carries `config` only when
 * `errors` is empty.
 */

import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import {
	COMPLEXITY_TIERS,
	THINKING_LEVELS,
	type Billing,
	type BudgetLimit,
	type CapabilityRequirement,
	type PathActivation,
	type PolicyRuleCondition,
	type PolicyRuleConfig,
	type PolicyRuleType,
	type ProfileConfig,
	type RouteTarget,
	type RouterConfig,
	type ThinkingCap,
	type TierConfig,
} from "./types";

/** Outcome of parsing/loading a RouterConfig. `config` is present iff `errors` is empty. */
export interface ConfigLoadResult {
	config?: RouterConfig;
	errors: string[];
}

const BILLINGS: readonly Billing[] = ["subscription", "per-token"];

const POLICY_RULE_TYPES: readonly PolicyRuleType[] = [
	"force-tier",
	"prefer-provider",
	"exclude-provider",
	"force-billing",
	"force-constraint",
];

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys that would mutate a plain object's prototype if assigned into a
 * parser-built map. Rejected with a validation error during parsing and
 * skipped silently during layer merges (defense-in-depth).
 */
function isUnsafeKey(key: string): boolean {
	return key === "__proto__" || key === "prototype" || key === "constructor";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

function joinOptions(options: readonly string[]): string {
	return options.join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Section parsers (push errors, return best-effort value or undefined)
// ─────────────────────────────────────────────────────────────────────────────

function parseRouteTarget(raw: unknown, path: string, errors: string[]): RouteTarget | undefined {
	if (!isRecord(raw)) {
		errors.push(`${path}: expected a mapping with provider and model`);
		return undefined;
	}
	let ok = true;
	const target: RouteTarget = { provider: "", model: "" };
	if (isNonEmptyString(raw.provider)) {
		target.provider = raw.provider;
	} else {
		errors.push(`${path}.provider: required (non-empty string)`);
		ok = false;
	}
	if (isNonEmptyString(raw.model)) {
		target.model = raw.model;
	} else {
		errors.push(`${path}.model: required (non-empty string)`);
		ok = false;
	}
	if (raw.label !== undefined) {
		if (typeof raw.label === "string") target.label = raw.label;
		else errors.push(`${path}.label: expected a string`);
	}
	if (raw.billing !== undefined) {
		if (oneOf(raw.billing, BILLINGS)) target.billing = raw.billing;
		else errors.push(`${path}.billing: must be one of ${joinOptions(BILLINGS)}`);
	}
	if (raw.balanceEndpoint !== undefined) {
		if (typeof raw.balanceEndpoint === "string") target.balanceEndpoint = raw.balanceEndpoint;
		else errors.push(`${path}.balanceEndpoint: expected a string`);
	}
	if (raw.thinking !== undefined) {
		if (oneOf(raw.thinking, THINKING_LEVELS)) target.thinking = raw.thinking;
		else errors.push(`${path}.thinking: must be one of ${joinOptions(THINKING_LEVELS)}`);
	}
	if (raw.thinkingCap !== undefined) {
		if (!isRecord(raw.thinkingCap)) {
			errors.push(`${path}.thinkingCap: expected {min?, max?} with thinking levels`);
		} else {
			const cap: ThinkingCap = {};
			if (raw.thinkingCap.min !== undefined) {
				if (oneOf(raw.thinkingCap.min, THINKING_LEVELS)) cap.min = raw.thinkingCap.min;
				else errors.push(`${path}.thinkingCap.min: must be one of ${joinOptions(THINKING_LEVELS)}`);
			}
			if (raw.thinkingCap.max !== undefined) {
				if (oneOf(raw.thinkingCap.max, THINKING_LEVELS)) cap.max = raw.thinkingCap.max;
				else errors.push(`${path}.thinkingCap.max: must be one of ${joinOptions(THINKING_LEVELS)}`);
			}
			if (cap.min !== undefined || cap.max !== undefined) target.thinkingCap = cap;
		}
	}
	return ok ? target : undefined;
}

function parseTierConfig(raw: unknown, path: string, errors: string[]): TierConfig | undefined {
	if (!isRecord(raw)) {
		errors.push(`${path}: expected a mapping with targets`);
		return undefined;
	}
	const tier: TierConfig = { targets: [] };
	if (raw.thinking !== undefined) {
		if (oneOf(raw.thinking, THINKING_LEVELS)) tier.thinking = raw.thinking;
		else errors.push(`${path}.thinking: must be one of ${joinOptions(THINKING_LEVELS)}`);
	}
	if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
		errors.push(`${path}.targets: required (non-empty array of route targets)`);
		return undefined;
	}
	const targets: RouteTarget[] = [];
	raw.targets.forEach((t, i) => {
		const parsed = parseRouteTarget(t, `${path}.targets[${i}]`, errors);
		if (parsed !== undefined) targets.push(parsed);
	});
	tier.targets = targets;
	return tier;
}

function parseBudgetLimit(raw: unknown, path: string, errors: string[]): BudgetLimit | undefined {
	if (!isRecord(raw)) {
		errors.push(`${path}: expected a mapping with amount`);
		return undefined;
	}
	let ok = true;
	const budget: BudgetLimit = { amount: 0 };
	if (typeof raw.amount === "number" && Number.isFinite(raw.amount) && raw.amount > 0) {
		budget.amount = raw.amount;
	} else {
		errors.push(`${path}.amount: required (positive number)`);
		ok = false;
	}
	if (raw.monthly !== undefined) {
		if (typeof raw.monthly === "boolean") budget.monthly = raw.monthly;
		else errors.push(`${path}.monthly: expected a boolean`);
	}
	return ok ? budget : undefined;
}

function parseRuleCondition(
	raw: unknown,
	path: string,
	errors: string[],
): PolicyRuleCondition | undefined {
	if (!isRecord(raw)) {
		errors.push(`${path}: expected a mapping`);
		return undefined;
	}
	const when: PolicyRuleCondition = {};
	if (raw.hourStart !== undefined) {
		if (isIntInRange(raw.hourStart, 0, 23)) when.hourStart = raw.hourStart;
		else errors.push(`${path}.hourStart: must be an integer 0-23`);
	}
	if (raw.hourEnd !== undefined) {
		if (isIntInRange(raw.hourEnd, 0, 23)) when.hourEnd = raw.hourEnd;
		else errors.push(`${path}.hourEnd: must be an integer 0-23`);
	}
	if (raw.weekdays !== undefined) {
		if (!Array.isArray(raw.weekdays)) {
			errors.push(`${path}.weekdays: expected an array of integers 0-6 (0 = Sunday)`);
		} else if (raw.weekdays.some((d) => !isIntInRange(d, 0, 6))) {
			errors.push(`${path}.weekdays: entries must be integers 0-6 (0 = Sunday)`);
		} else {
			when.weekdays = [...raw.weekdays];
		}
	}
	return when;
}

function parseConstraint(
	raw: Record<string, unknown>,
	path: string,
	errors: string[],
): Partial<CapabilityRequirement> {
	const constraint: Partial<CapabilityRequirement> = {};
	if (raw.reasoning !== undefined) {
		if (typeof raw.reasoning === "boolean") constraint.reasoning = raw.reasoning;
		else errors.push(`${path}.reasoning: expected a boolean`);
	}
	if (raw.vision !== undefined) {
		if (typeof raw.vision === "boolean") constraint.vision = raw.vision;
		else errors.push(`${path}.vision: expected a boolean`);
	}
	if (raw.minContextWindow !== undefined) {
		if (typeof raw.minContextWindow === "number" && raw.minContextWindow > 0) {
			constraint.minContextWindow = raw.minContextWindow;
		} else {
			errors.push(`${path}.minContextWindow: expected a positive number`);
		}
	}
	return constraint;
}

function parseRule(raw: unknown, path: string, errors: string[]): PolicyRuleConfig | undefined {
	if (!isRecord(raw)) {
		errors.push(`${path}: expected a mapping`);
		return undefined;
	}
	if (!oneOf(raw.type, POLICY_RULE_TYPES)) {
		errors.push(`${path}.type: must be one of ${joinOptions(POLICY_RULE_TYPES)}`);
		return undefined;
	}
	let ok = true;
	const rule: PolicyRuleConfig = { type: raw.type };
	if (raw.priority !== undefined) {
		if (typeof raw.priority === "number" && Number.isFinite(raw.priority)) {
			rule.priority = raw.priority;
		} else {
			errors.push(`${path}.priority: expected a number`);
		}
	}
	if (raw.profiles !== undefined) {
		if (isStringArray(raw.profiles)) rule.profiles = [...raw.profiles];
		else errors.push(`${path}.profiles: expected an array of strings`);
	}
	if (raw.when !== undefined) {
		const when = parseRuleCondition(raw.when, `${path}.when`, errors);
		if (when !== undefined) rule.when = when;
	}
	switch (raw.type) {
		case "force-tier":
			if (oneOf(raw.tier, COMPLEXITY_TIERS)) {
				rule.tier = raw.tier;
			} else {
				errors.push(
					`${path}.tier: required for force-tier (one of ${joinOptions(COMPLEXITY_TIERS)})`,
				);
				ok = false;
			}
			break;
		case "prefer-provider":
		case "exclude-provider":
			if (isStringArray(raw.providers) && raw.providers.length > 0) {
				rule.providers = [...raw.providers];
			} else {
				errors.push(`${path}.providers: required for ${raw.type} (non-empty array of strings)`);
				ok = false;
			}
			break;
		case "force-billing":
			if (oneOf(raw.billing, BILLINGS)) {
				rule.billing = raw.billing;
			} else {
				errors.push(
					`${path}.billing: required for force-billing (one of ${joinOptions(BILLINGS)})`,
				);
				ok = false;
			}
			break;
		case "force-constraint":
			if (isRecord(raw.constraint)) {
				rule.constraint = parseConstraint(raw.constraint, `${path}.constraint`, errors);
			} else {
				errors.push(`${path}.constraint: required for force-constraint (object)`);
				ok = false;
			}
			break;
	}
	return ok ? rule : undefined;
}

function parseProfile(raw: unknown, path: string, errors: string[]): ProfileConfig | undefined {
	if (!isRecord(raw)) {
		errors.push(`${path}: expected a mapping`);
		return undefined;
	}
	const profile: ProfileConfig = { tiers: {} };
	if (raw.description !== undefined) {
		if (typeof raw.description === "string") profile.description = raw.description;
		else errors.push(`${path}.description: expected a string`);
	}
	if (raw.defaultTier !== undefined) {
		if (oneOf(raw.defaultTier, COMPLEXITY_TIERS)) profile.defaultTier = raw.defaultTier;
		else errors.push(`${path}.defaultTier: must be one of ${joinOptions(COMPLEXITY_TIERS)}`);
	}
	if (!isRecord(raw.tiers)) {
		errors.push(`${path}.tiers: required (mapping of tier → tier config)`);
	} else {
		for (const [tierName, tierRaw] of Object.entries(raw.tiers)) {
			const tierPath = `${path}.tiers.${tierName}`;
			if (!oneOf(tierName, COMPLEXITY_TIERS)) {
				errors.push(
					`${tierPath}: unknown tier (must be one of ${joinOptions(COMPLEXITY_TIERS)})`,
				);
				continue;
			}
			const tier = parseTierConfig(tierRaw, tierPath, errors);
			if (tier !== undefined) profile.tiers[tierName] = tier;
		}
	}
	if (raw.budgets !== undefined) {
		if (!isRecord(raw.budgets)) {
			errors.push(`${path}.budgets: expected a mapping of provider → budget limit`);
		} else {
			const budgets: Record<string, BudgetLimit> = {};
			for (const [provider, budgetRaw] of Object.entries(raw.budgets)) {
				if (isUnsafeKey(provider)) {
					errors.push(`${path}.budgets.${provider}: unsafe key "${provider}" rejected`);
					continue;
				}
				const parsed = parseBudgetLimit(budgetRaw, `${path}.budgets.${provider}`, errors);
				if (parsed !== undefined) budgets[provider] = parsed;
			}
			profile.budgets = budgets;
		}
	}
	if (raw.rules !== undefined) {
		if (!Array.isArray(raw.rules)) {
			errors.push(`${path}.rules: expected an array of policy rules`);
		} else {
			const rules: PolicyRuleConfig[] = [];
			raw.rules.forEach((r, i) => {
				const parsed = parseRule(r, `${path}.rules[${i}]`, errors);
				if (parsed !== undefined) rules.push(parsed);
			});
			profile.rules = rules;
		}
	}
	return profile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse and validate RouterConfig YAML text. Collects ALL validation errors
 * with dotted paths; never throws on user input. `config` is present only
 * when `errors` is empty.
 */
export function parseRouterConfig(yamlText: string): ConfigLoadResult {
	let raw: unknown;
	try {
		raw = parse(yamlText);
	} catch (err) {
		const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
		return { errors: [`<yaml>: ${message ?? "invalid YAML"}`] };
	}
	if (raw === null || raw === undefined) {
		return { errors: ["profiles: required (config is empty)"] };
	}
	if (!isRecord(raw)) {
		return { errors: ["<root>: expected a mapping with 'profiles'"] };
	}

	const errors: string[] = [];
	const profiles: Record<string, ProfileConfig> = {};
	const profileNames = new Set<string>();
	if (!isRecord(raw.profiles)) {
		errors.push("profiles: required (non-empty mapping of profile name → profile config)");
	} else {
		for (const name of Object.keys(raw.profiles)) profileNames.add(name);
		if (profileNames.size === 0) {
			errors.push("profiles: must define at least one profile");
		}
		for (const [name, profileRaw] of Object.entries(raw.profiles)) {
			if (isUnsafeKey(name)) {
				errors.push(`profiles.${name}: unsafe key "${name}" rejected`);
				continue;
			}
			const parsed = parseProfile(profileRaw, `profiles.${name}`, errors);
			if (parsed !== undefined) profiles[name] = parsed;
		}
	}

	let active: string | undefined;
	if (raw.active !== undefined) {
		if (typeof raw.active !== "string") {
			errors.push("active: expected a profile name (string)");
		} else if (!profileNames.has(raw.active)) {
			errors.push(`active: unknown profile "${raw.active}"`);
		} else {
			active = raw.active;
		}
	}

	let aliases: Record<string, string[]> | undefined;
	if (raw.aliases !== undefined) {
		if (!isRecord(raw.aliases)) {
			errors.push("aliases: expected a mapping of alias → string[]");
		} else {
			const parsedAliases: Record<string, string[]> = {};
			for (const [alias, value] of Object.entries(raw.aliases)) {
				if (isUnsafeKey(alias)) {
					errors.push(`aliases.${alias}: unsafe key "${alias}" rejected`);
					continue;
				}
				if (isStringArray(value)) {
					parsedAliases[alias] = [...value];
				} else {
					errors.push(`aliases.${alias}: expected an array of strings`);
				}
			}
			aliases = parsedAliases;
		}
	}

	let activate: PathActivation[] | undefined;
	if (raw.activate !== undefined) {
		if (!Array.isArray(raw.activate)) {
			errors.push("activate: expected an array of { path, profile } entries");
		} else {
			const parsedActivate: PathActivation[] = [];
			raw.activate.forEach((entry, i) => {
				const entryPath = `activate[${i}]`;
				if (!isRecord(entry)) {
					errors.push(`${entryPath}: expected a mapping with path and profile`);
					return;
				}
				let ok = true;
				if (!isNonEmptyString(entry.path)) {
					errors.push(`${entryPath}.path: required (non-empty string)`);
					ok = false;
				}
				if (!isNonEmptyString(entry.profile)) {
					errors.push(`${entryPath}.profile: required (non-empty string)`);
					ok = false;
				}
				if (ok && isNonEmptyString(entry.path) && isNonEmptyString(entry.profile)) {
					parsedActivate.push({ path: entry.path, profile: entry.profile });
				}
			});
			activate = parsedActivate;
		}
	}

	if (errors.length > 0) return { errors };
	const config: RouterConfig = { profiles };
	if (active !== undefined) config.active = active;
	if (aliases !== undefined) config.aliases = aliases;
	if (activate !== undefined) config.activate = activate;
	return { config, errors: [] };
}

/**
 * Merge config layers; later layers win. Profiles merge per profile name —
 * a later same-named profile REPLACES the earlier one wholesale. `active`,
 * `aliases`, and `activate` are overridden when present in a later layer.
 * Undefined layers are skipped.
 */
export function mergeRouterConfigs(...layers: (RouterConfig | undefined)[]): RouterConfig {
	const merged: RouterConfig = { profiles: {} };
	for (const layer of layers) {
		if (layer === undefined) continue;
		for (const [name, profile] of Object.entries(layer.profiles)) {
			if (isUnsafeKey(name)) continue;
			merged.profiles[name] = profile;
		}
		if (layer.active !== undefined) merged.active = layer.active;
		if (layer.aliases !== undefined) merged.aliases = layer.aliases;
		if (layer.activate !== undefined) merged.activate = layer.activate;
	}
	return merged;
}

/**
 * Load a RouterConfig from a YAML file. A missing file (ENOENT) is NOT an
 * error and yields an empty result; YAML syntax and validation problems are
 * reported in `errors`.
 */
export async function loadRouterConfigFile(path: string): Promise<ConfigLoadResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if (isNotFoundError(err)) return { errors: [] };
		const message = err instanceof Error ? err.message : String(err);
		return { errors: [`${path}: failed to read file: ${message}`] };
	}
	return parseRouterConfig(text);
}

function isNotFoundError(err: unknown): boolean {
	return (
		typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT"
	);
}
