import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadRouterConfigFile,
	mergeRouterConfigs,
	parseRouterConfig,
} from "../src/core/config-loader";
import type { ProfileConfig, RouterConfig } from "../src/core/types";

const VALID_YAML = `
active: premium
profiles:
  cheap:
    description: Low cost
    tiers:
      standard:
        targets:
          - provider: openai
            model: gpt-4o-mini
  premium:
    description: Best quality
    defaultTier: complex
    tiers:
      trivial:
        targets:
          - provider: anthropic
            model: claude-haiku
      standard:
        thinking: low
        targets:
          - provider: anthropic
            model: claude-sonnet
            billing: subscription
      complex:
        thinking: high
        targets:
          - provider: anthropic
            model: claude-opus
            billing: per-token
            balanceEndpoint: https://example.com/balance
    budgets:
      anthropic:
        amount: 25
        monthly: true
    rules:
      - type: force-tier
        tier: complex
        priority: 10
        when:
          hourStart: 9
          hourEnd: 17
          weekdays: [1, 2, 3, 4, 5]
      - type: exclude-provider
        providers: [openai]
aliases:
  frugal: [cheap]
activate:
  - path: ~/work
    profile: cheap
`;

describe("parseRouterConfig", () => {
	test("parses a full valid config", () => {
		const { config, errors } = parseRouterConfig(VALID_YAML);
		expect(errors).toEqual([]);
		expect(config).toBeDefined();
		const c = config!;
		expect(c.active).toBe("premium");
		expect(Object.keys(c.profiles)).toEqual(["cheap", "premium"]);
		const premium = c.profiles.premium!;
		expect(premium.defaultTier).toBe("complex");
		expect(premium.tiers.complex?.thinking).toBe("high");
		expect(premium.tiers.complex?.targets[0]?.billing).toBe("per-token");
		expect(premium.budgets?.anthropic).toEqual({ amount: 25, monthly: true });
		expect(premium.rules?.[0]).toMatchObject({
			type: "force-tier",
			tier: "complex",
			priority: 10,
			when: { hourStart: 9, hourEnd: 17, weekdays: [1, 2, 3, 4, 5] },
		});
		expect(c.aliases).toEqual({ frugal: ["cheap"] });
		expect(c.activate).toEqual([{ path: "~/work", profile: "cheap" }]);
	});

	test("YAML syntax error yields errors, never throws", () => {
		const { config, errors } = parseRouterConfig("profiles: [unclosed");
		expect(config).toBeUndefined();
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("<yaml>");
	});

	test("non-mapping root is an error", () => {
		const { config, errors } = parseRouterConfig("- a\n- b\n");
		expect(config).toBeUndefined();
		expect(errors[0]).toContain("<root>");
	});

	test("empty document reports missing profiles", () => {
		const { config, errors } = parseRouterConfig("");
		expect(config).toBeUndefined();
		expect(errors[0]).toContain("profiles");
	});

	test("missing profiles is an error", () => {
		const { errors } = parseRouterConfig("active: x\n");
		expect(errors.some((e) => e.startsWith("profiles:"))).toBe(true);
	});

	test("empty profiles mapping is an error", () => {
		const { errors } = parseRouterConfig("profiles: {}\n");
		expect(errors.some((e) => e.includes("at least one profile"))).toBe(true);
	});

	test("unknown tier key is rejected with dotted path", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      mega:
        targets: [{ provider: a, model: b }]
`;
		const { config, errors } = parseRouterConfig(yaml);
		expect(config).toBeUndefined();
		expect(errors.some((e) => e.includes("profiles.premium.tiers.mega"))).toBe(true);
	});

	test("empty targets array is an error", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        targets: []
`;
		const { errors } = parseRouterConfig(yaml);
		expect(errors.some((e) => e.includes("profiles.premium.tiers.standard.targets"))).toBe(true);
	});

	test("target missing provider reports exact dotted path", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        targets:
          - model: claude-opus
`;
		const { errors } = parseRouterConfig(yaml);
		expect(
			errors.some((e) =>
				e.startsWith("profiles.premium.tiers.standard.targets[0].provider: required"),
			),
		).toBe(true);
	});

	test("invalid billing and thinking are both collected", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        thinking: ludicrous
        targets:
          - provider: a
            model: b
            billing: free
`;
		const { errors } = parseRouterConfig(yaml);
		expect(errors.some((e) => e.includes("tiers.standard.thinking"))).toBe(true);
		expect(errors.some((e) => e.includes("targets[0].billing"))).toBe(true);
	});

	test("target thinking overrides the tier thinking level", () => {
		const yaml = `
profiles:
  company:
    tiers:
      complex:
        thinking: high
        targets:
          - provider: newapi
            model: gpt-5.6-sol
            thinking: low
          - provider: newapi
            model: gpt-5.5
`;
		const { config, errors } = parseRouterConfig(yaml);
		expect(errors).toEqual([]);
		const targets = config!.profiles.company!.tiers.complex!.targets;
		expect(targets[0]!.thinking).toBe("low");
		expect(targets[1]!.thinking).toBeUndefined();
	});

	test("target thinking rejects invalid levels with dotted path", () => {
		const yaml = `
profiles:
  company:
    tiers:
      complex:
        targets:
          - provider: newapi
            model: gpt-5.6-sol
            thinking: ludicrous
`;
		const { config, errors } = parseRouterConfig(yaml);
		expect(config).toBeUndefined();
		expect(errors).toContain(
			"profiles.company.tiers.complex.targets[0].thinking: must be one of off, minimal, low, medium, high, xhigh, max",
		);
	});

	test("target thinkingCap parses min/max", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      complex:
        targets:
          - provider: deepseek
            model: deepseek-v4-pro
            thinkingCap: { min: high }
          - provider: deepseek
            model: deepseek-v4-flash
            thinkingCap: { min: low, max: max }
`;
		const { config, errors } = parseRouterConfig(yaml);
		expect(errors).toEqual([]);
		const targets = config!.profiles.premium!.tiers.complex!.targets;
		expect(targets[0]!.thinkingCap).toEqual({ min: "high" });
		expect(targets[1]!.thinkingCap).toEqual({ min: "low", max: "max" });
	});

	test("target thinkingCap rejects invalid levels with dotted path", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      complex:
        targets:
          - provider: deepseek
            model: deepseek-v4-flash
            thinkingCap: { min: low, max: bogus }
`;
		const { config, errors } = parseRouterConfig(yaml);
		expect(config).toBeUndefined();
		expect(errors.some((e) => e.includes("targets[0].thinkingCap.max"))).toBe(true);
	});

	test("budget amount must be a positive number", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        targets: [{ provider: a, model: b }]
    budgets:
      anthropic:
        amount: -5
      openai:
        amount: lots
`;
		const { errors } = parseRouterConfig(yaml);
		expect(errors.some((e) => e.includes("budgets.anthropic.amount"))).toBe(true);
		expect(errors.some((e) => e.includes("budgets.openai.amount"))).toBe(true);
	});

	test("rule validation collects all type-specific errors", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        targets: [{ provider: a, model: b }]
    rules:
      - type: nope
      - type: force-tier
      - type: prefer-provider
        providers: []
      - type: force-billing
      - type: force-constraint
`;
		const { config, errors } = parseRouterConfig(yaml);
		expect(config).toBeUndefined();
		expect(errors.some((e) => e.includes("rules[0].type"))).toBe(true);
		expect(errors.some((e) => e.includes("rules[1].tier"))).toBe(true);
		expect(errors.some((e) => e.includes("rules[2].providers"))).toBe(true);
		expect(errors.some((e) => e.includes("rules[3].billing"))).toBe(true);
		expect(errors.some((e) => e.includes("rules[4].constraint"))).toBe(true);
		expect(errors.length).toBe(5);
	});

	test("when-condition ranges are validated", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        targets: [{ provider: a, model: b }]
    rules:
      - type: force-tier
        tier: complex
        when:
          hourStart: 24
          hourEnd: -1
          weekdays: [1, 7]
`;
		const { errors } = parseRouterConfig(yaml);
		expect(errors.some((e) => e.includes("when.hourStart"))).toBe(true);
		expect(errors.some((e) => e.includes("when.hourEnd"))).toBe(true);
		expect(errors.some((e) => e.includes("when.weekdays"))).toBe(true);
	});

	test("aliases must be string arrays", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        targets: [{ provider: a, model: b }]
aliases:
  good: [premium]
  bad: premium
  worse: [premium, 42]
`;
		const { errors } = parseRouterConfig(yaml);
		expect(errors.some((e) => e.includes("aliases.bad"))).toBe(true);
		expect(errors.some((e) => e.includes("aliases.worse"))).toBe(true);
		expect(errors.some((e) => e.includes("aliases.good"))).toBe(false);
	});

	test("activate entries require path and profile strings", () => {
		const yaml = `
profiles:
  premium:
    tiers:
      standard:
        targets: [{ provider: a, model: b }]
activate:
  - path: /work
  - profile: premium
  - 42
`;
		const { errors } = parseRouterConfig(yaml);
		expect(errors.some((e) => e.includes("activate[0].profile"))).toBe(true);
		expect(errors.some((e) => e.includes("activate[1].path"))).toBe(true);
		expect(errors.some((e) => e.includes("activate[2]"))).toBe(true);
	});

	test("active must reference an existing profile", () => {
		const yaml = `
active: ghost
profiles:
  premium:
    tiers:
      standard:
        targets: [{ provider: a, model: b }]
`;
		const { config, errors } = parseRouterConfig(yaml);
		expect(config).toBeUndefined();
		expect(errors.some((e) => e.startsWith("active: unknown profile"))).toBe(true);
	});
});

describe("mergeRouterConfigs", () => {
	const profileA: ProfileConfig = {
		description: "from base",
		tiers: {
			standard: { targets: [{ provider: "a", model: "m1" }] },
			complex: { targets: [{ provider: "a", model: "m2" }] },
		},
	};
	const profileB: ProfileConfig = {
		tiers: {
			simple: { targets: [{ provider: "b", model: "m3" }] },
		},
	};

	test("no layers yields an empty profiles record", () => {
		expect(mergeRouterConfigs()).toEqual({ profiles: {} });
		expect(mergeRouterConfigs(undefined, undefined)).toEqual({ profiles: {} });
	});

	test("later same-named profile replaces wholesale; distinct profiles merge", () => {
		const base: RouterConfig = { profiles: { premium: profileA, cheap: profileB } };
		const override: RouterConfig = { profiles: { premium: profileB } };
		const merged = mergeRouterConfigs(base, undefined, override);
		expect(merged.profiles.premium).toEqual(profileB);
		expect(merged.profiles.cheap).toEqual(profileB);
	});

	test("active/aliases/activate overridden only when present", () => {
		const base: RouterConfig = {
			active: "a",
			profiles: { a: profileA, b: profileB },
			aliases: { x: ["a"] },
			activate: [{ path: "/base", profile: "a" }],
		};
		const kept = mergeRouterConfigs(base, { profiles: {} });
		expect(kept.active).toBe("a");
		expect(kept.aliases).toEqual({ x: ["a"] });
		expect(kept.activate).toEqual([{ path: "/base", profile: "a" }]);

		const override: RouterConfig = {
			active: "b",
			profiles: {},
			aliases: { y: ["b"] },
			activate: [{ path: "/override", profile: "b" }],
		};
		const replaced = mergeRouterConfigs(base, override);
		expect(replaced.active).toBe("b");
		expect(replaced.aliases).toEqual({ y: ["b"] });
		expect(replaced.activate).toEqual([{ path: "/override", profile: "b" }]);
	});
});

describe("loadRouterConfigFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-auto-router-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("missing file is empty, not an error", async () => {
		const result = await loadRouterConfigFile(join(dir, "nope.yml"));
		expect(result).toEqual({ errors: [] });
	});

	test("valid file loads", async () => {
		const path = join(dir, "auto-router.yml");
		await Bun.write(path, VALID_YAML);
		const { config, errors } = await loadRouterConfigFile(path);
		expect(errors).toEqual([]);
		expect(config?.active).toBe("premium");
	});

	test("YAML syntax error is reported", async () => {
		const path = join(dir, "broken.yml");
		await Bun.write(path, "profiles: [unclosed");
		const { config, errors } = await loadRouterConfigFile(path);
		expect(config).toBeUndefined();
		expect(errors.length).toBe(1);
	});

	test("schema-invalid YAML is reported, never throws", async () => {
		const path = join(dir, "invalid.yml");
		await Bun.write(path, "profiles: {}\n");
		const { config, errors } = await loadRouterConfigFile(path);
		expect(config).toBeUndefined();
		expect(errors.length).toBeGreaterThan(0);
	});
});
