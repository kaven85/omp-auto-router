import { describe, expect, test } from "bun:test";

import {
	CHARS_PER_TOKEN,
	CONTEXT_SIZE_BOUNDARIES,
	classifyContextSize,
	estimateTokens,
} from "../src/core/context-analyzer";

describe("estimateTokens", () => {
	test("empty text estimates to 0", () => {
		expect(estimateTokens("")).toBe(0);
	});

	test("estimates chars/4 rounded up", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
		expect(estimateTokens("a".repeat(100))).toBe(25);
		expect(estimateTokens("a".repeat(101))).toBe(26);
	});

	test("matches the documented chars-per-token constant", () => {
		const text = "x".repeat(CHARS_PER_TOKEN * 10 + 1);
		expect(estimateTokens(text)).toBe(11);
	});
});

describe("classifyContextSize", () => {
	test("short below 4k", () => {
		expect(classifyContextSize(0)).toBe("short");
		expect(classifyContextSize(CONTEXT_SIZE_BOUNDARIES.short - 1)).toBe("short");
	});

	test("medium from 4k up to 32k", () => {
		expect(classifyContextSize(CONTEXT_SIZE_BOUNDARIES.short)).toBe("medium");
		expect(classifyContextSize(CONTEXT_SIZE_BOUNDARIES.medium - 1)).toBe("medium");
	});

	test("long from 32k up to 100k", () => {
		expect(classifyContextSize(CONTEXT_SIZE_BOUNDARIES.medium)).toBe("long");
		expect(classifyContextSize(CONTEXT_SIZE_BOUNDARIES.long - 1)).toBe("long");
	});

	test("epic at and above 100k", () => {
		expect(classifyContextSize(CONTEXT_SIZE_BOUNDARIES.long)).toBe("epic");
		expect(classifyContextSize(250_000)).toBe("epic");
	});
});
