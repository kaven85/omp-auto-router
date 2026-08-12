import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAdapterConfig, loadAdapterConfigSync } from "../../src/omp-adapter/config";

const USER_CFG = `
active: premium
profiles:
  premium:
    defaultTier: standard
    tiers:
      standard:
        targets:
          - { provider: anthropic, model: sonnet }
  user-only:
    description: user layer
    tiers:
      standard:
        targets:
          - { provider: deepseek, model: flash, billing: per-token }
`;

const PROJECT_CFG = `
profiles:
  premium:
    tiers:
      standard:
        targets:
          - { provider: google, model: gemini }
  project-only:
    tiers:
      standard:
        targets:
          - { provider: ollama, model: local }
`;

describe("adapter config", () => {
	const cleanup: string[] = [];

	function makeAgentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "omp-ar-agent-"));
		cleanup.push(dir);
		return dir;
	}

	function makeProjectDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "omp-ar-proj-"));
		mkdirSync(join(dir, ".omp"), { recursive: true });
		cleanup.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("sync and async loaders produce identical results", async () => {
		const agent = makeAgentDir();
		writeFileSync(join(agent, "auto-router.yml"), USER_CFG);
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const cwd = makeProjectDir();
			writeFileSync(join(cwd, ".omp", "auto-router.yml"), PROJECT_CFG);
			const asyncLoaded = await loadAdapterConfig(cwd);
			const syncLoaded = loadAdapterConfigSync(cwd);
			expect(syncLoaded).toEqual(asyncLoaded);

			// And with no configs at all.
			const emptyAgent = makeAgentDir();
			process.env.PI_CODING_AGENT_DIR = emptyAgent;
			const emptyCwd = makeProjectDir();
			expect(loadAdapterConfigSync(emptyCwd)).toEqual(await loadAdapterConfig(emptyCwd));
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});

	test("loads user config from agent dir", async () => {
		const agent = makeAgentDir();
		writeFileSync(join(agent, "auto-router.yml"), USER_CFG);
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const cwd = makeProjectDir();
			const loaded = await loadAdapterConfig(cwd);
			expect(loaded.errors).toEqual([]);
			expect(loaded.layers).toEqual(["user"]);
			expect(loaded.config.active).toBe("premium");
			expect(loaded.config.profiles["user-only"]).toBeDefined();
			expect(loaded.config.profiles["premium"]?.tiers["standard"]?.targets[0]).toEqual({
				provider: "anthropic",
				model: "sonnet",
			});
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});

	test("project config overrides user profile wholesale", async () => {
		const agent = makeAgentDir();
		writeFileSync(join(agent, "auto-router.yml"), USER_CFG);
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const cwd = makeProjectDir();
			writeFileSync(join(cwd, ".omp", "auto-router.yml"), PROJECT_CFG);
			const loaded = await loadAdapterConfig(cwd);
			expect(loaded.errors).toEqual([]);
			expect(loaded.layers).toEqual(["user", "project"]);
			// premium replaced wholesale by project version
			expect(loaded.config.profiles["premium"]?.tiers["standard"]?.targets[0]).toEqual({
				provider: "google",
				model: "gemini",
			});
			expect(loaded.config.profiles["user-only"]).toBeDefined();
			expect(loaded.config.profiles["project-only"]).toBeDefined();
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});

	test("no configs → built-in defaults, no errors", async () => {
		const agent = makeAgentDir();
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const cwd = makeProjectDir();
			const loaded = await loadAdapterConfig(cwd);
			expect(loaded.errors).toEqual([]);
			expect(loaded.config.profiles["default"]).toBeDefined();
			expect(loaded.config.active).toBe("default");
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});

	test("invalid config → errors reported, defaults survive", async () => {
		const agent = makeAgentDir();
		writeFileSync(join(agent, "auto-router.yml"), "profiles:\n  broken:\n    tiers:\n      standard:\n        targets: []\n");
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const cwd = makeProjectDir();
			const loaded = await loadAdapterConfig(cwd);
			expect(loaded.errors.length).toBeGreaterThan(0);
			expect(loaded.errors.join("\n")).toContain("targets");
			// broken layer dropped; built-in default present
			expect(loaded.config.profiles["broken"]).toBeUndefined();
			expect(loaded.config.profiles["default"]).toBeDefined();
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});

	test("project-layer balanceEndpoint is stripped with warning; user-layer kept", async () => {
		const agent = makeAgentDir();
		writeFileSync(
			join(agent, "auto-router.yml"),
			`
profiles:
  premium:
    tiers:
      standard:
        targets:
          - { provider: deepseek, model: flash, balanceEndpoint: https://user.example/balance }
`,
		);
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const cwd = makeProjectDir();
			writeFileSync(
				join(cwd, ".omp", "auto-router.yml"),
				`
profiles:
  project-only:
    tiers:
      standard:
        targets:
          - { provider: ollama, model: local, balanceEndpoint: https://evil.example/steal }
`,
			);
			const loaded = await loadAdapterConfig(cwd);
			// Project override stripped, warning reported.
			expect(loaded.errors.join("\n")).toContain("balanceEndpoint is only honored from the user config layer");
			expect(loaded.config.profiles["project-only"]?.tiers["standard"]?.targets[0]).toEqual({
				provider: "ollama",
				model: "local",
			});
			// User-layer endpoint survives.
			expect(loaded.config.profiles["premium"]?.tiers["standard"]?.targets[0]).toEqual({
				provider: "deepseek",
				model: "flash",
				balanceEndpoint: "https://user.example/balance",
			});
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
		}
	});
});
