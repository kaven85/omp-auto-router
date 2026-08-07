/**
 * /auto-router command group (M2 surface).
 *
 * Subcommands: status, profiles, current, use, list, show, explain, doctor,
 * reload, budget, uvi, shadow, rate, help. `/auto-router help` prints a
 * description + example per subcommand.
 */

import type { QuotaSnapshot, QuotaWindow, RouteTarget } from "../core/types";
import type { AdapterState } from "./state";
import type { OmpAutocompleteItem, OmpExtensionApi, OmpExtensionContext } from "./omp-api";
import { createHostPorts, quotaRefreshMs } from "./host-ports";
import {
	fetchProviderBalance,
	PROVIDER_DISPLAY_ORDER,
	PROVIDER_REGISTRY,
	resolveBalanceEndpoint,
	type ProviderBalance,
} from "./provider-registry";

export interface CommandDeps {
	/** Current adapter state (undefined until session_start boot). */
	getState: () => AdapterState | undefined;
	reloadConfig: () => Promise<string[]>;
	pi: OmpExtensionApi;
}

export function registerCommands(pi: OmpExtensionApi, deps: CommandDeps): void {
	pi.registerCommand("auto-router", {
		description: "omp-auto-router：profile/复杂度路由控制",
		getArgumentCompletions: (argumentPrefix) => buildArgumentCompletions(argumentPrefix ?? "", deps),
		handler: (args, ctx) => runCommand(args ?? "", deps, ctx),
	});
}

function lines(items: (string | undefined)[]): string {
	return items.filter((item): item is string => item !== undefined).join("\n");
}

/** Collect all unique provider names configured across every profile. */
function getConfiguredProviders(state: AdapterState): string[] {
	const providers = new Set<string>();
	for (const target of getConfiguredTargets(state)) {
		providers.add(target.provider);
	}
	return [...providers].sort();
}

/** Collect every target configured across every profile (all tiers). */
function getConfiguredTargets(state: AdapterState): RouteTarget[] {
	const targets: RouteTarget[] = [];
	for (const entry of state.registry.list()) {
		const profile = state.registry.profile(entry.name);
		if (!profile) continue;
		for (const tier of Object.values(profile.tiers)) {
			for (const target of tier.targets ?? []) {
				if (target.provider) targets.push(target);
			}
		}
	}
	return targets;
}

/** Format milliseconds until reset into a human-readable string. */
function formatReset(remainMs: number | undefined): string {
	if (remainMs === undefined) return "unknown";
	if (remainMs <= 0) return "now";
	const days = Math.floor(remainMs / 86_400_000);
	const hours = Math.floor((remainMs % 86_400_000) / 3_600_000);
	const minutes = Math.floor((remainMs % 3_600_000) / 60_000);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

interface QuotaTableRow {
	provider: string;
	window: string;
	type: "plan" | "balance";
	remaining: string;
	balance: string;
	resetsIn: string;
}

const QUOTA_COLUMNS: Array<keyof QuotaTableRow> = ["provider", "window", "type", "remaining", "balance", "resetsIn"];
const QUOTA_HEADERS: Record<keyof QuotaTableRow, string> = {
	provider: "provider",
	window: "window",
	type: "type",
	remaining: "remaining",
	balance: "balance",
	resetsIn: "resets in",
};
const RIGHT_ALIGNED_QUOTA_COLUMNS: Partial<Record<keyof QuotaTableRow, true>> = {
	remaining: true,
	balance: true,
	resetsIn: true,
};
const KIMI_SORT_LOCALE = "en";

function windowLabel(provider: string, window: QuotaWindow): string {
	return PROVIDER_REGISTRY[provider]?.windowLabels?.[window.id] ?? window.id;
}

/**
 * Render quota reports into one stable, fixed-width table. Providers with a
 * resolved balance endpoint render as `balance` rows instead of plan rows;
 * providers with registry window labels (e.g. Kimi's `5h/weekly` pair) get
 * their windows sorted by label so paired values stay aligned.
 */
export function formatQuotaTable(
	snapshots: QuotaSnapshot[],
	balances?: ReadonlyMap<string, ProviderBalance | undefined>,
	formatResetValue: (remainMs: number | undefined) => string = formatReset,
): string[] {
	const rows: QuotaTableRow[] = snapshots
		.filter((snapshot) => balances?.has(snapshot.provider) !== true && snapshot.windows.length > 0)
		.map((snapshot) => {
			const hasLabels = PROVIDER_REGISTRY[snapshot.provider]?.windowLabels !== undefined;
			const windows = hasLabels
				? [...snapshot.windows].sort((a, b) =>
						windowLabel(snapshot.provider, a).localeCompare(windowLabel(snapshot.provider, b), KIMI_SORT_LOCALE, { numeric: true }),
					)
				: snapshot.windows;
			return {
				provider: snapshot.provider,
				window: windows.map((window) => windowLabel(snapshot.provider, window)).join("/"),
				type: "plan",
				remaining: windows.map((window) => `${((1 - window.usedFraction) * 100).toFixed(1)}%`).join(" / "),
				balance: "-",
				resetsIn: windows
					.map((window) => formatResetValue(window.resetsAt === undefined ? undefined : window.resetsAt - Date.now()))
					.join(" / "),
			};
		});

	for (const [provider, balance] of balances ?? []) {
		rows.push({
			provider,
			window: "n/a",
			type: "balance",
			remaining: "-",
			balance: balance ? `${balance.total} ${balance.currency}` : "unknown",
			resetsIn: "-",
		});
	}

	rows.sort((a, b) => {
		const aPriority = PROVIDER_DISPLAY_ORDER[a.provider] ?? Number.POSITIVE_INFINITY;
		const bPriority = PROVIDER_DISPLAY_ORDER[b.provider] ?? Number.POSITIVE_INFINITY;
		return aPriority === bPriority ? a.provider.localeCompare(b.provider) : aPriority - bPriority;
	});
	const widths = QUOTA_COLUMNS.reduce<Record<keyof QuotaTableRow, number>>(
		(current, column) => {
			current[column] = Math.max(QUOTA_HEADERS[column].length, ...rows.map((row) => row[column].length));
			return current;
		},
		{ provider: 0, window: 0, type: 0, remaining: 0, balance: 0, resetsIn: 0 },
	);
	const separator = QUOTA_COLUMNS.map((column) => "-".repeat(widths[column])).join("  ");
	return [
		QUOTA_COLUMNS.map((column) => {
			const value = QUOTA_HEADERS[column];
			return RIGHT_ALIGNED_QUOTA_COLUMNS[column] ? value.padStart(widths[column]) : value.padEnd(widths[column]);
		}).join("  "),
		separator,
		...rows.map((row) =>
			QUOTA_COLUMNS.map((column) => {
				const value = row[column];
				return RIGHT_ALIGNED_QUOTA_COLUMNS[column] ? value.padStart(widths[column]) : value.padEnd(widths[column]);
			}).join("  "),
		),
	];
}

interface SubcommandHelp {
	/** Subcommand name (matches the switch case). */
	sub: string;
	/** Argument shape shown after the subcommand, e.g. `<profile|alias>`. */
	usage: string;
	description: string;
	example: string;
}

/** One entry per implemented subcommand — keep in sync with the switch below. */
const SUBCOMMANDS: SubcommandHelp[] = [
	{ sub: "status", usage: "", description: "当前 profile + 最近决策 + 运行模式", example: "/auto-router status" },
	{ sub: "profiles", usage: "", description: "列出全部 profile，▶ 为激活", example: "/auto-router profiles" },
	{ sub: "current", usage: "", description: "打印当前 profile 名", example: "/auto-router current" },
	{ sub: "use", usage: "<profile|alias>", description: "切换 profile（会话级持久化，resume/branch 保留）", example: "/auto-router use economy" },
	{ sub: "list", usage: "", description: "当前 profile 各 tier 的候选链", example: "/auto-router list" },
	{ sub: "show", usage: "[profile]", description: "profile 详情（tier 链 + 预算）", example: "/auto-router show premium" },
	{ sub: "explain", usage: "", description: "上次路由决策的完整推理链", example: "/auto-router explain" },
	{ sub: "doctor", usage: "", description: "能力探测矩阵 H1–H7 + 配置错误", example: "/auto-router doctor" },
	{ sub: "reload", usage: "", description: "重读 auto-router.yml 配置", example: "/auto-router reload" },
	{ sub: "budget", usage: "show|set <p> <usd> [monthly]|clear <p>", description: "per-provider 预算管理（80% 警告 / 100% 阻断）", example: "/auto-router budget set google 20 monthly" },
	{ sub: "uvi", usage: "show|enable|disable|refresh", description: "UVI 配额配速监控", example: "/auto-router uvi show" },
	{ sub: "shadow", usage: "show|enable|disable", description: "影子模式（照记决策、按配置顺序路由）", example: "/auto-router shadow enable" },
	{ sub: "rate", usage: "good|bad [comment]", description: "给上次决策打分（持久化，驱动反馈闭环）", example: "/auto-router rate good" },
	{ sub: "useage", usage: "[page]", description: "本会话 settled 调用统计 + provider 接口余量（别名 usage）", example: "/auto-router useage 2" },
	{ sub: "help", usage: "", description: "本帮助", example: "/auto-router help" },
];
/** Second-level action completions per subcommand — sync with the switch below. */
const SUBCOMMAND_ACTIONS: Record<string, Array<{ action: string; usage: string; description: string }>> = {
	budget: [
		{ action: "show", usage: "", description: "查看预算使用" },
		{ action: "set", usage: "<provider> <usd> [monthly]", description: "设置预算上限" },
		{ action: "clear", usage: "<provider> [monthly]", description: "清除预算上限" },
	],
	uvi: [
		{ action: "show", usage: "", description: "UVI 配额配速状态" },
		{ action: "enable", usage: "", description: "开启 UVI 监控" },
		{ action: "disable", usage: "", description: "关闭 UVI 监控" },
		{ action: "refresh", usage: "", description: "清空配额缓存" },
	],
	shadow: [
		{ action: "show", usage: "", description: "影子模式状态" },
		{ action: "enable", usage: "", description: "开启影子模式" },
		{ action: "disable", usage: "", description: "关闭影子模式" },
	],
	rate: [
		{ action: "good", usage: "[comment]", description: "好评上次决策" },
		{ action: "bad", usage: "[comment]", description: "差评上次决策" },
	],
};

/**
 * TUI dropdown completions for the text after `/auto-router `. Mirrors the
 * built-in declarative subcommand completer (`buildArgumentCompletions` in
 * omp's builtin-registry): subcommand names filtered by prefix, each carrying
 * its description plus the argument-shape hint; known subcommands then
 * complete their fixed action enums (`budget/uvi/shadow/rate`) and profile
 * names (`use`/`show`) one level deeper. Values keep earlier tokens and a
 * trailing space because the harness replaces the whole typed argument with
 * `item.value`.
 */
export function buildArgumentCompletions(argumentPrefix: string, deps: CommandDeps): OmpAutocompleteItem[] | null {
	const hasTrailingSpace = /\s$/.test(argumentPrefix);
	const [sub = "", ...restParts] = argumentPrefix.trimStart().split(/\s+/);
	const rest = restParts.join(" ");

	if (hasTrailingSpace || rest !== "") {
		const nested = buildNestedCompletions(sub, rest, deps);
		if (nested) return nested;
		// Known subcommand with no argument completion — nothing to offer here.
		if (SUBCOMMANDS.some((s) => s.sub === sub)) return null;
	}
	return buildSubcommandItems(sub);
}

function buildSubcommandItems(prefix: string): OmpAutocompleteItem[] | null {
	const lower = prefix.toLowerCase();
	const items = SUBCOMMANDS.filter((s) => s.sub.startsWith(lower)).map((s) => ({
		value: `${s.sub} `,
		label: s.sub,
		description: s.description,
		...(s.usage ? { hint: s.usage } : {}),
	}));
	return items.length > 0 ? items : null;
}

function buildNestedCompletions(sub: string, rest: string, deps: CommandDeps): OmpAutocompleteItem[] | null {
	const [token = "", ...tail] = rest.split(/\s+/);
	if (tail.length > 0) return null; // past the action token — no completion

	if (sub === "use" || sub === "show") {
		const profiles = deps.getState()?.registry.list() ?? [];
		const items = profiles
			.filter((p) => p.name.startsWith(token.toLowerCase()))
			.map((p) => ({
				value: `${sub} ${p.name} `,
				label: p.name,
				...(p.description ? { description: p.description } : {}),
				...(p.isActive ? { hint: "当前激活" } : {}),
			}));
		return items.length > 0 ? items : null;
	}

	const actions = SUBCOMMAND_ACTIONS[sub];
	if (!actions) return null;
	const items = actions
		.filter((a) => a.action.startsWith(token.toLowerCase()))
		.map((a) => ({
			value: `${sub} ${a.action} `,
			label: a.action,
			description: a.description,
			...(a.usage ? { hint: a.usage } : {}),
		}));
	return items.length > 0 ? items : null;
}

function runHelp(): string {
	return lines([
		"omp-auto-router — profile/复杂度自动路由控制",
		"",
		...SUBCOMMANDS.map((c) => {
			const usage = c.usage ? ` ${c.usage}` : "";
			return `  /auto-router ${c.sub}${usage} — ${c.description}（例: ${c.example}）`;
		}),
		"",
		"请求内钉层: @fast / @swe / @reasoning / @long / @vision / @profile:<name>",
	]);
}

/**
 * Active profile for display: the session's current auto-router model wins
 * (that is what actually routes — switching via /model bypasses the
 * registry); fall back to the registry (config.active / path activation).
 */
function activeProfileName(state: AdapterState): string {
	const current = state.ctx?.models.current();
	if (current?.provider === "auto-router" && state.registry.profile(current.id) !== undefined) {
		return current.id;
	}
	return state.registry.current();
}

async function runCommand(rawArgs: string, deps: CommandDeps, ctx: OmpExtensionContext): Promise<void> {
	const [sub, ...rest] = rawArgs.trim().split(/\s+/);
	const arg = rest.join(" ");
	const state = deps.getState();
	const { pi } = deps;

	if (!state) {
		ctx.ui.notify("auto-router not ready yet (session still booting) — try again in a moment", "warning");
		return;
	}

	switch (sub ?? "") {
		case "":
		case "status": {
			const activeName = activeProfileName(state);
			const active = { name: activeName, profile: state.registry.profile(activeName)! };
			const last = state.lastDecision;
			ctx.ui.notify(
				lines([
					`profile: ${active.name}${active.profile.description ? ` (${active.profile.description})` : ""}`,
					last
						? `last: ${last.decision.tier} → ${last.decision.target.provider}/${last.decision.target.model}${last.decision.thinking !== undefined ? ` (thinking=${last.decision.thinking})` : ""} (${new Date(last.at).toLocaleTimeString()})`
						: "last: —",
					`mode: A (stream delegation)`,
				]),
				"info",
			);
			return;
		}
		case "profiles": {
			const activeName = activeProfileName(state);
			ctx.ui.notify(
				lines(
					state.registry
						.list()
						.map((p) => `${p.name === activeName ? "▶" : " "} ${p.name}${p.description ? ` — ${p.description}` : ""}`),
				),
				"info",
			);
			return;
		}
		case "current": {
			ctx.ui.notify(activeProfileName(state), "info");
			return;
		}
		case "use": {
			if (!arg) {
				ctx.ui.notify("usage: /auto-router use <profile|alias>", "warning");
				return;
			}
			const name = state.registry.resolveAlias(arg) ?? arg;
			if (!state.registry.profile(name)) {
				ctx.ui.notify(`unknown profile: ${arg}`, "error");
				return;
			}
			// Profile = virtual model: switch the session model to auto-router/<name>.
			const key = `auto-router/${name}`;
			const ok = await pi.setModel({
				provider: "auto-router",
				id: name,
				api: "auto-router",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
			});
			if (!ok) {
				ctx.ui.notify(`model switch to ${key} failed`, "error");
				return;
			}
			state.registry.switch(name);
			pi.appendEntry("com.omp.auto-router.state", { profile: name });
			state.eventLog.append({ type: "profile-switch", at: Date.now(), profile: name });
			ctx.ui.notify(`switched to profile: ${name}`, "info");
			return;
		}
		case "list": {
			const profile = state.registry.profile(activeProfileName(state))!;
			const rows: string[] = [];
			for (const [tier, tierCfg] of Object.entries(profile.tiers)) {
				const targets = tierCfg.targets
					.map((t) => `${t.provider}/${t.model}`)
					.join(", ");
				rows.push(`${tier} (thinking=${tierCfg.thinking ?? "—"}): ${targets}`);
			}
			ctx.ui.notify(lines(rows), "info");
			return;
		}
		case "show": {
			const target = arg || activeProfileName(state);
			const profile = state.registry.profile(target);
			if (!profile) {
				ctx.ui.notify(`unknown profile: ${target}`, "error");
				return;
			}
			ctx.ui.notify(
				lines([
					`${target}${profile.description ? ` — ${profile.description}` : ""}`,
					`defaultTier: ${profile.defaultTier ?? "standard"}`,
					...Object.entries(profile.tiers).flatMap(([tier, tierCfg]) => [
						`${tier} (thinking=${tierCfg.thinking ?? "—"}):`,
						...tierCfg.targets.map((t) => `  - ${t.provider}/${t.model}${t.billing === "per-token" ? " (per-token)" : ""}`),
					]),
					...(profile.budgets
						? ["budgets:", ...Object.entries(profile.budgets).map(([p, b]) => `  - ${p}: $${b.amount}${b.monthly ? " monthly" : " daily"}`)]
						: []),
				]),
				"info",
			);
			return;
		}
		case "explain": {
			const last = state.lastDecision;
			if (!last) {
				ctx.ui.notify("no routing decision yet", "info");
				return;
			}
			ctx.ui.notify(
				lines([
					`profile=${last.decision.profile} tier=${last.decision.tier} (conf ${last.decision.confidence.toFixed(2)})`,
					`target: ${last.decision.target.provider}/${last.decision.target.model}`,
					`chain: ${last.decision.orderedCandidates.map((t) => `${t.provider}/${t.model}`).join(" → ")}`,
					`tokens≈${last.decision.estimatedTokens}`,
					...last.decision.orderedCandidates.map((t) => {
						const stats = state.ratings.statsFor(t.provider, t.model);
						return stats.total > 0
							? `ratings ${t.provider}/${t.model}: ${stats.good}👍/${stats.bad}👎 (${(stats.goodFraction * 100).toFixed(0)}% good)`
							: `ratings ${t.provider}/${t.model}: none yet`;
					}),
					...last.decision.reasoning.map((r) => `· ${r}`),
				]),
				"info",
			);
			return;
		}
		case "doctor": {
			ctx.ui.notify(runDoctor(state), "info");
			return;
		}
		case "reload": {
			const errors = await deps.reloadConfig();
			ctx.ui.notify(
				lines(["config reloaded", ...(errors.length > 0 ? [`warnings: ${errors.join("; ")}`] : [])]),
				errors.length > 0 ? "warning" : "info",
			);
			return;
		}
		case "budget": {
			const [action, provider, amount, period] = arg.trim().split(/\s+/);
			if (action === "show" || action === undefined) {
				const limits = state.budgets.limits();
				const rows = Object.entries(limits).map(([p, limit]) => {
					const usage = state.budgets.usage(p, new Date());
					const spent = (limit.monthly ? usage.monthly?.cost : usage.daily?.cost) ?? 0;
					const pct = limit.amount > 0 ? ((spent / limit.amount) * 100).toFixed(0) : "0";
					return `${p}: $${spent.toFixed(2)} / $${limit.amount} (${pct}%) ${limit.monthly ? "monthly" : "daily"}`;
				});
				ctx.ui.notify(lines(rows.length > 0 ? rows : ["no budgets configured — /auto-router budget set <provider> <amount> [monthly]"]), "info");
				return;
			}
			if (action === "set") {
				if (!provider || !amount || !/^\d+(\.\d+)?$/.test(amount)) {
					ctx.ui.notify("usage: /auto-router budget set <provider> <usd> [monthly]", "warning");
					return;
				}
				state.budgets.setLimit(provider, { amount: Number(amount), monthly: period === "monthly" });
				ctx.ui.notify(`budget set: ${provider} $${amount}${period === "monthly" ? " monthly" : " daily"}`, "info");
				return;
			}
			if (action === "clear") {
				if (!provider) {
					ctx.ui.notify("usage: /auto-router budget clear <provider> [monthly]", "warning");
					return;
				}
				state.budgets.clearLimit(provider, period === "monthly" ? true : undefined);
				ctx.ui.notify(`budget cleared: ${provider}`, "info");
				return;
			}
			ctx.ui.notify("unknown budget action — show | set <p> <usd> [monthly] | clear <p> [monthly]", "warning");
			return;
		}
		case "uvi": {
			const [action] = arg.trim().split(/\s+/);
			if (action === "disable") {
				state.uviEnabled = false;
				ctx.ui.notify("UVI monitoring disabled", "info");
				return;
			}
			if (action === "enable") {
				state.uviEnabled = true;
				ctx.ui.notify("UVI monitoring enabled", "info");
				return;
			}
			if (action === "refresh") {
				state.quotaCache = { at: 0, data: [] };
				ctx.ui.notify("quota cache cleared — next request refetches", "info");
				return;
			}
			const last = state.lastDecision;
			const rows = last
				? Object.entries((last.decision.hints?.uvi ?? {}) as Record<string, { uvi: number; status: string }>).map(
						([provider, r]) => `${provider}: UVI=${r.uvi.toFixed(2)} ${r.status}`,
					)
				: [];
			ctx.ui.notify(
				lines([
					`UVI ${state.uviEnabled ? "enabled" : "disabled"}`,
					...(rows.length > 0 ? rows : ["no quota data yet — run a request first"]),
				]),
				"info",
			);
			return;
		}
		case "shadow": {
			const [action] = arg.trim().split(/\s+/);
			if (action === "enable") {
				state.shadowEnabled = true;
				ctx.ui.notify("shadow mode enabled — routing in config order, decisions logged", "info");
				return;
			}
			if (action === "disable") {
				state.shadowEnabled = false;
				ctx.ui.notify("shadow mode disabled", "info");
				return;
			}
			ctx.ui.notify(`shadow mode: ${state.shadowEnabled ? "🟢 enabled" : "off"}`, "info");
			return;
		}
		case "rate": {
			const [rating, ...commentParts] = arg.trim().split(/\s+/);
			if (rating !== "good" && rating !== "bad") {
				ctx.ui.notify("usage: /auto-router rate good|bad [comment]", "warning");
				return;
			}
			const last = state.lastDecision;
			if (!last) {
				ctx.ui.notify("no decision to rate yet", "warning");
				return;
			}
			state.ratings.rate({
				rating,
				...(commentParts.length > 0 ? { comment: commentParts.join(" ") } : {}),
				provider: last.decision.target.provider,
				model: last.decision.target.model,
				profile: last.decision.profile,
				tier: last.decision.tier,
			});
			const stats = state.ratings.statsFor(last.decision.target.provider, last.decision.target.model);
			ctx.ui.notify(
				`rated ${rating} — ${last.decision.target.provider}/${last.decision.target.model} (${stats.total} total, ${Math.round(stats.goodFraction * 100)}% good)`,
				"info",
			);
			return;
		}
		case "useage":
		case "usage": {
			const page = Math.max(1, Number(arg.trim()) || 1);
			const pageSize = 8;
			const calls = [...state.sessionUseage.calls.entries()].sort((a, b) => b[1] - a[1]);
			const totalPages = Math.max(1, Math.ceil(calls.length / pageSize));
			const currentPage = Math.min(page, totalPages);
			const slice = calls.slice((currentPage - 1) * pageSize, currentPage * pageSize);

			// Per-provider session cost rollup
			const providerCost = new Map<string, number>();
			for (const [key, cost] of state.sessionUseage.cost) {
				const provider = key.split("/")[0] ?? key;
				providerCost.set(provider, (providerCost.get(provider) ?? 0) + cost);
			}

			const targets = getConfiguredTargets(state);
			const providers = getConfiguredProviders(state);
			const refreshQuota = providers.length > 0 && (state.quotaCache.data.length === 0 || Date.now() - state.quotaCache.at > quotaRefreshMs());
			// Balance-capable providers: registry default (deepseek) plus any
			// target-level `balanceEndpoint` override from the config.
			const balanceProviders = providers.filter((provider) => resolveBalanceEndpoint(provider, targets) !== undefined);
			const [quota, ...fetchedBalances] = await Promise.all([
				refreshQuota ? createHostPorts(pi, ctx, state).fetchQuota(providers) : Promise.resolve(state.quotaCache.data),
				...balanceProviders.map((provider) =>
					fetchProviderBalance(ctx, state, provider, resolveBalanceEndpoint(provider, targets) ?? ""),
				),
			]);
			if (refreshQuota) state.quotaCache = { at: Date.now(), data: quota };
			const balances = new Map<string, ProviderBalance | undefined>(
				balanceProviders.map((provider, index) => [provider, fetchedBalances[index]]),
			);

			const modelRows = slice.map(([key, count]) => {
				const cost = state.sessionUseage.cost.get(key) ?? 0;
				const thinking = state.sessionUseage.thinking.get(key);
				const thinkingSuffix =
					thinking && thinking.size > 0
						? ` [${[...thinking].sort().join(", ")}]`
						: "";
				return `${key}: ${count}x $${cost.toFixed(4)}${thinkingSuffix}`;
			});
			const providerCostRows = [...providerCost.entries()].map(
				([provider, cost]) => `${provider}: $${cost.toFixed(4)} (session)`,
			);
			const quotaRows = formatQuotaTable(quota, balances, formatReset);

			ctx.ui.notify(
				lines([
					`usage — page ${currentPage}/${totalPages}${state.shadowEnabled ? " (shadow mode: counting paused)" : ""}`,
					"",
					...(modelRows.length > 0 ? modelRows : ["no settled calls yet this session"]),
					"",
					...providerCostRows,
					...(quotaRows.length > 2 ? ["", "provider quota:", ...quotaRows] : ["", "provider quota: no data from host interface"]),
					...(totalPages > 1 ? ["", `Page ${currentPage}/${totalPages} — /auto-router useage ${currentPage + 1} for next`] : []),
				]),
				"info",
			);
			return;
		}
		case "help": {
			ctx.ui.notify(runHelp(), "info");
			return;
		}
		default:
			ctx.ui.notify(`unknown subcommand: ${sub} — run /auto-router help for usage`, "warning");
			return;
	}
}

/** Capability-probe matrix (H1..H7 from the design doc). */
export function runDoctor(state: AdapterState): string {
	const checks: Array<[string, boolean, string]> = [
		["H1 registerProvider/stream", state.doctorProbes.registerProvider, "virtual provider + stream delegation"],
		["H2 ctx.models", state.doctorProbes.models, `${state.modelsByKey.size} models indexed`],
		["H3 setModel/thinking", state.doctorProbes.setModel, "model + thinking switching"],
		["H4 retry events", state.doctorProbes.retryEvents, "auto_retry_* observers"],
		["H5 appendEntry", state.doctorProbes.appendEntry, "session state persistence"],
		["H6 ui notify/status", state.doctorProbes.ui, "status line + notifications"],
		["H7 authStorage quota", state.doctorProbes.quota, "fetchUsageReports → UVI"],
	];
	return lines([
		"auto-router doctor",
		...(state.configErrors.length > 0 ? [`config errors: ${state.configErrors.join("; ")}`] : []),
		...checks.map(([id, ok, desc]) => `${ok ? "✅" : "⚠️"} ${id} — ${desc}`),
		`mode: A`,
	]);
}
