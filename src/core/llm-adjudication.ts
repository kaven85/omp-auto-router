/**
 * LLM adjudication for semantically ambiguous prompts.
 *
 * Keyword heuristics can't always tell phases apart ("帮我设计并实现一个登录
 * 功能" bundles a design phase and a build phase). When the complexity
 * classifier reports `mixedPhase`, the adapter asks the session's current LLM
 * to adjudicate with this prompt and parses a single tier word back. Pure
 * prompt-building + parsing lives here (no IO); the stream call lives in the
 * adapter (`src/omp-adapter/llm-adjudicator.ts`).
 */

import type { ComplexityTier } from "./types";

/** Build the one-shot adjudication prompt for a user request. */
export function buildAdjudicationPrompt(userPrompt: string): string {
	return [
		"Classify the complexity of the following coding request into exactly one tier.",
		"Reply with ONE word only — trivial, simple, standard, or complex. No punctuation, no explanation.",
		"",
		"- trivial: short Q&A or meta question, no code work",
		"- simple: single-file or mechanical edit, explanation, grep-like lookup",
		"- standard: implement/build/fix a concrete feature (even when a plan or design is mentioned as input or as a first step)",
		"- complex: the deliverable itself is design/architecture/planning work, a refactor, a migration, or a cross-module change",
		"",
		"When a request bundles phases (e.g. \"design X and implement it\"), classify by the FIRST phase — the work to do now: design first → complex, build first → standard.",
		"",
		"Request:",
		userPrompt,
	].join("\n");
}

/**
 * Parse the adjudicator's reply into a tier. Accepts a bare word or a word
 * embedded in a short sentence ("standard." / "The tier is: complex"); the
 * FIRST tier word in reading order wins. Returns undefined when no tier word
 * is present — the caller keeps the heuristic decision.
 */
export function parseAdjudicationResponse(text: string): ComplexityTier | undefined {
	const match = /\b(trivial|simple|standard|complex)\b/i.exec(text);
	return match?.[1]?.toLowerCase() as ComplexityTier | undefined;
}
