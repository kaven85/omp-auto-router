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
	/** User-edited keyword-list overrides (`/auto-router rules add/remove`). */
	overrides?: ClassifierOverrides;
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
	// 炒股/量化：策略级任务需要多步推理，归入 complex
	"回测",
	"量化策略",
	"策略开发",
	"全市场筛选",
	"全市场扫描",
	"组合优化",
	"组合管理",
	"因子挖掘",
	"选股引擎",
	"产业链全景",
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
	// quant/finance strategy-level terms
	"backtest",
	"backtesting",
	"rebalance",
	"rebalancing",
] as const;

/** Whole-word regexes for MULTI_STEP_WORD_TERMS, precompiled once at module load. */
const MULTI_STEP_WORD_RES: readonly RegExp[] = MULTI_STEP_WORD_TERMS.map(
	(term) => new RegExp(`\\b${term}\\b`),
);

/**
 * "Soft" planning phrasing inside the multi-step lists. These words describe
 * the *thinking* about a task, not its cross-cutting scope: "设计并实现一个
 * 登录功能" is still a build-it task, so when implementation phrasing is
 * present these must NOT escalate to `complex`. Hard scope terms (重构/迁移/
 * 架构/跨文件, refactor/migrate/rewrite…) always escalate.
 */
const SOFT_MULTI_STEP_KEYWORDS: Record<string, true> = {
	方案: true,
	设计: true,
	规划: true,
	规格: true,
};
const SOFT_MULTI_STEP_WORD_TERMS: Record<string, true> = {
	plan: true,
	plans: true,
	planning: true,
	planned: true,
	design: true,
	designs: true,
	designing: true,
	spec: true,
	specs: true,
	specification: true,
	specifications: true,
};

/**
 * Task splitter for phase-level analysis: phase conjunctions
 * (并/然后/接着/随后/再, and/then) and sentence boundaries separate the
 * CURRENT phase from what comes after. Only the FIRST phase drives the tier
 * — "设计并实现 X" starts with a design phase (complex now, standard when the
 * build turn arrives); "实现 X，然后设计 Y" starts with a build phase
 * (standard now, complex when the design turn arrives). Later phases get
 * their own turns and their own classification.
 */
const TASK_SPLIT_RE = /[。!！?？\n]|并且?|然后|接着|随后|再|\band\b|\bthen\b/;

/**
 * Code-implementation phrasing: the ask is to build a concrete thing, not to
 * plan one. Escalates to `standard` (reasoning over requirements, but usually
 * a contained change) — and demotes soft planning words so "设计并实现 X"
 * lands on standard instead of complex.
 */
export const IMPLEMENTATION_KEYWORDS: readonly string[] = [
	"实现",
	"开发",
	"新增",
	"添加",
	"写个",
	"写一个",
	"做个",
	"做一个",
	"落地",
] as const;

/** Implementation terms matched as WHOLE WORDS (word-boundary regex), English only. */
export const IMPLEMENTATION_WORD_TERMS: readonly string[] = [
	"implement",
	"implements",
	"implemented",
	"implementing",
	"implementation",
	"build",
	"builds",
	"building",
	"create",
	"creates",
	"creating",
	"add",
	"adds",
	"adding",
	"develop",
	"develops",
	"developing",
] as const;

/** Whole-word regexes for IMPLEMENTATION_WORD_TERMS, precompiled once at module load. */
const IMPLEMENTATION_WORD_RES: readonly RegExp[] = IMPLEMENTATION_WORD_TERMS.map(
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

/**
 * Mechanical dev-operation terms matched as WHOLE WORDS (word-boundary
 * regex), English only. These are execute-don't-design operations: the model
 * runs known commands and composes at most a commit message, so they belong
 * in `simple` (low thinking), never in `standard`. Whole-word matching keeps
 * `push` from firing on a "design a push-notification system" prompt — that
 * one also carries `design`/`方案`, which gates the signal off anyway.
 */
export const MECHANICAL_OP_WORD_TERMS: readonly string[] = [
	"commit",
	"commits",
	"push",
	"pull",
	"merge",
	"rebase",
	"stash",
	"cherry-pick",
	"tag",
	"deploy",
	"install",
	"uninstall",
	"lint",
	"format",
] as const;

/** Whole-word regexes for MECHANICAL_OP_WORD_TERMS, precompiled once at module load. */
const MECHANICAL_OP_WORD_RES: readonly RegExp[] = MECHANICAL_OP_WORD_TERMS.map(
	(term) => new RegExp(`\\b${term}\\b`),
);

/**
 * Mechanical dev-operation phrases (Chinese + mixed), matched as substrings.
 * Phrased specifically ("提交代码", not bare "提交") so "提交申请/提交表单"
 * does not false-positive.
 */
export const MECHANICAL_OP_KEYWORDS: readonly string[] = [
	"提交代码",
	"提交并推送",
	"推送代码",
	"推代码",
	"合并分支",
	"合并请求",
	"提个mr",
	"提 mr",
	"提mr",
	"发布版本",
	"发版",
	"跑测试",
	"跑一下测试",
	"格式化代码",
	"安装依赖",
	"装依赖",
	"升级版本号",
	"改版本号",
	"打个tag",
	"打个 tag",
	"打tag",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// User-editable rule overrides (`/auto-router rules add/remove`, persisted as
// classifier-rules.json). The five keyword lists above are the editable
// surface; structural signals (context size, code signals, intent, short Q&A,
// images, sticky escalation, shortcut pins) are fixed and not editable.
// ─────────────────────────────────────────────────────────────────────────────

export const CLASSIFIER_LIST_NAMES = [
	"multiStep",
	"multiStepWord",
	"repairDebug",
	"mechanicalOp",
	"mechanicalOpWord",
	"implementation",
	"implementationWord",
] as const;
export type ClassifierListName = (typeof CLASSIFIER_LIST_NAMES)[number];

/** Tier each editable list pushes toward — used by the rules view. */
export const CLASSIFIER_LIST_META: Record<
	ClassifierListName,
	{ tier: ComplexityTier; weight: number; match: "substring" | "whole-word (EN)"; description: string }
> = {
	multiStep: { tier: "complex", weight: 5, match: "substring", description: "多步/跨文件/方案级措辞" },
	multiStepWord: { tier: "complex", weight: 5, match: "whole-word (EN)", description: "规划/设计类英文整词" },
	repairDebug: { tier: "standard", weight: 2, match: "substring", description: "修复/排错措辞" },
	mechanicalOp: { tier: "simple", weight: 2, match: "substring", description: "机械开发操作短语(中文)" },
	mechanicalOpWord: { tier: "simple", weight: 2, match: "whole-word (EN)", description: "机械操作英文整词" },
	implementation: { tier: "standard", weight: 2, match: "substring", description: "代码实现措辞(中文)；当前任务含实现措辞时软性规划词不升 complex" },
	implementationWord: { tier: "standard", weight: 2, match: "whole-word (EN)", description: "代码实现英文整词；当前任务含实现措辞时 plan/design/spec 不升 complex" },
};

export interface ClassifierOverrides {
	add?: Partial<Record<ClassifierListName, string[]>>;
	remove?: Partial<Record<ClassifierListName, string[]>>;
}

/** Effective keyword lists for one classify call: base constants, or base ± overrides. */
export interface ClassifierLists {
	multiStep: readonly string[];
	multiStepWordRes: readonly RegExp[];
	repairDebug: readonly string[];
	mechanicalOp: readonly string[];
	mechanicalOpWordRes: readonly RegExp[];
	implementation: readonly string[];
	implementationWordRes: readonly RegExp[];
}

const BASE_LISTS: ClassifierLists = {
	multiStep: MULTI_STEP_KEYWORDS,
	multiStepWordRes: MULTI_STEP_WORD_RES,
	repairDebug: REPAIR_DEBUG_KEYWORDS,
	mechanicalOp: MECHANICAL_OP_KEYWORDS,
	mechanicalOpWordRes: MECHANICAL_OP_WORD_RES,
	implementation: IMPLEMENTATION_KEYWORDS,
	implementationWordRes: IMPLEMENTATION_WORD_RES,
};

/** Base keyword array for an editable list name (for view/diff, not matching). */
export function baseClassifierList(name: ClassifierListName): readonly string[] {
	switch (name) {
		case "multiStep": return MULTI_STEP_KEYWORDS;
		case "multiStepWord": return MULTI_STEP_WORD_TERMS;
		case "repairDebug": return REPAIR_DEBUG_KEYWORDS;
		case "mechanicalOp": return MECHANICAL_OP_KEYWORDS;
		case "mechanicalOpWord": return MECHANICAL_OP_WORD_TERMS;
		case "implementation": return IMPLEMENTATION_KEYWORDS;
		case "implementationWord": return IMPLEMENTATION_WORD_TERMS;
	}
}

/**
 * Validate persisted overrides (classifier-rules.json) before use. Keeps only
 * known list names whose add/remove values are arrays of strings; anything
 * else is dropped so a hand-edited or corrupt file degrades to empty
 * overrides instead of being trusted blindly.
 */
export function sanitizeClassifierOverrides(raw: unknown): ClassifierOverrides {
	if (!raw || typeof raw !== "object") return {};
	const out: ClassifierOverrides = {};
	for (const kind of ["add", "remove"] as const) {
		const bucket = (raw as Record<string, unknown>)[kind];
		if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
		const clean: Partial<Record<ClassifierListName, string[]>> = {};
		for (const name of CLASSIFIER_LIST_NAMES) {
			const list = (bucket as Record<string, unknown>)[name];
			if (!Array.isArray(list)) continue;
			const strings = list.filter((k): k is string => typeof k === "string");
			if (strings.length > 0) clean[name] = strings;
		}
		if (Object.keys(clean).length > 0) out[kind] = clean;
	}
	return out;
}

/** True when the overrides object carries no add/remove entries at all. */
export function overridesEmpty(overrides: ClassifierOverrides | undefined): boolean {
	if (!overrides) return true;
	return CLASSIFIER_LIST_NAMES.every(
		(name) => (overrides.add?.[name]?.length ?? 0) === 0 && (overrides.remove?.[name]?.length ?? 0) === 0,
	);
}

function mergeWordList(base: readonly string[], overrides: ClassifierOverrides, name: ClassifierListName): readonly string[] {
	const removed = new Set((overrides.remove?.[name] ?? []).map((k) => k.toLowerCase()));
	const seen = new Set(base.map((k) => k.toLowerCase()));
	const added = (overrides.add?.[name] ?? []).filter((k) => !seen.has(k.toLowerCase()));
	return [...base.filter((k) => !removed.has(k.toLowerCase())), ...added];
}

/**
 * Resolve the effective keyword lists. No overrides → the shared base
 * constants (zero cost). With overrides → merged arrays + freshly compiled
 * whole-word regexes (per request; only when the user actually edited rules).
 */
export function resolveClassifierLists(overrides?: ClassifierOverrides): ClassifierLists {
	if (overridesEmpty(overrides)) return BASE_LISTS;
	const o = overrides!;
	const word = (name: ClassifierListName) =>
		// Escape regex metacharacters so user keywords like `C++` match
		// literally instead of throwing a SyntaxError or enabling ReDoS.
		mergeWordList(baseClassifierList(name), o, name).map(
			(term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
		);
	return {
		multiStep: mergeWordList(MULTI_STEP_KEYWORDS, o, "multiStep"),
		multiStepWordRes: word("multiStepWord"),
		repairDebug: mergeWordList(REPAIR_DEBUG_KEYWORDS, o, "repairDebug"),
		mechanicalOp: mergeWordList(MECHANICAL_OP_KEYWORDS, o, "mechanicalOp"),
		mechanicalOpWordRes: word("mechanicalOpWord"),
		implementation: mergeWordList(IMPLEMENTATION_KEYWORDS, o, "implementation"),
		implementationWordRes: word("implementationWord"),
	};
}

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

	const lists = resolveClassifierLists(input.overrides);
	const codeSignals = detectCodeSignals(prompt);
	const lower = prompt.toLowerCase();
	// Split analysis: phase conjunctions (并/然后/接着/再, and/then) and
	// sentence boundaries separate the CURRENT phase from what comes after.
	// Only the first phase drives the phase signals (implementation /
	// multi-step) — "设计并实现 X" is a design request now (complex); the
	// build gets its own turn later (standard). Follow-up phases are
	// classified when their turn arrives.
	const currentTask =
		lower.split(TASK_SPLIT_RE).find((task) => task.trim().length > 0) ?? lower;
	// Whole-word regex sources are `\b<term>\b`; strip the boundaries to get
	// the underlying term for soft-set lookup and human-readable reasons.
	const wordTerm = (re: RegExp) => re.source.replace(/^\\b|\\b$/g, "");
	// Implementation phrasing: the ask is to build a concrete thing. Checked
	// before multi-step so soft planning words ("设计并实现 X") can be demoted.
	const implementationMatches = lists.implementation.filter((keyword) =>
		currentTask.includes(keyword.toLowerCase()),
	);
	const implementationWordMatches = lists.implementationWordRes
		.filter((re) => re.test(currentTask))
		.map(wordTerm);
	const implementation = implementationMatches.length > 0 || implementationWordMatches.length > 0;
	const multiStepMatches = lists.multiStep.filter((keyword) =>
		currentTask.includes(keyword.toLowerCase()),
	);
	// English planning/spec/design terms matched as whole words so `plan`
	// doesn't hit `planetary` and `spec` doesn't hit `specific`/`respect`.
	const multiStepWordMatches = lists.multiStepWordRes.filter((re) => re.test(currentTask));
	// Soft planning words (设计/方案/规划/规格, plan/design/spec) describe the
	// thinking about the task, not its scope: when the current task also asks
	// to build, they are instrumental ("设计并实现 X" = a build task with an
	// embedded design step) and must not escalate. Hard scope terms
	// (重构/迁移/架构/跨文件, refactor/migrate/rewrite…) and user-added
	// multi-step words always escalate.
	const hardMultiStepMatches = multiStepMatches.filter(
		(k) => !SOFT_MULTI_STEP_KEYWORDS[k.toLowerCase()],
	);
	const hardMultiStepWordMatches = multiStepWordMatches.filter(
		(re) => !SOFT_MULTI_STEP_WORD_TERMS[wordTerm(re)],
	);
	const allSoft = [
		...multiStepMatches.filter((k) => SOFT_MULTI_STEP_KEYWORDS[k.toLowerCase()]),
		...multiStepWordMatches.filter((re) => SOFT_MULTI_STEP_WORD_TERMS[wordTerm(re)]).map(wordTerm),
	];
	const softEscalates = !implementation && allSoft.length > 0;
	const demotedSoft = softEscalates ? [] : allSoft;
	const escalatedSoft = softEscalates ? allSoft : [];
	const multiStep =
		hardMultiStepMatches.length > 0 || hardMultiStepWordMatches.length > 0 || softEscalates;
	// Repair/debug phrasing demands reasoning over existing code; gate on the
	// keyword alone (these are inherently code-repair terms, intent-agnostic).
	const repairDebugMatches = lists.repairDebug.filter((keyword) =>
		lower.includes(keyword.toLowerCase()),
	);
	const repairDebug = repairDebugMatches.length > 0;
	const mechWordMatches = lists.mechanicalOpWordRes.filter((re) => re.test(lower));
	const mechPhraseMatches = lists.mechanicalOp.filter((keyword) =>
		lower.includes(keyword.toLowerCase()),
	);
	// Mechanical ops (commit/push/deploy/…) are execute-don't-design: pin them
	// to `simple`, but ONLY when nothing else demands reasoning — a push that
	// failed (repairDebug), a release bundled with a redesign (multiStep), or
	// a request quoting code/diffs must keep their higher tier.
	const mechanicalOp =
		(mechWordMatches.length > 0 || mechPhraseMatches.length > 0) &&
		!multiStep &&
		!repairDebug &&
		!implementation &&
		codeSignals.length === 0;
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
	if (implementation) {
		// Building a concrete thing: reasoning over requirements, but usually a
		// contained change → standard, not complex. Soft planning words demoted
		// because the current task asks to build are folded into the
		// reason so the decision log shows why they didn't escalate.
		const matches = [...implementationMatches, ...implementationWordMatches];
		weighted.push({
			tier: "standard",
			weight: 2,
			reason: `implementation (${matches.join(", ")}) → standard` +
				(demotedSoft.length > 0 ? `; planning words demoted: ${demotedSoft.join(", ")}` : ""),
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
		const effective = [
			...hardMultiStepMatches,
			...hardMultiStepWordMatches.map(wordTerm),
			...escalatedSoft,
		];		weighted.push({
			tier: "complex",
			weight: 5,
			reason: `multi-step (${effective.join(", ")}) → complex`,
		});
	}
	if (mechanicalOp) {
		// Weight 2: beats the bare code-intent standard signal (1.5) and the
		// short-context trivial signal (1), so "提交代码并推送" lands on simple
		// even though "代码" marks it as code intent.
		weighted.push({
			tier: "simple",
			weight: 2,
			reason: `mechanical op (${[...mechWordMatches, ...mechPhraseMatches].join(", ")}) → simple`,
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
	} else if (
		priorTier !== undefined &&
		TIER_ORDER.indexOf(priorTier) > TIER_ORDER.indexOf(tier) &&
		// Phase transition beats stickiness: a clean build request
		// (implementation phrasing, no multi-step/repair signals) after a
		// planning turn is a NEW phase, not the same task continuing — the
		// tier must flow complex → standard with the work. Ongoing
		// refactor/debug sessions keep their multi-step/repair signals, so
		// they stay sticky.
		!(implementation && !multiStep && !repairDebug)
	) {
		// ── sticky escalation: never downgrade within a session ──────────────
		tier = priorTier;
		stickyEscalation = true;
		confidence = Math.max(confidence, 0.8);
		reasons.push(`sticky escalation: keeping prior tier ${priorTier} (no downgrade)`);
	} else if (
		priorTier !== undefined &&
		TIER_ORDER.indexOf(priorTier) > TIER_ORDER.indexOf(tier)
	) {
		reasons.push(`phase transition: ${priorTier} → ${tier} (new build phase, sticky escalation skipped)`);
	}

	const signals: ComplexitySignals = {
		estimatedTokens,
		codeSignals,
		repairDebug,
		implementation,
		mixedPhase: implementation && allSoft.length > 0,
		multiStep,
		mechanicalOp,
		shortQa,
		stickyEscalation,
		hasImages,
	};
	return { tier, confidence, signals, reasons };
}
