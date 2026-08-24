import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProfileRegistry } from "../../src/core/profile-registry";
import type { RouterConfig } from "../../src/core/types";
import { probeModelRoles } from "../../src/omp-adapter/model-roles";

const CONFIG: RouterConfig = {
	active: "premium",
	profiles: {
		premium: {
			defaultTier: "standard",
			tiers: {
				standard: { targets: [{ provider: "anthropic", model: "sonnet" }] },
			},
			roles: {
				task: { targets: [{ provider: "deepseek", model: "flash" }] },
			},
		},
	},
};

let tmp: string;
let agentDir: string;
let cwd: string;

function writeUserConfig(yaml: string): void {
	writeFileSync(path.join(agentDir, "config.yml"), yaml);
}

function writeProjectConfig(yaml: string): void {
	mkdirSync(path.join(cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(cwd, ".omp", "config.yml"), yaml);
}

function probe(registered: readonly string[] = []): string[] {
	return probeModelRoles({
		registry: new ProfileRegistry(CONFIG),
		agentDir,
		cwd,
		isRegistered: (virtualId) => registered.includes(virtualId),
	});
}

beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "model-roles-test-"));
	agentDir = path.join(tmp, "agent");
	cwd = path.join(tmp, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("probeModelRoles", () => {
	test("no config.yml anywhere → warning to configure role routing", () => {
		const lines = probe();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("⚠️");
		expect(lines[0]).toContain("no host role routed");
	});

	test("all entries consistent → single ok summary", () => {
		writeUserConfig("modelRoles:\n  default: auto-router/premium\n  task: auto-router/premium/task\n");
		const lines = probe(["premium", "premium/task"]);
		expect(lines).toEqual(["✅ modelRoles — routed: default→premium, task→premium/task"]);
	});

	test("dangling profile is an error naming the available profiles", () => {
		writeUserConfig("modelRoles:\n  default: auto-router/premiun\n");
		const lines = probe(["premium"]);
		expect(lines.some((l) => l.includes("❌") && l.includes('unknown profile "premiun"') && l.includes("premium"))).toBe(true);
		expect(lines.at(-1)).toContain("every auto-router/* entry is broken");
	});

	test("undeclared role warns that it routes as the default chain", () => {
		writeUserConfig("modelRoles:\n  task: auto-router/premium/taskk\n  default: auto-router/premium\n");
		const lines = probe(["premium", "premium/task"]);
		expect(lines.some((l) => l.includes("⚠️") && l.includes('role "taskk" not declared') && l.includes("default chain"))).toBe(true);
		expect(lines.at(-1)).toContain("✅ modelRoles — routed: default→premium");
	});

	test("unregistered virtual model is an error pointing at H1", () => {
		writeUserConfig("modelRoles:\n  default: auto-router/premium\n");
		const lines = probe([]); // nothing registered
		expect(lines.some((l) => l.includes("❌") && l.includes("not in the host registry") && l.includes("H1"))).toBe(true);
	});

	test("project layer overrides the user layer per role key", () => {
		writeUserConfig("modelRoles:\n  default: auto-router/premiun\n  task: auto-router/premium/task\n");
		writeProjectConfig("modelRoles:\n  default: auto-router/premium\n");
		const lines = probe(["premium", "premium/task"]);
		expect(lines).toEqual(["✅ modelRoles — routed: default→premium, task→premium/task"]);
	});

	test("entries pointed at real providers are ignored", () => {
		writeUserConfig("modelRoles:\n  smol: anthropic/claude-haiku\n  default: auto-router/premium\n");
		const lines = probe(["premium"]);
		expect(lines).toEqual(["✅ modelRoles — routed: default→premium"]);
	});

	test("object-form values {provider, model} are normalized", () => {
		writeUserConfig("modelRoles:\n  default: { provider: auto-router, model: premium/task }\n");
		const lines = probe(["premium/task"]);
		// premium/task: profile=premium role=task (declared) — consistent
		expect(lines).toEqual(["✅ modelRoles — routed: default→premium/task"]);
	});

	test("unparseable config.yml surfaces a warning instead of crashing", () => {
		writeUserConfig("modelRoles: [unclosed\n");
		const lines = probe();
		expect(lines[0]).toContain("⚠️");
		expect(lines[0]).toContain("unparseable");
	});
});
