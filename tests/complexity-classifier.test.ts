import { describe, expect, test } from "bun:test";

import {
	MULTI_STEP_KEYWORDS,
	classifyComplexity,
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
		conversationDepth: 0,
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
		expect(result.signals.stickyEscalation).toBe(false);
	});

	test("medium context reaches at least simple", () => {
		const result = classifyComplexity(input({ estimatedTokens: 10_000, intent: GENERAL_INTENT }));
		expect(result.tier).toBe("simple");
		expect(result.signals.shortQa).toBe(false);
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

	test("shortcut @fast overrides the code-intent escalation", () => {
		const result = classifyComplexity(
			input({ prompt: "实现一个冒泡排序", intent: CODE_INTENT, shortcut: shortcut("@fast") }),
		);
		expect(result.tier).toBe("simple");
	});

	test("long context reaches standard", () => {
		expect(classifyComplexity(input({ estimatedTokens: 50_000 })).tier).toBe("standard");
	});

	test("epic context reaches complex", () => {
		expect(classifyComplexity(input({ estimatedTokens: 150_000 })).tier).toBe("complex");
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

	test("shortcut pin beats sticky escalation and clears its signal", () => {
		const result = classifyComplexity(
			input({ priorTier: "complex", shortcut: shortcut("@fast") }),
		);
		expect(result.tier).toBe("simple");
		expect(result.signals.stickyEscalation).toBe(false);
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

describe("classifyComplexity — sticky escalation", () => {
	test("higher priorTier is kept, never downgraded", () => {
		const result = classifyComplexity(input({ priorTier: "complex", intent: GENERAL_INTENT }));
		expect(result.tier).toBe("complex");
		expect(result.signals.stickyEscalation).toBe(true);
		expect(result.reasons.join(" ")).toContain("sticky escalation");
		expect(result.confidence).toBeGreaterThanOrEqual(0.8);
	});

	test("lower priorTier does not hold the computed tier back", () => {
		const result = classifyComplexity(
			input({ priorTier: "simple", estimatedTokens: 150_000 }),
		);
		expect(result.tier).toBe("complex");
		expect(result.signals.stickyEscalation).toBe(false);
	});

	test("equal priorTier is not sticky", () => {
		const result = classifyComplexity(input({ priorTier: "standard", estimatedTokens: 50_000 }));
		expect(result.tier).toBe("standard");
		expect(result.signals.stickyEscalation).toBe(false);
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
