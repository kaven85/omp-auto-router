/**
 * Intent classifier: zero-latency heuristic classification of a prompt into
 * code / creative / analysis / general. Keyword tables are exported so the
 * heuristics can be tuned without touching the scoring logic.
 */

import type { Intent, IntentResult } from "./types";

/** Options for {@link classifyIntent}. */
export interface IntentOptions {
	/** The host attached code context (selection, open file, …) to the prompt. */
	hasCodeContext?: boolean;
}

/** English and Chinese keywords indicating a coding task. */
export const CODE_KEYWORDS: readonly string[] = [
	"code",
	"coding",
	"function",
	"bug",
	"debug",
	"compile",
	"exception",
	"typescript",
	"javascript",
	"python",
	"regex",
	"sql",
	"api",
	"endpoint",
	"unit test",
	"implement",
	"refactor",
	"runtime error",
	"代码",
	"报错",
	"函数",
	"调试",
	"编译",
	"实现",
	"修复",
] as const;

/** English and Chinese keywords indicating a creative-writing task. */
export const CREATIVE_KEYWORDS: readonly string[] = [
	"poem",
	"poetry",
	"story",
	"short story",
	"blog",
	"blog post",
	"essay",
	"lyrics",
	"song",
	"novel",
	"fiction",
	"joke",
	"写诗",
	"诗歌",
	"诗",
	"故事",
	"小说",
	"博客",
	"散文",
	"文案",
	"歌词",
] as const;

/** English and Chinese keywords indicating an analysis/summarization task. */
export const ANALYSIS_KEYWORDS: readonly string[] = [
	"analyze",
	"analyse",
	"analysis",
	"summarize",
	"summarise",
	"summary",
	"compare",
	"comparison",
	"contrast",
	"review",
	"evaluate",
	"evaluation",
	"assess",
	"pros and cons",
	"explain",
	"分析",
	"总结",
	"对比",
	"比较",
	"评审",
	"评估",
	"解释",
] as const;

/** Prompts shorter than this with no signals are classified `general`. */
export const SHORT_PROMPT_CHARS = 80;

const CODE_FENCE_RE = /```|~~~/;
const FILE_PATH_RE =
	/\b(?:[\w@+.-]+\/)*[\w@+.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|json|ya?ml|toml|md|css|scss|html|sh|sql|c|h|cpp|hpp|cs|vue|svelte)\b/g;
const DIFF_RE = /^(?:\+\+\+|---|@@ )|^[+-]\S/m;
const STACK_TRACE_RE =
	/\bat\s+[\w$.<>]+\s*\([^()\n]*:\d+:\d+\)|Traceback \(most recent call last\)|^\s*File "[^"]+", line \d+/m;

/**
 * Detect structural code-ish signals in a prompt. Returns a subset of
 * `"code-fence"`, `"file-path"` (one path), `"multi-file"` (two or more
 * distinct paths), `"diff"`, `"stack-trace"`, in that order. Shared with the
 * complexity classifier so both agree on what "code-ish" means.
 */
export function detectCodeSignals(prompt: string): string[] {
	const signals: string[] = [];
	if (CODE_FENCE_RE.test(prompt)) signals.push("code-fence");
	const paths = prompt.match(FILE_PATH_RE);
	if (paths !== null) {
		signals.push(new Set(paths).size >= 2 ? "multi-file" : "file-path");
	}
	if (DIFF_RE.test(prompt)) signals.push("diff");
	if (STACK_TRACE_RE.test(prompt)) signals.push("stack-trace");
	return signals;
}

const ASCII_WORD_RE = /^[\x20-\x7e]+$/;

/** A precompiled keyword matcher: word-boundary regex for ASCII, lowercase substring otherwise. */
type KeywordMatcher = { test: (lowerPrompt: string) => boolean };

/** Precompile a keyword list once at module load instead of per request. */
function compileKeywords(keywords: readonly string[]): readonly KeywordMatcher[] {
	return keywords.map((keyword) => {
		if (ASCII_WORD_RE.test(keyword)) {
			const re = new RegExp(`\\b${keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
			return { test: (lowerPrompt) => re.test(lowerPrompt) };
		}
		const sub = keyword.toLowerCase();
		return { test: (lowerPrompt) => lowerPrompt.includes(sub) };
	});
}

const CODE_MATCHERS = compileKeywords(CODE_KEYWORDS);
const CREATIVE_MATCHERS = compileKeywords(CREATIVE_KEYWORDS);
const ANALYSIS_MATCHERS = compileKeywords(ANALYSIS_KEYWORDS);

/**
 * Count keyword hits. ASCII keywords match on word boundaries (so `fix` does
 * not fire on `prefix`); CJK keywords match as plain substrings.
 */
function countKeywordHits(prompt: string, matchers: readonly KeywordMatcher[]): number {
	const lower = prompt.toLowerCase();
	let hits = 0;
	for (const matcher of matchers) {
		if (matcher.test(lower)) hits++;
	}
	return hits;
}

/**
 * Classify the intent of a prompt via heuristic scoring: structural code
 * signals weigh 2 each, keyword hits weigh 1 each, attached code context
 * adds 1 to code. Ties resolve toward the more specific intent in the order
 * code → analysis → creative. Prompts with no signal at all are `general`.
 */
export function classifyIntent(prompt: string, opts?: IntentOptions): IntentResult {
	const codeScore =
		2 * detectCodeSignals(prompt).length +
		countKeywordHits(prompt, CODE_MATCHERS) +
		(opts?.hasCodeContext ? 1 : 0);
	const creativeScore = countKeywordHits(prompt, CREATIVE_MATCHERS);
	const analysisScore = countKeywordHits(prompt, ANALYSIS_MATCHERS);

	const total = codeScore + creativeScore + analysisScore;
	if (total === 0) {
		return {
			intent: "general",
			confidence: prompt.length < SHORT_PROMPT_CHARS ? 0.9 : 0.6,
		};
	}

	const scores: Record<Exclude<Intent, "general">, number> = {
		code: codeScore,
		analysis: analysisScore,
		creative: creativeScore,
	};
	let winner: Exclude<Intent, "general"> = "code";
	let top = 0;
	let second = 0;
	for (const intent of ["code", "analysis", "creative"] as const) {
		const score = scores[intent];
		if (score > top) {
			second = top;
			top = score;
			winner = intent;
		} else if (score > second) {
			second = score;
		}
	}

	return {
		intent: winner,
		// Dominance-scaled: a single uncontested signal caps at 0.95, contested
		// signals pull confidence toward 0.5.
		confidence: Math.min(0.95, 0.5 + (0.5 * (top - second)) / total),
	};
}
