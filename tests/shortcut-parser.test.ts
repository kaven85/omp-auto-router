import { describe, expect, test } from "bun:test";

import { parseShortcut } from "../src/core/shortcut-parser";

describe("parseShortcut — no shortcut", () => {
	test("plain prompt passes through unchanged", () => {
		const result = parseShortcut("hello world");
		expect(result.cleanPrompt).toBe("hello world");
		expect(result.token).toBeUndefined();
		expect(result.profileOverride).toBeUndefined();
		expect(result.requirement).toEqual({});
	});

	test("unknown @token passes through untouched", () => {
		const result = parseShortcut("@smol hi there");
		expect(result.cleanPrompt).toBe("@smol hi there");
		expect(result.token).toBeUndefined();
		expect(result.profileOverride).toBeUndefined();
		expect(result.requirement).toEqual({});
	});

	test("token-like prefix without boundary passes through untouched", () => {
		for (const prompt of ["@reasoningfoo hi", "@longer text", "@profile: x"]) {
			const result = parseShortcut(prompt);
			expect(result.cleanPrompt).toBe(prompt);
			expect(result.token).toBeUndefined();
			expect(result.profileOverride).toBeUndefined();
		}
	});
});

describe("parseShortcut — capability tokens", () => {
	test("@reasoning requires reasoning", () => {
		const result = parseShortcut("@reasoning prove the lemma");
		expect(result.token).toBe("@reasoning");
		expect(result.cleanPrompt).toBe("prove the lemma");
		expect(result.requirement).toEqual({ reasoning: true });
	});

	test("@swe requires reasoning", () => {
		const result = parseShortcut("@swe fix the failing test");
		expect(result.token).toBe("@swe");
		expect(result.cleanPrompt).toBe("fix the failing test");
		expect(result.requirement).toEqual({ reasoning: true });
	});

	test("@long requires a 100k context window", () => {
		const result = parseShortcut("@long summarize this repo");
		expect(result.token).toBe("@long");
		expect(result.cleanPrompt).toBe("summarize this repo");
		expect(result.requirement).toEqual({ minContextWindow: 100_000 });
	});

	test("@vision requires vision", () => {
		const result = parseShortcut("@vision what is in this screenshot");
		expect(result.token).toBe("@vision");
		expect(result.cleanPrompt).toBe("what is in this screenshot");
		expect(result.requirement).toEqual({ vision: true });
	});

	test("@fast is a hint only with an empty requirement", () => {
		const result = parseShortcut("@fast quick question");
		expect(result.token).toBe("@fast");
		expect(result.cleanPrompt).toBe("quick question");
		expect(result.requirement).toEqual({});
	});

	test("leading whitespace before the token is stripped", () => {
		const result = parseShortcut("   @fast   hello  world");
		expect(result.token).toBe("@fast");
		expect(result.cleanPrompt).toBe("hello  world");
	});

	test("token-only prompt yields an empty cleanPrompt", () => {
		const result = parseShortcut("@fast");
		expect(result.token).toBe("@fast");
		expect(result.cleanPrompt).toBe("");
	});
});

describe("parseShortcut — @profile", () => {
	test("@profile:<name> alone", () => {
		const result = parseShortcut("@profile:economy do the thing");
		expect(result.profileOverride).toBe("economy");
		expect(result.token).toBeUndefined();
		expect(result.cleanPrompt).toBe("do the thing");
		expect(result.requirement).toEqual({});
	});

	test("profile names allow letters, digits, dashes and underscores", () => {
		const result = parseShortcut("@profile:My-Profile_2 go");
		expect(result.profileOverride).toBe("My-Profile_2");
		expect(result.cleanPrompt).toBe("go");
	});

	test("profile then capability token", () => {
		const result = parseShortcut("@profile:economy @reasoning think hard");
		expect(result.profileOverride).toBe("economy");
		expect(result.token).toBe("@reasoning");
		expect(result.cleanPrompt).toBe("think hard");
		expect(result.requirement).toEqual({ reasoning: true });
	});

	test("capability token then profile (reverse order)", () => {
		const result = parseShortcut("@fast @profile:premium be quick");
		expect(result.profileOverride).toBe("premium");
		expect(result.token).toBe("@fast");
		expect(result.cleanPrompt).toBe("be quick");
		expect(result.requirement).toEqual({});
	});

	test("two capability tokens: only the first is consumed", () => {
		const result = parseShortcut("@fast @swe work");
		expect(result.token).toBe("@fast");
		expect(result.cleanPrompt).toBe("@swe work");
	});

	test("two profiles: only the first is consumed", () => {
		const result = parseShortcut("@profile:a @profile:b work");
		expect(result.profileOverride).toBe("a");
		expect(result.cleanPrompt).toBe("@profile:b work");
	});

	test("shortcut after plain text is not parsed", () => {
		const result = parseShortcut("please @fast do it");
		expect(result.cleanPrompt).toBe("please @fast do it");
		expect(result.token).toBeUndefined();
	});
});
