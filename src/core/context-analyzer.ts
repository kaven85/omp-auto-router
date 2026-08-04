/**
 * Context analysis: heuristic token estimation and context-size classification.
 * Pure functions — no I/O, no clock access, no host dependencies.
 */

/** Size classes for prompt/context length, in estimated tokens. */
export type ContextSizeClass = "short" | "medium" | "long" | "epic";

/** Average characters per token assumed by the heuristic estimator. */
export const CHARS_PER_TOKEN = 4;

/**
 * Upper bounds (exclusive) of each context-size class, in estimated tokens:
 * `< short` → short, `< medium` → medium, `< long` → long, otherwise epic.
 */
export const CONTEXT_SIZE_BOUNDARIES = {
	short: 4_000,
	medium: 32_000,
	long: 100_000,
} as const;

/**
 * Estimate the token count of a text as `ceil(chars / CHARS_PER_TOKEN)`.
 * Deliberately rough — good enough for tier classification, cheap enough to
 * run on every prompt.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Classify an estimated token count into a context-size class. */
export function classifyContextSize(tokens: number): ContextSizeClass {
	if (tokens < CONTEXT_SIZE_BOUNDARIES.short) return "short";
	if (tokens < CONTEXT_SIZE_BOUNDARIES.medium) return "medium";
	if (tokens < CONTEXT_SIZE_BOUNDARIES.long) return "long";
	return "epic";
}
