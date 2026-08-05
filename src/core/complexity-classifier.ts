/**
 * Complexity classifier: combines weighted heuristic signals (context size,
 * code signals, multi-step phrasing, short Q&A, images) into a base
 * complexity tier, then applies sticky escalation (never downgrade within a
 * session) and explicit shortcut pins (`@fast`/`@swe`/`@reasoning`), which
 * take precedence over everything else.
 */

import { classifyContextSize } from "./context-analyzer";
import { detectCodeSignals } from "./intent-classifier";
import type {
	ComplexityResult,
	ComplexitySignals,
	ComplexityTier,
	IntentResult,
	ShortcutResult,
} from "./types";

/** Input to {@link classifyComplexity}. */
export interface ClassifyComplexityInput {
	/** Prompt text after shortcut stripping. */
	prompt: string;
	/** Estimated prompt tokens (see context-analyzer). */
	estimatedTokens: number;
	/** The request carries image input. */
	hasImages: boolean;
	/** Consecutive turns on the same task; 0 = fresh conversation. */
	conversationDepth: number;
	/** Tier of the previous decision in this session, for sticky escalation. */
	priorTier?: ComplexityTier;
	/** Intent classification of the prompt, when available. */
	intent?: IntentResult;
	/** Parsed shortcut, when the prompt carried one. */
	shortcut?: ShortcutResult;
}

/**
/** Multi-step / cross-cutting phrasing that pushes a task to `complex`.
 * English and Chinese; matched case-insensitively as substrings.
 */
export const MULTI_STEP_KEYWORDS: readonly string[] = [
	"refactor",
	"migrate",
	"migration",
	"redesign",
	"rearchitect",
	"re-architect",
	"overhaul",
	"rewrite",
	"across files",
	"multiple files",
	"cross-file",
	"architecture",
	"重构",
	"迁移",
	"重新设计",
	"跨文件",
	"跨模块",
	"架构",
	"多文件",
	"多个文件",
	"方案",
	"设计",
	"规划",
	"规格",
	"拆分",
	"蓝图",
	"路线图",
	"拆解",
] as const;

/**
 * Multi-step terms matched as WHOLE WORDS (word-boundary regex), English only.
 * These push to `complex` just like MULTI_STEP_KEYWORDS, but are matched with
 * `\b…\b` so a high-frequency sub-string can't false-positive on an unrelated
 * word: `plan` must not hit `planetary`/`applane`, and `spec` must not hit
 * `specific`/`respect`/`spectrum`. Chinese has no word boundaries, so CJK
 * planning/spec phrasing lives in MULTI_STEP_KEYWORDS (substring) instead —
 * e.g. `方案`, `设计`, `规格`.
 */
export const MULTI_STEP_WORD_TERMS: readonly string[] = [
	"plan",
	"plans",
	"planning",
	"planned",
	"design",
	"designs",
	"designing",
	"spec",
	"specs",
	"specification",
	"specifications",
	"roadmap",
	"blueprint",
	"strategy",
	"decompose",
	"modularize",
	"modularise",
	"restructure",
] as const;

/** Whole-word regexes for MULTI_STEP_WORD_TERMS, precompiled once at module load. */
const MULTI_STEP_WORD_RES: readonly RegExp[] = MULTI_STEP_WORD_TERMS.map(
	(term) => new RegExp(`\\b${term}\\b`),
);

/**
 * Repair / debug phrasing that demands reasoning about existing code before
 * acting. Unlike MULTI_STEP_KEYWORDS these do NOT push to `complex` (a bug
 * fix is usually a single file), but they must not stay at `trivial` — a
 * task that says "this function breaks, analyze then fix" requires thinking,
 * not a paint-bucket edit. Escalates to `standard`.
 */
export const REPAIR_DEBUG_KEYWORDS: readonly string[] = [
	"bug",
	"debug",
	"debugging",
	"broken",
	"crash",
	"exception",
	"stack trace",
	"traceback",
	"runtime error",
	"why is",
	"why does",
	"why did",
	"what's wrong",
	"what is wrong",
	"报错",
	"异常",
	"崩溃",
	"排查",
	"定位问题",
	"什么原因",
	"为什么会",
	"为什么报错",
] as const;

/** Estimated-token ceiling for the short-Q&A signal. */
export const SHORT_QA_MAX_TOKENS = 200;

const TIER_ORDER: readonly ComplexityTier[] = ["trivial", "simple", "standard", "complex"];

/** Shortcut tokens that explicitly pin a tier (highest priority). */
const SHORTCUT_TIER_PINS: Partial<Record<string, ComplexityTier>> = {
	"@fast": "simple",
	"@swe": "standard",
	"@reasoning": "complex",
};

interface WeightedSignal {
	tier: ComplexityTier;
	weight: number;
	reason: string;
}

/**
 * Classify prompt complexity into a tier with a confidence score.
 *
 * Precedence: explicit shortcut pin > sticky escalation > weighted base
 * signals. Confidence reflects signal agreement (0.3 floor when signals
 * conflict, up to 0.95 when they all agree); an explicit shortcut pin is
 * certain (1.0). Sticky escalation floors confidence at 0.8 so the caller's
 * low-confidence fallback cannot silently downgrade a session.
 */
export function classifyComplexity(input: ClassifyComplexityInput): ComplexityResult {
	const { prompt, estimatedTokens, hasImages, priorTier, intent, shortcut } = input;

	const codeSignals = detectCodeSignals(prompt);
	const lower = prompt.toLowerCase();
	const multiStepMatches = MULTI_STEP_KEYWORDS.filter((keyword) =>
		lower.includes(keyword.toLowerCase()),
	);
	// English planning/spec/design terms matched as whole words so `plan`
	// doesn't hit `planetary` and `spec` doesn't hit `specific`/`respect`.
	const multiStepWordMatches = MULTI_STEP_WORD_RES.filter((re) => re.test(lower));
	const multiStep = multiStepMatches.length > 0 || multiStepWordMatches.length > 0;
	// Repair/debug phrasing demands reasoning over existing code; gate on the
	// keyword alone (these are inherently code-repair terms, intent-agnostic).
	const repairDebugMatches = REPAIR_DEBUG_KEYWORDS.filter((keyword) =>
		lower.includes(keyword.toLowerCase()),
	);
	const repairDebug = repairDebugMatches.length > 0;
	const shortQa =
		intent?.intent === "general" &&
		estimatedTokens < SHORT_QA_MAX_TOKENS &&
		codeSignals.length === 0 &&
		!repairDebug &&
		!hasImages;

	// ── weighted base signals ────────────────────────────────────────────────
	const weighted: WeightedSignal[] = [];
	const size = classifyContextSize(estimatedTokens);
	if (size === "short") {
		weighted.push({ tier: "trivial", weight: 1, reason: `short context (<4k tokens)` });
	} else if (size === "medium") {
		weighted.push({ tier: "simple", weight: 1, reason: `medium context (4k–32k tokens)` });
	} else if (size === "long") {
		weighted.push({ tier: "standard", weight: 2, reason: `long context (32k–100k tokens)` });
	} else {
		weighted.push({ tier: "complex", weight: 3, reason: `epic context (≥100k tokens)` });
	}
	if (codeSignals.length > 0) {
		weighted.push({
			tier: "standard",
			weight: 2,
			reason: `${codeSignals.join(", ")} → standard`,
		});
	}
	if (repairDebug) {
		weighted.push({
			tier: "standard",
			weight: 2,
			reason: `repair/debug (${repairDebugMatches.join(", ")}) → standard`,
		});
	}
	// Code or analysis intent implies reasoning over the task (understand the
	// request → design → act), so it must not sit in the no-thinking trivial
	// bucket. Weight 1.5 keeps it at standard but never alone beats a multi-step
	// complex signal (weight 5). Skipped when a structural code signal or
	// repair/debug phrasing already pushed standard, to avoid double-counting.
	if (
		(intent?.intent === "code" || intent?.intent === "analysis") &&
		codeSignals.length === 0 &&
		!repairDebug
	) {
		weighted.push({ tier: "standard", weight: 1.5, reason: `${intent.intent} intent → standard` });
	}
	if (multiStep) {
		weighted.push({
			tier: "complex",
			weight: 5,
			reason: `multi-step (${[...multiStepMatches, ...multiStepWordMatches].join(", ")}) → complex`,
		});
	}
	if (shortQa) {
		weighted.push({
			tier: "trivial",
			weight: 1.5,
			reason: `short Q&A (general intent, <${SHORT_QA_MAX_TOKENS} tokens) → trivial`,
		});
	}
	if (hasImages) {
		weighted.push({ tier: "simple", weight: 1, reason: "image input → at least simple" });
	}

	const totals: Record<ComplexityTier, number> = { trivial: 0, simple: 0, standard: 0, complex: 0 };
	let totalWeight = 0;
	for (const signal of weighted) {
		totals[signal.tier] += signal.weight;
		totalWeight += signal.weight;
	}
	// Argmax; ties resolve toward the higher tier (escalation is safer than
	// downgrading a task that barely hinted at more work).
	let tier: ComplexityTier = "trivial";
	for (const candidate of TIER_ORDER) {
		if (totals[candidate] >= totals[tier]) tier = candidate;
	}

	const reasons = weighted.map((signal) => signal.reason);
	let confidence = Math.min(0.95, 0.3 + (0.65 * totals[tier]) / totalWeight);
	let stickyEscalation = false;

	// ── explicit shortcut pin (highest priority) ────────────────────────────
	const pin = shortcut?.token === undefined ? undefined : SHORTCUT_TIER_PINS[shortcut.token];
	if (pin !== undefined) {
		tier = pin;
		confidence = 1;
		reasons.push(`shortcut ${shortcut?.token ?? ""} pins tier ${pin}`);
	} else if (priorTier !== undefined && TIER_ORDER.indexOf(priorTier) > TIER_ORDER.indexOf(tier)) {
		// ── sticky escalation: never downgrade within a session ──────────────
		tier = priorTier;
		stickyEscalation = true;
		confidence = Math.max(confidence, 0.8);
		reasons.push(`sticky escalation: keeping prior tier ${priorTier} (no downgrade)`);
	}

	const signals: ComplexitySignals = {
		estimatedTokens,
		codeSignals,
		repairDebug,
		multiStep,
		shortQa,
		stickyEscalation,
		hasImages,
	};
	return { tier, confidence, signals, reasons };
}
