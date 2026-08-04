import { describe, expect, test } from "bun:test";

import {
	ANALYSIS_KEYWORDS,
	CODE_KEYWORDS,
	CREATIVE_KEYWORDS,
	classifyIntent,
	detectCodeSignals,
} from "../src/core/intent-classifier";

describe("classifyIntent — code", () => {
	test("code fence classifies as code", () => {
		const result = classifyIntent("why does this fail?\n```ts\nfoo(\n```");
		expect(result.intent).toBe("code");
	});

	test("file path classifies as code", () => {
		expect(classifyIntent("fix src/core/types.ts please").intent).toBe("code");
	});

	test("stack trace classifies as code", () => {
		const prompt = "I get this:\n    at main (app.ts:12:5)";
		expect(classifyIntent(prompt).intent).toBe("code");
	});

	test("diff classifies as code", () => {
		const prompt = "is this right?\n@@ -1,2 +1,3 @@\n-old\n+new";
		expect(classifyIntent(prompt).intent).toBe("code");
	});

	test("code keywords classify as code", () => {
		expect(classifyIntent("there is a bug in my function, help me debug").intent).toBe("code");
		expect(classifyIntent("这段代码报错了，帮我调试一下").intent).toBe("code");
	});

	test("hasCodeContext nudges an otherwise signal-free prompt to code", () => {
		const without = classifyIntent("what does this do exactly?");
		expect(without.intent).not.toBe("code");
		const withContext = classifyIntent("what does this do exactly?", { hasCodeContext: true });
		expect(withContext.intent).toBe("code");
	});
});

describe("classifyIntent — creative", () => {
	test("poem request classifies as creative", () => {
		expect(classifyIntent("Write a poem about autumn leaves").intent).toBe("creative");
	});

	test("Chinese poem request classifies as creative", () => {
		expect(classifyIntent("帮我写一首关于秋天的诗").intent).toBe("creative");
	});

	test("blog/story requests classify as creative", () => {
		expect(classifyIntent("write a blog post about my travels").intent).toBe("creative");
		expect(classifyIntent("给我讲一个睡前故事").intent).toBe("creative");
	});
});

describe("classifyIntent — analysis", () => {
	test("analyze/compare phrasing classifies as analysis", () => {
		expect(classifyIntent("Analyze the pros and cons of microservices").intent).toBe("analysis");
		expect(classifyIntent("compare these two approaches").intent).toBe("analysis");
	});

	test("Chinese summarize phrasing classifies as analysis", () => {
		expect(classifyIntent("帮我总结一下这篇文章的要点").intent).toBe("analysis");
	});
});

describe("classifyIntent — general", () => {
	test("short prompt with no signals classifies as general with high confidence", () => {
		const result = classifyIntent("hi");
		expect(result.intent).toBe("general");
		expect(result.confidence).toBe(0.9);
	});

	test("long prompt with no signals is general with lower confidence", () => {
		const prompt =
			"tell me something interesting about the history of the city you know well and like";
		const result = classifyIntent(prompt);
		expect(result.intent).toBe("general");
		expect(result.confidence).toBe(0.6);
	});
});

describe("classifyIntent — confidence", () => {
	test("uncontested signals give high confidence, capped at 0.95", () => {
		const result = classifyIntent("write a poem");
		expect(result.intent).toBe("creative");
		expect(result.confidence).toBeGreaterThan(0.9);
		expect(result.confidence).toBeLessThanOrEqual(0.95);
	});

	test("contested signals lower confidence below 1", () => {
		// structural code signal (weight 2) vs one analysis keyword (weight 1)
		const result = classifyIntent("summarize this:\n```\nsome code\n```");
		expect(result.intent).toBe("code");
		expect(result.confidence).toBeLessThan(0.95);
		expect(result.confidence).toBeGreaterThanOrEqual(0.5);
	});
});

describe("detectCodeSignals", () => {
	test("detects each structural signal", () => {
		expect(detectCodeSignals("```py\nx\n```")).toContain("code-fence");
		expect(detectCodeSignals("open src/a.ts")).toContain("file-path");
		expect(detectCodeSignals("compare src/a.ts and lib/b.py")).toContain("multi-file");
		expect(detectCodeSignals("@@ -1 +1 @@\n-x\n+y")).toContain("diff");
		expect(detectCodeSignals("at f (a.ts:1:2)")).toContain("stack-trace");
	});

	test("no signals in plain prose", () => {
		expect(detectCodeSignals("just a normal question about the weather")).toEqual([]);
	});
});

describe("exported keyword tables", () => {
	test("tables are non-empty for tuning", () => {
		expect(CODE_KEYWORDS.length).toBeGreaterThan(0);
		expect(CREATIVE_KEYWORDS.length).toBeGreaterThan(0);
		expect(ANALYSIS_KEYWORDS.length).toBeGreaterThan(0);
	});
});
