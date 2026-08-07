import { describe, expect, test } from "bun:test";

import { clampThinking } from "../src/core/thinking-cap";
import type { ThinkingCap } from "../src/core/types";

describe("clampThinking", () => {
	test("undefined cap leaves the level unchanged", () => {
		expect(clampThinking("low", undefined)).toBe("low");
		expect(clampThinking("max", undefined)).toBe("max");
	});

	test("clamps below the minimum up to the minimum", () => {
		const cap: ThinkingCap = { min: "high" };
		expect(clampThinking("off", cap)).toBe("high");
		expect(clampThinking("low", cap)).toBe("high");
		expect(clampThinking("medium", cap)).toBe("high");
	});

	test("clamps above the maximum down to the maximum", () => {
		const cap: ThinkingCap = { max: "medium" };
		expect(clampThinking("high", cap)).toBe("medium");
		expect(clampThinking("xhigh", cap)).toBe("medium");
		expect(clampThinking("max", cap)).toBe("medium");
	});

	test("in-range levels pass through", () => {
		const cap: ThinkingCap = { min: "high" };
		expect(clampThinking("high", cap)).toBe("high");
		expect(clampThinking("max", cap)).toBe("max");
	});

	test("both bounds clamp into the window", () => {
		const cap: ThinkingCap = { min: "low", max: "high" };
		expect(clampThinking("off", cap)).toBe("low");
		expect(clampThinking("medium", cap)).toBe("medium");
		expect(clampThinking("max", cap)).toBe("high");
	});

	test("empty cap returns the level unchanged", () => {
		expect(clampThinking("high", {})).toBe("high");
	});
});
