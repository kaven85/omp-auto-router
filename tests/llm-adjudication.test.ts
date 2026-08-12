import { describe, expect, test } from "bun:test";

import { buildAdjudicationPrompt, parseAdjudicationResponse } from "../src/core/llm-adjudication";

describe("llm-adjudication — prompt", () => {
	test("prompt asks for one tier word and embeds the request", () => {
		const prompt = buildAdjudicationPrompt("帮我设计并实现一个登录功能");
		expect(prompt).toContain("ONE word only");
		expect(prompt).toContain("standard");
		expect(prompt).toContain("complex");
		expect(prompt).toContain("帮我设计并实现一个登录功能");
		// Phase rule must be spelled out — this is the ambiguity being resolved.
		expect(prompt).toContain("FIRST phase");
	});
});

describe("llm-adjudication — response parsing", () => {
	test("bare tier words parse case-insensitively", () => {
		expect(parseAdjudicationResponse("standard")).toBe("standard");
		expect(parseAdjudicationResponse("Complex")).toBe("complex");
		expect(parseAdjudicationResponse("  simple\n")).toBe("simple");
	});

	test("tier word embedded in a sentence parses", () => {
		expect(parseAdjudicationResponse("standard.")).toBe("standard");
		expect(parseAdjudicationResponse("The tier is: complex")).toBe("complex");
	});

	test("no tier word → undefined (caller keeps heuristic)", () => {
		expect(parseAdjudicationResponse("")).toBeUndefined();
		expect(parseAdjudicationResponse("I cannot classify this")).toBeUndefined();
		expect(parseAdjudicationResponse("medium")).toBeUndefined();
	});

	test("substring inside a longer word does not parse", () => {
		expect(parseAdjudicationResponse("simplistic")).toBeUndefined();
		expect(parseAdjudicationResponse("complexity")).toBeUndefined();
	});
});
