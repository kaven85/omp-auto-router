/**
 * Shortcut parser: recognizes a single leading capability token
 * (`@reasoning`/`@swe`/`@long`/`@vision`/`@fast`) and/or a `@profile:<name>`
 * override at the start of a prompt, strips them, and derives the capability
 * requirement they imply. Unknown `@tokens` pass through untouched.
 */

import type { CapabilityRequirement, ShortcutResult, ShortcutToken } from "./types";

/** Capability tokens recognized as prompt shortcuts. */
export const SHORTCUT_TOKENS: readonly ShortcutToken[] = [
	"@reasoning",
	"@swe",
	"@long",
	"@vision",
	"@fast",
] as const;

/** Capability requirement implied by each shortcut token. */
export const SHORTCUT_REQUIREMENTS: Record<ShortcutToken, CapabilityRequirement> = {
	"@reasoning": { reasoning: true },
	"@swe": { reasoning: true },
	"@long": { minContextWindow: 100_000 },
	"@vision": { vision: true },
	// `@fast` is a tier hint only; it constrains no capability.
	"@fast": {},
};

/**
 * A recognized leading token: a capability token or `@profile:<name>`.
 * The lookahead requires the token to end at whitespace or end-of-string so
 * `@reasoningfoo` and `@profile:` (empty name) pass through untouched.
 */
const LEADING_TOKEN_RE = /^(@profile:[a-zA-Z0-9_-]+|@reasoning|@swe|@long|@vision|@fast)(?=\s|$)/;

const PROFILE_PREFIX = "@profile:";

/**
 * Parse leading shortcut tokens from a prompt.
 *
 * At most two leading tokens are consumed: one capability token and one
 * `@profile:<name>`, in either order. Matched tokens (and the whitespace
 * around them) are stripped from `cleanPrompt`. If the first non-whitespace
 * token is not a recognized shortcut, the prompt is returned unchanged.
 */
export function parseShortcut(prompt: string): ShortcutResult {
	let rest = prompt.trimStart();
	let token: ShortcutToken | undefined;
	let profileOverride: string | undefined;

	for (let consumed = 0; consumed < 2; consumed++) {
		const match = LEADING_TOKEN_RE.exec(rest);
		const raw = match?.[1];
		if (raw === undefined) break;
		const isProfile = raw.startsWith(PROFILE_PREFIX);
		// Two tokens of the same kind are not a valid combination; stop.
		if (isProfile ? profileOverride !== undefined : token !== undefined) break;
		if (isProfile) profileOverride = raw.slice(PROFILE_PREFIX.length);
		else token = raw as ShortcutToken;
		rest = rest.slice(raw.length).trimStart();
	}

	const matched = token !== undefined || profileOverride !== undefined;
	const requirement: CapabilityRequirement =
		token === undefined ? {} : { ...SHORTCUT_REQUIREMENTS[token] };

	const result: ShortcutResult = { cleanPrompt: matched ? rest : prompt, requirement };
	if (token !== undefined) result.token = token;
	if (profileOverride !== undefined) result.profileOverride = profileOverride;
	return result;
}
