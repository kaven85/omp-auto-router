import { afterEach, describe, expect, test } from "bun:test";

import { confidenceThreshold, cooldownAfterFailureMs, llmAdjudicationEnabled, quotaRefreshMs, routerEnvNumber, uviHardMode } from "../../src/runtime/env";

const KEYS = [
	"AUTO_ROUTER_COOLDOWN_MS",
	"OMP_AUTO_ROUTER_COOLDOWN_MS",
	"PI_AUTO_ROUTER_COOLDOWN_MS",
	"AUTO_ROUTER_QUOTA_REFRESH_MS",
	"OMP_AUTO_ROUTER_QUOTA_REFRESH_MS",
	"PI_AUTO_ROUTER_QUOTA_REFRESH_MS",
	"AUTO_ROUTER_UVI_HARD",
	"OMP_AUTO_ROUTER_UVI_HARD",
	"PI_AUTO_ROUTER_UVI_HARD",
	"AUTO_ROUTER_CONFIDENCE_THRESHOLD",
	"OMP_AUTO_ROUTER_CONFIDENCE_THRESHOLD",
	"PI_AUTO_ROUTER_CONFIDENCE_THRESHOLD",
	"AUTO_ROUTER_LLM_ADJUDICATE",
	"OMP_AUTO_ROUTER_LLM_ADJUDICATE",
	"PI_AUTO_ROUTER_LLM_ADJUDICATE",
] as const;

const saved = new Map<string, string | undefined>();

function clearEnv(): void {
	for (const key of KEYS) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		delete process.env[key];
	}
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
});

describe("routerEnvNumber", () => {
	test("neutral prefix wins over OMP legacy and Pi alias", () => {
		clearEnv();
		process.env.AUTO_ROUTER_COOLDOWN_MS = "7000";
		process.env.OMP_AUTO_ROUTER_COOLDOWN_MS = "8000";
		process.env.PI_AUTO_ROUTER_COOLDOWN_MS = "9000";
		expect(cooldownAfterFailureMs()).toBe(7_000);
	});

	test("OMP legacy alias applies when the neutral variable is absent", () => {
		clearEnv();
		process.env.OMP_AUTO_ROUTER_COOLDOWN_MS = "8000";
		expect(cooldownAfterFailureMs()).toBe(8_000);
	});

	test("Pi alias applies after neutral and OMP aliases", () => {
		clearEnv();
		process.env.PI_AUTO_ROUTER_COOLDOWN_MS = "9000";
		expect(cooldownAfterFailureMs()).toBe(9_000);
	});

	test("invalid values fall through to the next alias", () => {
		clearEnv();
		process.env.AUTO_ROUTER_COOLDOWN_MS = "not-a-number";
		process.env.OMP_AUTO_ROUTER_COOLDOWN_MS = "8000";
		expect(cooldownAfterFailureMs()).toBe(8_000);
	});

	test("values below the minimum bound are treated as absent", () => {
		clearEnv();
		process.env.AUTO_ROUTER_COOLDOWN_MS = "1000";
		expect(cooldownAfterFailureMs()).toBe(60_000);
	});

	test("falls back to the default when no alias is usable", () => {
		clearEnv();
		expect(quotaRefreshMs()).toBe(30_000);
		expect(routerEnvNumber("MISSING_SUFFIX", { min: 0, fallback: 123 })).toBe(123);
	});
});

describe("uviHardMode", () => {
	test("off by default", () => {
		clearEnv();
		expect(uviHardMode()).toBe(false);
	});

	test("1/true enable, other values do not", () => {
		clearEnv();
		process.env.AUTO_ROUTER_UVI_HARD = "1";
		expect(uviHardMode()).toBe(true);
		process.env.AUTO_ROUTER_UVI_HARD = "true";
		expect(uviHardMode()).toBe(true);
		process.env.AUTO_ROUTER_UVI_HARD = "yes";
		expect(uviHardMode()).toBe(false);
	});

	test("OMP legacy alias applies when the neutral variable is absent", () => {
		clearEnv();
		process.env.OMP_AUTO_ROUTER_UVI_HARD = "1";
		expect(uviHardMode()).toBe(true);
	});
});

describe("confidenceThreshold", () => {
	test("defaults to 0.45", () => {
		clearEnv();
		expect(confidenceThreshold()).toBe(0.45);
	});

	test("neutral prefix wins; invalid values fall through to the OMP alias", () => {
		clearEnv();
		process.env.AUTO_ROUTER_CONFIDENCE_THRESHOLD = "junk";
		process.env.OMP_AUTO_ROUTER_CONFIDENCE_THRESHOLD = "0.7";
		expect(confidenceThreshold()).toBe(0.7);
		process.env.AUTO_ROUTER_CONFIDENCE_THRESHOLD = "0.9";
		expect(confidenceThreshold()).toBe(0.9);
	});
});

describe("llmAdjudicationEnabled", () => {
	test("on by default", () => {
		clearEnv();
		expect(llmAdjudicationEnabled()).toBe(true);
	});

	test("0/false disable, any other defined value enables", () => {
		clearEnv();
		process.env.AUTO_ROUTER_LLM_ADJUDICATE = "0";
		expect(llmAdjudicationEnabled()).toBe(false);
		process.env.AUTO_ROUTER_LLM_ADJUDICATE = "false";
		expect(llmAdjudicationEnabled()).toBe(false);
		process.env.AUTO_ROUTER_LLM_ADJUDICATE = "1";
		expect(llmAdjudicationEnabled()).toBe(true);
	});

	test("OMP legacy alias applies when the neutral variable is absent", () => {
		clearEnv();
		process.env.OMP_AUTO_ROUTER_LLM_ADJUDICATE = "0";
		expect(llmAdjudicationEnabled()).toBe(false);
	});
});
