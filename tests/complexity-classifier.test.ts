import { describe, expect, test } from "bun:test";

import {
	MULTI_STEP_KEYWORDS,
	classifyComplexity,
	resolveClassifierLists,
	sanitizeClassifierOverrides,
	type ClassifyComplexityInput,
} from "../src/core/complexity-classifier";
import type { IntentResult, ShortcutResult } from "../src/core/types";

const GENERAL_INTENT: IntentResult = { intent: "general", confidence: 0.9 };
const CODE_INTENT: IntentResult = { intent: "code", confidence: 0.9 };

function input(overrides: Partial<ClassifyComplexityInput>): ClassifyComplexityInput {
	return {
		prompt: "hello",
		estimatedTokens: 10,
		hasImages: false,
		...overrides,
	};
}

function shortcut(token: ShortcutResult["token"]): ShortcutResult {
	return { cleanPrompt: "hello", requirement: {}, ...(token === undefined ? {} : { token }) };
}

describe("classifyComplexity — base tiers", () => {
	test("short general Q&A is trivial", () => {
		const result = classifyComplexity(input({ intent: GENERAL_INTENT }));
		expect(result.tier).toBe("trivial");
		expect(result.signals.shortQa).toBe(true);
		expect(result.signals.estimatedTokens).toBe(10);
		expect(result.signals.codeSignals).toEqual([]);
	});

	test("short general Q&A stays trivial even at medium context", () => {
		// A short prompt is classified by the prompt alone: context length
		// picks the model's window (capability), not its reasoning tier.
		const result = classifyComplexity(input({ estimatedTokens: 10_000, intent: GENERAL_INTENT }));
		expect(result.tier).toBe("trivial");
		expect(result.signals.shortQa).toBe(true);
		expect(result.reasons.join(" ")).toContain("suppressed");
	});

	test("image input reaches at least simple", () => {
		const result = classifyComplexity(input({ hasImages: true, intent: GENERAL_INTENT }));
		expect(result.tier).toBe("simple");
		expect(result.signals.hasImages).toBe(true);
		expect(result.signals.shortQa).toBe(false); // images suppress the short-Q&A signal
	});

	test("code fence reaches standard and fills codeSignals", () => {
		const result = classifyComplexity(
			input({ prompt: "fix this:\n```ts\nbroken()\n```", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.codeSignals).toContain("code-fence");
		expect(result.reasons.join(" ")).toContain("code-fence");
	});

	test("multi-file paths reach standard", () => {
		const result = classifyComplexity(
			input({ prompt: "merge src/a.ts into lib/b.py", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.codeSignals).toContain("multi-file");
	});

	test("diff and stack trace reach standard", () => {
		expect(
			classifyComplexity(input({ prompt: "@@ -1 +1 @@\n-x\n+y", intent: CODE_INTENT })).tier,
		).toBe("standard");
		expect(
			classifyComplexity(input({ prompt: "at f (a.ts:1:2)", intent: CODE_INTENT })).tier,
		).toBe("standard");
	});

	test("repair/debug phrasing without structural code signals reaches standard", () => {
		// "这个函数为什么报错了，帮我分析并修复" carries no code fence/path/diff,
		// but is a repair task — must not stay at trivial (needs reasoning).
		const result = classifyComplexity(
			input({ prompt: "这个函数为什么报错了，帮我分析一下并修复", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.repairDebug).toBe(true);
		expect(result.signals.codeSignals).toEqual([]);
		expect(result.reasons.join(" ")).toContain("repair/debug");
	});

	test("English repair/debug phrasing reaches standard", () => {
		const result = classifyComplexity(
			input({ prompt: "why does this function crash, debug and fix it", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.repairDebug).toBe(true);
	});

	test("plain trivial ask is not captured as repair/debug", () => {
		const result = classifyComplexity(
			input({ prompt: "把标题改成红色", intent: GENERAL_INTENT }),
		);
		expect(result.tier).toBe("trivial");
		expect(result.signals.repairDebug).toBe(false);
	});

	test("code intent without structural signals reaches standard", () => {
		// A short "implement X" request is a code task → reasons about the
		// request, so it must not sit in the no-thinking trivial bucket.
		const result = classifyComplexity(
			input({ prompt: "实现一个冒泡排序", estimatedTokens: 10, intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.reasons.join(" ")).toContain("code intent → standard");
	});

	test("analysis intent reaches standard", () => {
		const result = classifyComplexity(
			input({ prompt: "请分析这份报表的利润率走势", intent: { intent: "analysis", confidence: 0.9 } }),
		);
		expect(result.tier).toBe("standard");
	});

	test("mechanical dev ops land on simple despite code intent", () => {
		// "提交代码并推送" — "代码" marks code intent (→ standard 1.5), but a
		// commit+push is execute-don't-design: mechanical signal (simple 2)
		// must win.
		for (const prompt of ["提交代码并推送", "提交代码", "推送代码到远端", "commit and push the changes"]) {
			const result = classifyComplexity(input({ prompt, intent: CODE_INTENT }));
			expect(result.tier).toBe("simple");
			expect(result.signals.mechanicalOp).toBe(true);
			expect(result.reasons.join(" ")).toContain("mechanical op");
		}
	});

	test("mechanical op with repair phrasing keeps standard", () => {
		// A failed push needs diagnosis, not blind re-execution.
		const result = classifyComplexity(
			input({ prompt: "git push 报错了，帮我看看", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.mechanicalOp).toBe(false);
	});

	test("mechanical op bundled with multi-step phrasing keeps complex", () => {
		const result = classifyComplexity(
			input({ prompt: "重构这个模块然后 commit", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.mechanicalOp).toBe(false);
	});

	test("mechanical op quoting code keeps standard", () => {
		const result = classifyComplexity(
			input({ prompt: "commit this fix:\n```ts\nf()\n```", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.mechanicalOp).toBe(false);
	});

	test("merge across file paths still reaches standard via tie-break", () => {
		// "merge" is a mechanical word, but the multi-file structural signal
		// also fires (standard 2 vs simple 2 → tie resolves upward).
		const result = classifyComplexity(
			input({ prompt: "merge src/a.ts into lib/b.py", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
	});

	test("general multi-step phrasing reaches complex; domain jargon alone does not", () => {
		// General planning vocabulary still fires regardless of domain.
		for (const prompt of [
			"帮我设计一个量化策略并回测",
			"run a backtest on the momentum strategy",
		]) {
			const result = classifyComplexity(input({ prompt, intent: CODE_INTENT }));
			expect(result.tier).toBe("complex");
			expect(result.signals.multiStep).toBe(true);
		}
		// Domain-specific jargon carries no builtin weight — user vocabulary
		// belongs in `/auto-router rules add` overrides, not the core lists.
		const jargon = classifyComplexity(input({ prompt: "对这个行业做全市场筛选", intent: CODE_INTENT }));
		expect(jargon.signals.multiStep).toBe(false);
	});

	test("shortcut @fast overrides the code-intent escalation", () => {
		const result = classifyComplexity(
			input({ prompt: "实现一个冒泡排序", intent: CODE_INTENT, shortcut: shortcut("@fast") }),
		);
		expect(result.tier).toBe("simple");
	});

	test("long context reaches standard", () => {
		expect(classifyComplexity(input({ estimatedTokens: 50_000 })).tier).toBe("standard");
	});

	test("epic context caps at standard, not complex", () => {
		// A big context needs a big window, not a harder task — multi-step
		// phrasing (weight 5) is the only path to complex.
		expect(classifyComplexity(input({ estimatedTokens: 150_000 })).tier).toBe("standard");
	});

	test("short general Q&A at epic context stays trivial", () => {
		// Regression: "你是谁" at 150k session context used to hit complex
		// (epic context weight 3) and route to the top model. A trivial
		// prompt stays trivial; the window fit is enforced by the pipeline's
		// minContextWindow requirement instead.
		const result = classifyComplexity(input({ estimatedTokens: 150_000, intent: GENERAL_INTENT }));
		expect(result.tier).toBe("trivial");
		expect(result.signals.shortQa).toBe(true);
		expect(result.signals.multiStep).toBe(false);
		expect(result.reasons.join(" ")).toContain("suppressed");
	});

	test("English multi-step keywords reach complex", () => {
		const result = classifyComplexity(
			input({ prompt: "Please refactor and redesign this module", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.multiStep).toBe(true);
		expect(result.reasons.join(" ")).toContain("multi-step");
	});

	test("Chinese multi-step keywords reach complex", () => {
		const result = classifyComplexity(
			input({ prompt: "帮我重构这个跨文件的架构", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.multiStep).toBe(true);
	});

	test("English planning/spec/design word terms reach complex", () => {
		for (const prompt of [
			"write a migration plan for the order service",
			"please spec the checkout API before coding",
			"produce the design doc for the event bus",
			"plan the rollout across 3 regions",
		]) {
			const result = classifyComplexity(input({ prompt, intent: CODE_INTENT }));
			expect(result.tier, prompt).toBe("complex");
			expect(result.signals.multiStep).toBe(true);
		}
	});

	test("architecture-level word terms reach complex", () => {
		const r = classifyComplexity(
			input({ prompt: "share the roadmap and a modularize strategy for the monolith", intent: CODE_INTENT }),
		);
		expect(r.tier).toBe("complex");
	});

	test("plan/spec/design do NOT false-positive on unrelated words", () => {
		for (const prompt of ["explain planetary rotation", "be more specific", "respect the naming", "the spectrum of options"]) {
			const result = classifyComplexity(input({ prompt, intent: GENERAL_INTENT }));
			expect(result.signals.multiStep, prompt).toBe(false);
			expect(result.tier, prompt).not.toBe("complex");
		}
	});

	test("Chinese planning/spec terms reach complex", () => {
		for (const prompt of [
			"帮我写一份订单拆分的技术方案",
			"输出支付模块的接口设计规格",
			"给出这个服务的演进路线图和拆解计划",
		]) {
			const result = classifyComplexity(input({ prompt, intent: CODE_INTENT }));
			expect(result.tier, prompt).toBe("complex");
			expect(result.signals.multiStep).toBe(true);
		}
	});
});

describe("classifyComplexity — implementation phrasing", () => {
	test("bare implementation phrasing reaches standard", () => {
		const result = classifyComplexity(
			input({ prompt: "帮我实现一个登录功能", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.implementation).toBe(true);
		expect(result.signals.multiStep).toBe(false);
		expect(result.reasons.join(" ")).toContain("implementation");
	});

	test("implementation in the current phase demotes soft planning words", () => {
		// Implementation is the work NOW (build-on-existing-plan, or the first
		// phase is the build) → standard. Follow-up phases after 并/然后/再/
		// and/then don't count — they get their own turn later.
		for (const prompt of [
			"实现这个方案里的支付逻辑",
			"按设计方案实现支付逻辑",
			"implement the retry logic per spec",
			"实现支付逻辑，然后设计对账方案",
			"build the endpoint, then design the retry strategy",
		]) {
			const result = classifyComplexity(input({ prompt, intent: CODE_INTENT }));
			expect(result.tier, prompt).toBe("standard");
			expect(result.signals.implementation, prompt).toBe(true);
			expect(result.signals.multiStep, prompt).toBe(false);
		}
	});

	test("planning in the current phase reaches complex", () => {
		// The current ask IS the design work → complex, even when a follow-up
		// build phase is mentioned (complex → standard across turns).
		for (const prompt of [
			"输出订单模块的设计方案",
			"帮我设计并实现一个登录功能",
			"先设计方案，再开发落地",
			"design and implement the checkout flow",
			"plan the rollout, then build it",
		]) {
			const result = classifyComplexity(input({ prompt, intent: CODE_INTENT }));
			expect(result.tier, prompt).toBe("complex");
			expect(result.signals.multiStep, prompt).toBe(true);
		}
	});

	test("background-only opening phase does not mask the task phase", () => {
		// Context-first prompts open with a phase that carries no task
		// phrasing at all ("我们有一个运行了 8 年的单体应用。"). The phase
		// split must skip it: the task phase behind it drives the tier.
		// Regression: the background sentence used to win the split and pin
		// an architecture-migration ask to standard.
		const result = classifyComplexity(
			input({
				prompt:
					"我们有一个运行了 8 年的单体 Java 应用（订单 + 库存 + 支付耦合在一个 WAR 里，共享一张 MySQL）。\n" +
					"请设计并落地一次架构迁移：把单体按领域拆成三个微服务，给出数据迁移与回滚策略。",
				intent: CODE_INTENT,
			}),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.multiStep).toBe(true);
	});

	test("hard scope words only count in the current task", () => {
		// Follow-up refactor is a later turn's problem.
		const future = classifyComplexity(
			input({ prompt: "实现支付逻辑，然后重构整个架构", intent: CODE_INTENT }),
		);
		expect(future.tier).toBe("standard");
		// Same words in the current task → complex.
		const current = classifyComplexity(
			input({ prompt: "重构支付模块的架构并实现新逻辑", intent: CODE_INTENT }),
		);
		expect(current.tier).toBe("complex");
	});

	test("implementation + hard scope words still reaches complex", () => {
		for (const prompt of [
			"设计并实现一套跨文件的重构",
			"implement the migration plan for the schema",
			"实现新架构并落地",
		]) {
			const result = classifyComplexity(input({ prompt, intent: CODE_INTENT }));
			expect(result.tier, prompt).toBe("complex");
			expect(result.signals.multiStep, prompt).toBe(true);
		}
	});

	test("planning-only phrasing without implementation still reaches complex", () => {
		// No implementation keyword → soft words keep their complex push.
		const result = classifyComplexity(
			input({ prompt: "输出订单模块的设计方案", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.implementation).toBe(false);
		expect(result.signals.multiStep).toBe(true);
	});

	test("removing the implementation keyword restores complex for soft words", () => {
		const result = classifyComplexity(
			input({
				prompt: "实现这个方案里的支付逻辑",
				intent: CODE_INTENT,
				overrides: { remove: { implementation: ["实现"] } },
			}),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.multiStep).toBe(true);
	});

	test("mixed-phase prompts set the mixedPhase signal", () => {
		// Both signals inside the CURRENT phase → semantically ambiguous,
		// eligible for LLM adjudication.
		const mixed = classifyComplexity(
			input({ prompt: "按设计方案实现支付逻辑", intent: CODE_INTENT }),
		);
		expect(mixed.signals.mixedPhase).toBe(true);
		// Phase-split prompts are NOT mixed: "设计并实现" is a design phase
		// now, the implementation belongs to a later phase.
		const splitPhases = classifyComplexity(
			input({ prompt: "帮我设计并实现一个登录功能", intent: CODE_INTENT }),
		);
		expect(splitPhases.signals.mixedPhase).toBe(false);
		const pureImpl = classifyComplexity(
			input({ prompt: "帮我实现一个登录功能", intent: CODE_INTENT }),
		);
		expect(pureImpl.signals.mixedPhase).toBe(false);
		const purePlan = classifyComplexity(
			input({ prompt: "输出订单模块的设计方案", intent: CODE_INTENT }),
		);
		expect(purePlan.signals.mixedPhase).toBe(false);
	});

	test("added implementation word term demotes same-clause soft planning words", () => {
		const result = classifyComplexity(
			input({
				prompt: "please ship the design for the widget",
				intent: CODE_INTENT,
				overrides: { add: { implementationWord: ["ship"] } },
			}),
		);
		expect(result.tier).toBe("standard");
		expect(result.signals.implementation).toBe(true);
	});
});

describe("classifyComplexity — shortcut override", () => {
	test("@fast pins simple even for epic context", () => {
		const result = classifyComplexity(
			input({ estimatedTokens: 150_000, shortcut: shortcut("@fast") }),
		);
		expect(result.tier).toBe("simple");
		expect(result.confidence).toBe(1);
	});

	test("@swe pins standard", () => {
		const result = classifyComplexity(input({ shortcut: shortcut("@swe") }));
		expect(result.tier).toBe("standard");
		expect(result.confidence).toBe(1);
	});

	test("@reasoning pins complex", () => {
		const result = classifyComplexity(input({ shortcut: shortcut("@reasoning") }));
		expect(result.tier).toBe("complex");
		expect(result.confidence).toBe(1);
	});

	test("shortcut pin remains authoritative", () => {
		const result = classifyComplexity(
			input({ shortcut: shortcut("@fast") }),
		);
		expect(result.tier).toBe("simple");
	});

	test("@vision and @long do not pin a tier", () => {
		expect(
			classifyComplexity(input({ intent: GENERAL_INTENT, shortcut: shortcut("@vision") })).tier,
		).toBe("trivial");
		expect(
			classifyComplexity(input({ intent: GENERAL_INTENT, shortcut: shortcut("@long") })).tier,
		).toBe("trivial");
	});
});

describe("classifyComplexity — per-request adjustment", () => {
	test("lower current complexity selects trivial", () => {
		const result = classifyComplexity(input({ intent: GENERAL_INTENT }));
		expect(result.tier).toBe("trivial");
	});

	test("higher current complexity selects complex", () => {
		const result = classifyComplexity(
			input({ prompt: "refactor and migrate the entire service across modules" }),
		);
		expect(result.tier).toBe("complex");
	});

	test("clean build request is classified from its own signals", () => {
		const result = classifyComplexity(
			input({ prompt: "开始实现登录功能", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
	});

	test("repair/debug request is classified at standard", () => {
		const result = classifyComplexity(
			input({ prompt: "继续排查并修复这个报错", intent: CODE_INTENT }),
		);
		expect(result.tier).toBe("standard");
	});
});

describe("classifyComplexity — confidence and reasons", () => {
	test("agreeing signals give high confidence below 1", () => {
		const result = classifyComplexity(input({ intent: GENERAL_INTENT }));
		expect(result.confidence).toBeGreaterThan(0.9);
		expect(result.confidence).toBeLessThan(1);
	});

	test("conflicting signals lower confidence", () => {
		// medium context (simple) vs code fence (standard)
		const result = classifyComplexity(
			input({
				prompt: "check this:\n```\nx\n```",
				estimatedTokens: 10_000,
				intent: CODE_INTENT,
			}),
		);
		expect(result.tier).toBe("standard");
		expect(result.confidence).toBeLessThan(0.9);
		expect(result.confidence).toBeGreaterThanOrEqual(0.3);
	});

	test("reasons are human-readable and name the winning signals", () => {
		const result = classifyComplexity(
			input({ prompt: "merge src/a.ts into lib/b.py", intent: CODE_INTENT }),
		);
		expect(result.reasons.length).toBeGreaterThan(0);
		expect(result.reasons.join(" ")).toContain("multi-file");
		expect(result.reasons.join(" ")).toContain("→ standard");
	});

	test("multi-step keyword table is exported and bilingual", () => {
		expect(MULTI_STEP_KEYWORDS).toContain("refactor");
		expect(MULTI_STEP_KEYWORDS).toContain("重构");
	});
});

describe("classifyComplexity — user rule overrides", () => {
	test("added multiStep keyword escalates to complex", () => {
		const base = classifyComplexity(input({ prompt: "帮我造个轮子", intent: GENERAL_INTENT, estimatedTokens: 500 }));
		expect(base.signals.multiStep).toBe(false);
		const result = classifyComplexity(
			input({
				prompt: "帮我造个轮子",
				intent: GENERAL_INTENT,
				estimatedTokens: 500,
				overrides: { add: { multiStep: ["造个轮子"] } },
			}),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.multiStep).toBe(true);
	});

	test("added whole-word term matches with word boundaries", () => {
		const result = classifyComplexity(
			input({
				prompt: "please orchestrate the rollout",
				intent: GENERAL_INTENT,
				estimatedTokens: 500,
				overrides: { add: { multiStepWord: ["orchestrate"] } },
			}),
		);
		expect(result.tier).toBe("complex");
		// Substring of a longer word must NOT hit the whole-word term.
		const partial = classifyComplexity(
			input({
				prompt: "the orchestrated rollout",
				intent: GENERAL_INTENT,
				estimatedTokens: 500,
				overrides: { add: { multiStepWord: ["orchestra"] } },
			}),
		);
		expect(partial.signals.multiStep).toBe(false);
	});

	test("removed builtin keyword stops matching", () => {
		const result = classifyComplexity(
			input({
				prompt: "refactor this",
				intent: CODE_INTENT,
				estimatedTokens: 500,
				overrides: { remove: { multiStep: ["refactor"] } },
			}),
		);
		expect(result.signals.multiStep).toBe(false);
		expect(result.tier).not.toBe("complex");
	});

	test("added mechanicalOp phrase pins mechanical tasks to simple", () => {
		const result = classifyComplexity(
			input({
				prompt: "帮我同步数据",
				intent: CODE_INTENT,
				estimatedTokens: 500,
				overrides: { add: { mechanicalOp: ["同步数据"] } },
			}),
		);
		expect(result.signals.mechanicalOp).toBe(true);
		expect(result.tier).toBe("simple");
	});

	test("empty overrides are identical to the builtin baseline", () => {
		const prompt = "refactor the auth module across files";
		const base = classifyComplexity(input({ prompt, intent: CODE_INTENT, estimatedTokens: 500 }));
		const empty = classifyComplexity(
			input({ prompt, intent: CODE_INTENT, estimatedTokens: 500, overrides: {} }),
		);
		const emptyArrays = classifyComplexity(
			input({ prompt, intent: CODE_INTENT, estimatedTokens: 500, overrides: { add: { multiStep: [] }, remove: {} } }),
		);
		expect(empty).toEqual(base);
		expect(emptyArrays).toEqual(base);
	});

	test("resolveClassifierLists shares base constants when overrides are empty", () => {
		expect(resolveClassifierLists(undefined).multiStep).toBe(MULTI_STEP_KEYWORDS);
		expect(resolveClassifierLists({}).multiStep).toBe(MULTI_STEP_KEYWORDS);
		expect(resolveClassifierLists({ add: { multiStep: [] } }).multiStep).toBe(MULTI_STEP_KEYWORDS);
		const merged = resolveClassifierLists({ add: { multiStep: ["造轮子"] } });
		expect(merged.multiStep).not.toBe(MULTI_STEP_KEYWORDS);
		expect(merged.multiStep).toContain("造轮子");
		expect(merged.multiStep.length).toBe(MULTI_STEP_KEYWORDS.length + 1);
	});

	test("override keywords with regex metacharacters are treated literally, never throw", () => {
		const overrides = { add: { multiStepWord: ["C++", "(a+)+", "design["] } };
		expect(() => resolveClassifierLists(overrides)).not.toThrow();
		expect(() =>
			classifyComplexity(
				input({ prompt: "refactor the C++ parser (a+)+ design[ module", intent: CODE_INTENT, estimatedTokens: 500, overrides }),
			),
		).not.toThrow();
		// Metachar terms are literal: `(a+)+` never compiles to a backtracking
		// regex, so a long `aaaa…` run is safe, and `C++` doesn't match `C`.
		const lists = resolveClassifierLists(overrides);
		const wordRes = lists.multiStepWordRes;
		expect(wordRes.some((re) => re.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(false);
		expect(wordRes.some((re) => re.test("rewrite the c module"))).toBe(false);
		// A plain added word still matches after escaping.
		const merged = resolveClassifierLists({ add: { multiStepWord: ["orchestrate"] } });
		expect(merged.multiStepWordRes.some((re) => re.test("orchestrate the rollout"))).toBe(true);
	});
});

describe("sanitizeClassifierOverrides", () => {
	test("drops garbage shapes, keeps valid add/remove string lists", () => {
		const clean = sanitizeClassifierOverrides({
			add: { multiStep: ["ok", 42, null], bogus: ["x"], multiStepWord: "nope" },
			remove: "not-an-object",
			extra: 1,
		});
		expect(clean).toEqual({ add: { multiStep: ["ok"] } });
	});

	test("non-object input degrades to empty overrides", () => {
		expect(sanitizeClassifierOverrides(undefined)).toEqual({});
		expect(sanitizeClassifierOverrides(null)).toEqual({});
		expect(sanitizeClassifierOverrides("junk")).toEqual({});
		expect(sanitizeClassifierOverrides([1, 2])).toEqual({});
		expect(sanitizeClassifierOverrides({ add: { multiStep: [] } })).toEqual({});
	});

	test("valid overrides pass through unchanged", () => {
		const raw = { add: { multiStep: ["造轮子"] }, remove: { repairDebug: ["fix"] } };
		expect(sanitizeClassifierOverrides(raw)).toEqual(raw);
	});
});
