/**
 * redact — credential-safe text + event-field whitelisting for log/state
 * persistence.
 *
 * Two rules, applied everywhere user/host data is written to disk:
 *
 *  1. `redactSecrets` — scrub bearer tokens, API keys, JWTs, private keys and
 *     GitHub/cloud access keys from any string before it is persisted. It is
 *     a best-effort lexical scrub, NOT a substitute for not leaking the
 *     secret in the first place — it exists as defense-in-depth so a
 *     provider error string or host event that echoes a credential never
 *     lands verbatim in `auto-router.events.jsonl`.
 *
 *  2. `pickSafeEvent` — whitelisted projection of an opaque host event: only
 *     the named scalar / scalar-array fields survive, each redacted. This
 *     replaces the previous `...(event ?? {})` spread, which copied EVERYTHING
 *     the host emitted (including, potentially, request content) into the
 *     persisted event log.
 */

const REDACTED = "[REDACTED]";

/** Replace `sk-...` / `ghp_...` / `AKIA...` / `AIza...` keys. */
const KEY_RE =
	/\b(?:sk|sk-[A-Za-z0-9]|ghp|github_pat_|xox[baprs]-|AKIA|A3T[A-Z0-9]|AIza|sk-ant-api03-)[-_A-Za-z0-9]{12,}\b/g;
/** Replace JWT-shaped tokens (three dot-separated base64url segments). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** Replace scheme://…:password@ and ?…=token& style credentials in URLs. */
const URL_CRED_RE = /(https?:\/\/)[^\/\s:@]+:[^\/\s@]+@/g;
const QUERY_TOKEN_RE = /([?&](?:api[_-]?key|token|access[_-]?token|auth|key)=)[^&\s]+/gi;
/** Replace PEM private-key / certificate blocks in full. */
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_CERT_RE = /-----BEGIN [A-Z0-9 ]*CERTIFICATE-----[\s\S]*?-----END [A-Z0-9 ]*CERTIFICATE-----/g;
/** Replace `Bearer <long token>` (tolerant of case and separators). */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/gi;
/** Replace raw OpenAI `sk-`-style contiguous secret value after a label. */
const LABELED_SECRET_RE =
	/\b(?:api[_-]?key|access[_-]?key|secret|password|client[_-]?secret|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._~\/+=-]{12,}["']?/gi;

/**
 * Scrub credential-looking substrings from `text`. Pure and total: never
 * throws, returns the input unchanged when nothing looks secret.
 */
export function redactSecrets(text: string): string {
	let out = text;
	out = out.replace(PEM_BLOCK_RE, REDACTED);
	out = out.replace(PEM_CERT_RE, REDACTED);
	out = out.replace(BEARER_RE, "Bearer " + REDACTED);
	out = out.replace(JWT_RE, REDACTED);
	out = out.replace(KEY_RE, REDACTED);
	out = out.replace(QUERY_TOKEN_RE, "$1" + REDACTED);
	out = out.replace(URL_CRED_RE, "$1" + REDACTED + "@");
	out = out.replace(LABELED_SECRET_RE, (m) => m.replace(/^([^:=]{1,64}\s*[:=]\s*["']?)(.*)$/, `$1${REDACTED}`));
	return out;
}

/** True when `v` is a scalar we are willing to persist. */
function isScalar(v: unknown): v is string | number | boolean {
	return (
		typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "boolean"
	);
}

export type SafeScalar = string | number | boolean;

/**
 * Project `event` onto only the whitelisted field names, keeping scalar values
 * (and arrays of scalars) while redacting any strings. Nested objects are
 * dropped entirely — if a safe field ever needs object depth, extend this with
 * an explicit shape rather than recursing blindly (recursion is how secrets
 * leak).
 *
 * Never throws: a malformed `event` yields `{}`.
 */
export function pickSafeEvent(
	event: unknown,
	allow: readonly string[],
): Record<string, SafeScalar | SafeScalar[]> {
	if (typeof event !== "object" || event === null || Array.isArray(event)) {
		return {};
	}
	// Small fixed allow-list → plain Record membership table.
	const allowTable: Record<string, true> = {};
	for (const name of allow) allowTable[name] = true;
	const out: Record<string, SafeScalar | SafeScalar[]> = {};
	for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
		if (!allowTable[key]) continue;
		if (Array.isArray(value)) {
			if (value.every(isScalar)) {
				out[key] = value.map((v) => (typeof v === "string" ? redactSecrets(v) : v));
			}
			continue;
		}
		if (isScalar(value)) {
			out[key] = typeof value === "string" ? redactSecrets(value) : value;
		}
	}
	return out;
}
