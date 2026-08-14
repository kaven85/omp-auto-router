import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { addTarget, baseModel, bootHarness, createPiHarness, type PiHarness } from "./mock-pi";

const CONFIG = `
active: premium
aliases: { eco: [economy] }
profiles:
  premium:
    description: 订阅优先
    tiers:
      standard:
        thinking: medium
        targets:
          - provider: alpha
            model: a1
          - provider: beta
            model: b1
    budgets:
      alpha: { amount: 10, monthly: true }
  economy:
    tiers:
      standard:
        targets:
          - provider: beta
            model: b1
`;

let harness: PiHarness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

async function boot(): Promise<PiHarness> {
	harness = createPiHarness({ userConfig: CONFIG, trusted: false });
	addTarget(harness, baseModel("alpha", "a1"));
	addTarget(harness, baseModel("beta", "b1"));
	await bootHarness(harness);
	return harness;
}

const output = (h: PiHarness) => h.notifications.map((notice) => notice.message).join("\n");

describe("Pi command group (shared implementation)", () => {
	test("status/profiles/current reflect the registered profiles", async () => {
		const h = await boot();
		await h.invoke("status");
		expect(output(h)).toContain("profile: premium");
		expect(output(h)).toContain("mode: A");
		await h.invoke("profiles");
		expect(output(h)).toContain("▶ premium");
		expect(output(h)).toContain(" economy");
		await h.invoke("current");
		expect(h.notifications.at(-1)?.message).toBe("premium");
	});

	test("use switches through the registered virtual model and persists a neutral entry", async () => {
		const h = await boot();
		await h.invoke("use eco");
		expect(h.context.model).toMatchObject({ provider: "auto-router", id: "economy" });
		expect(h.entries.some((entry) => entry.customType === "com.auto-router.v1.state" && (entry.data as { profile?: string }).profile === "economy")).toBe(true);
		expect(h.notifications.at(-1)?.message).toBe("switched to profile: economy");

		await h.invoke("current");
		expect(h.notifications.at(-1)?.message).toBe("economy");

		await h.invoke("use nope");
		expect(h.notifications.at(-1)?.level).toBe("error");

		h.setModelResult = false;
		await h.invoke("use premium");
		expect(h.notifications.at(-1)?.message).toContain("model switch to auto-router/premium failed");
	});

	test("list/show/explain render chains and reasoning", async () => {
		const h = await boot();
		await h.invoke("list");
		expect(output(h)).toContain("standard (thinking=medium): alpha/a1, beta/b1");
		await h.invoke("show premium");
		expect(output(h)).toContain("defaultTier: standard");
		expect(output(h)).toContain("budgets:");
		expect(output(h)).toContain("alpha: $10 monthly");
		await h.invoke("explain");
		expect(h.notifications.at(-1)?.message).toBe("no routing decision yet");

		await h.stream("premium", "plain prompt");
		await h.invoke("explain");
		expect(h.notifications.at(-1)?.message).toContain("target: alpha/a1");
		expect(h.notifications.at(-1)?.message).toContain("chain: alpha/a1 → beta/b1");
	});

	test("budget and rate work without any host quota capability", async () => {
		const h = await boot();
		await h.invoke("budget show");
		expect(output(h)).toContain("alpha: $0.00 / $10 (0%) monthly");
		await h.invoke("budget set beta 2");
		expect(output(h)).toContain("budget set: beta $2 daily");

		await h.invoke("rate good");
		expect(output(h)).toContain("no decision to rate yet");
		await h.stream("premium", "plain prompt");
		await h.invoke("rate bad flaky");
		expect(output(h)).toContain("rated bad — alpha/a1 (1 total, 0% good)");
	});

	test("uvi and usage report the explicit Pi quota degradation", async () => {
		const h = await boot();
		await h.invoke("uvi");
		expect(h.notifications.at(-1)?.level).toBe("warning");
		expect(output(h)).toContain("UVI usage reports: unavailable through Pi public interface");
		await h.invoke("usage");
		expect(output(h)).toContain("usage — page 1/1");
		// No fabricated plan rows: only balance-endpoint rows may appear.
		expect(output(h)).not.toContain("type     plan");
		expect(output(h)).toContain("local budgets, balances, ratings and failover remain enabled");
	});

	test("doctor identifies the host and splits required vs optional capabilities", async () => {
		const h = await boot();
		await h.invoke("doctor");
		const out = h.notifications.at(-1)?.message ?? "";
		expect(out).toContain("auto-router doctor (Pi)");
		expect(out).toContain("✅ required — public ModelRegistry");
		expect(out).toContain("⚠️ optional — UVI usage reports unavailable");
		expect(out).toContain("mode: A");
	});

	test("rules edits persist to the state directory and affect later reads", async () => {
		const h = await boot();
		await h.invoke("rules add mechanicalOp 同步数据");
		expect(output(h)).toContain("added → mechanicalOp: 同步数据");
		const persisted = JSON.parse(
			readFileSync(join(h.agentDir, "auto-router", "classifier-rules.json"), "utf8"),
		) as { add?: Record<string, string[]> };
		expect(persisted.add?.mechanicalOp).toEqual(["同步数据"]);
		await h.invoke("rules reset");
		expect(output(h)).toContain("classifier rules reset");
	});

	test("shadow mode toggle reports through the host notify surface", async () => {
		const h = await boot();
		await h.invoke("shadow enable");
		expect(output(h)).toContain("shadow mode enabled");
		await h.invoke("shadow");
		expect(output(h)).toContain("shadow mode: 🟢 enabled");
	});

	test("help lists the full shared subcommand set", async () => {
		const h = await boot();
		await h.invoke("help");
		const out = output(h);
		for (const sub of ["status", "profiles", "current", "use", "list", "show", "explain", "doctor", "reload", "budget", "uvi", "shadow", "rate", "rules", "usage", "help"]) {
			expect(out).toContain(`/auto-router ${sub}`);
		}
	});

	test("argument completions cover subcommands, actions, profiles and rule lists", async () => {
		const h = await boot();
		const completions = h.commands.get("auto-router")?.getArgumentCompletions;
		expect(completions).toBeDefined();
		expect(completions!("")?.map((item) => item.label)).toContain("explain");
		expect(completions!("bud")?.map((item) => item.label)).toEqual(["budget"]);
		expect(completions!("shadow ")?.map((item) => item.label).sort()).toEqual(["disable", "enable", "show"]);
		expect(completions!("use eco")?.map((item) => item.label)).toEqual(["economy"]);
		expect(completions!("rules add ")?.map((item) => item.label)).toContain("mechanicalOp");
	});

	test("widget renders decision + budget after a settled request without quota data", async () => {
		const h = await boot();
		const widgets: string[][] = [];
		h.context.ui.setWidget = (_id: string, lines: string[]) => {
			widgets.push(lines);
		};
		await h.stream("premium", "plain prompt");
		expect(widgets.length).toBeGreaterThan(0);
		expect(widgets.at(-1)?.[0]).toMatch(/^premium \| tier=\w+ \| alpha\/a1/);
		expect(widgets.at(-1)?.some((line) => line.startsWith("budgets: alpha"))).toBe(true);
		// No UVI lines may appear — Pi has no quota reports to render.
		expect(widgets.at(-1)?.some((line) => line.startsWith("uvi:"))).toBe(false);
	});

	test("reload keeps the active session usable and reports config errors as warnings", async () => {
		const h = await boot();
		writeFileSync(join(h.agentDir, "auto-router.yml"), "profiles: [not-a-map]");
		await h.invoke("reload");
		expect(h.notifications.at(-1)?.level).toBe("warning");
		expect(output(h)).toContain("config reloaded");
		// The router still answers with the default profile after a broken reload.
		await h.invoke("status");
		expect(h.notifications.at(-1)?.level).toBe("info");
	});
});
