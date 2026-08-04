import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProfileRegistry } from "../src/core/profile-registry";
import type { RouterConfig } from "../src/core/types";

function makeConfig(): RouterConfig {
	return {
		active: "premium",
		profiles: {
			cheap: {
				description: "Low cost",
				tiers: {
					standard: { targets: [{ provider: "openai", model: "gpt-4o-mini" }] },
				},
			},
			premium: {
				description: "Best quality",
				defaultTier: "complex",
				tiers: {
					trivial: { targets: [{ provider: "anthropic", model: "claude-haiku" }] },
					simple: { targets: [{ provider: "anthropic", model: "claude-sonnet" }] },
					standard: {
						thinking: "low",
						targets: [{ provider: "anthropic", model: "claude-sonnet" }],
					},
					complex: {
						thinking: "high",
						targets: [{ provider: "anthropic", model: "claude-opus" }],
					},
				},
			},
			local: {
				tiers: {
					complex: { targets: [{ provider: "ollama", model: "qwen3" }] },
				},
			},
		},
		aliases: {
			frugal: ["cheap"],
			smart: ["missing", "premium"],
			broken: ["nope"],
		},
		activate: [
			{ path: "/work/oss", profile: "cheap" },
			{ path: "/work/oss/secret", profile: "premium" },
			{ path: "~/personal", profile: "local" },
		],
	};
}

describe("ProfileRegistry.active resolution", () => {
	test("falls back to config.active when cwd matches nothing", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		expect(registry.active().name).toBe("premium");
		expect(registry.current()).toBe("premium");
	});

	test("falls back to first profile without config.active or path match", () => {
		const config = makeConfig();
		delete config.active;
		config.activate = [];
		const registry = new ProfileRegistry(config, { cwd: "/elsewhere" });
		expect(registry.active().name).toBe("cheap");
	});

	test("path activation beats config.active", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/work/oss/project" });
		expect(registry.active().name).toBe("cheap");
	});

	test("longest matching activate prefix wins", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/work/oss/secret/deep" });
		expect(registry.active().name).toBe("premium");
	});

	test("prefix match is segment-aware (no partial-segment match)", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/work/ossified" });
		expect(registry.active().name).toBe("premium");
	});

	test("~ expands to the home directory in activate paths", () => {
		const cwd = join(homedir(), "personal", "blog");
		const registry = new ProfileRegistry(makeConfig(), { cwd });
		expect(registry.active().name).toBe("local");
	});

	test("activate entries naming unknown profiles are skipped", () => {
		const config = makeConfig();
		delete config.active;
		config.activate = [{ path: "/x", profile: "ghost" }];
		const registry = new ProfileRegistry(config, { cwd: "/x/y" });
		expect(registry.active().name).toBe("cheap");
	});

	test("active() returns the profile config alongside the name", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		expect(registry.active().profile.description).toBe("Best quality");
	});
});

describe("ProfileRegistry.switch", () => {
	test("explicit switch wins over path activation and config.active", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/work/oss/project" });
		expect(registry.active().name).toBe("cheap");
		expect(registry.switch("premium")).toBe(true);
		expect(registry.active().name).toBe("premium");
		expect(registry.current()).toBe("premium");
	});

	test("switching to an unknown profile is a no-op returning false", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		expect(registry.switch("ghost")).toBe(false);
		expect(registry.current()).toBe("premium");
	});
});

describe("ProfileRegistry.profile/list/resolveAlias", () => {
	test("profile() is a raw name lookup (no alias resolution)", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		expect(registry.profile("cheap")?.description).toBe("Low cost");
		expect(registry.profile("frugal")).toBeUndefined();
		expect(registry.profile("ghost")).toBeUndefined();
	});

	test("list() reports all profiles with isActive flags", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		const list = registry.list();
		expect(list.map((e) => e.name)).toEqual(["cheap", "premium", "local"]);
		expect(list.find((e) => e.name === "premium")).toMatchObject({
			description: "Best quality",
			isActive: true,
		});
		expect(list.find((e) => e.name === "cheap")?.isActive).toBe(false);
		expect(list.find((e) => e.name === "local")?.description).toBeUndefined();
	});

	test("resolveAlias returns the first element naming an existing profile", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		expect(registry.resolveAlias("frugal")).toBe("cheap");
		expect(registry.resolveAlias("smart")).toBe("premium");
		expect(registry.resolveAlias("broken")).toBeUndefined();
		expect(registry.resolveAlias("unknown")).toBeUndefined();
	});
});

describe("ProfileRegistry.tierConfig ladder fallback", () => {
	test("exact tier is served directly", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		expect(registry.tierConfig("premium", "complex")?.thinking).toBe("high");
		expect(registry.tierConfig("premium", "trivial")?.targets[0]?.model).toBe("claude-haiku");
	});

	test("sparse profile (only standard) serves every tier", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		for (const tier of ["trivial", "simple", "standard", "complex"] as const) {
			expect(registry.tierConfig("cheap", tier)?.targets[0]?.model).toBe("gpt-4o-mini");
		}
	});

	test("fallback walks UP first, then DOWN", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		// local defines only complex: simple → up to complex; trivial → up to complex
		expect(registry.tierConfig("local", "simple")?.targets[0]?.model).toBe("qwen3");
		expect(registry.tierConfig("local", "trivial")?.targets[0]?.model).toBe("qwen3");
		// premium complex → exact; standard → exact (not pulled from complex)
		expect(registry.tierConfig("premium", "standard")?.thinking).toBe("low");
	});

	test("unknown profile yields undefined", () => {
		const registry = new ProfileRegistry(makeConfig(), { cwd: "/elsewhere" });
		expect(registry.tierConfig("ghost", "standard")).toBeUndefined();
	});
});
