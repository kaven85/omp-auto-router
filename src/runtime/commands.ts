/**
 * Host-neutral `/auto-router` command interpreter.
 *
 * One implementation of the command group serves both adapters: behavior
 * (budgets, rules, ratings, usage, quota table, completions) lives here;
 * adapters only supply the host mapping (notify, model switching, reload,
 * capability rows, authenticated quota/balance fetch). Hosts without usage
 * reports (Pi) report an explicit UVI degradation instead of empty quota
 * pretending to be unused quota.
 */

import type { QuotaSnapshot, QuotaWindow, RouteTarget } from "../core/types";
import {
	baseClassifierList,
	CLASSIFIER_LIST_META,
	CLASSIFIER_LIST_NAMES,
	overridesEmpty,
	type ClassifierListName,
	type ClassifierOverrides,
} from "../core/complexity-classifier";
import type { RouterRuntimeState } from "./router-runtime";
import { quotaRefreshMs } from "./env";
import {
	PROVIDER_DISPLAY_ORDER,
	PROVIDER_REGISTRY,
	resolveBalanceEndpoint,
	type ProviderBalance,
} from "./provider-dictionary";

/** Dropdown row for argument completion; both hosts consume this shape. */
export interface RouterCompletionItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

export type NotifyLevel = "info" | "warning" | "error";

/**
 * Host mapping for the shared command interpreter. Credentials never cross
 * this boundary: quota and balance are returned as parsed snapshots by the
 * adapter's authenticated operations.
 */
export interface RouterCommandHost {
	/** Display name of the active host ("OMP" | "Pi") for the doctor header. */
	hostName: string;
	notify(message: string, level: NotifyLevel): void;
	/** Virtual profile the host's current model routes through, if any. */
	activeVirtualProfile(): string | undefined;
	/** Switch the session model to the registered virtual profile model. */
	setVirtualProfile(name: string): Promise<boolean>;
	/** Persist the profile-switch marker entry in the session branch. */
	appendProfileSwitch(name: string): void;
	/** Reload configuration layers; returns non-fatal warnings/errors. */
	reloadConfig(): Promise<string[]>;
	/** Host capability rows for the doctor (❌ required failure, ⚠️ optional degradation). */
	doctorLines(): string[];
	/** Whether the host exposes usage-plan quota reports (UVI data source). */
	quotaAvailable(): boolean;
	/** Authenticated quota fetch; present only when quotaAvailable() is true. */
	fetchQuota?(providers: string[]): Promise<QuotaSnapshot[]>;
	/** Authenticated prepaid-balance fetch against a resolved endpoint. */
	fetchBalance?(provider: string, endpoint: string): Promise<ProviderBalance | undefined>;
	/** Persist classifier keyword overrides after a rules edit. */
	persistClassifierOverrides(): void;
}

/** Collect every target configured across every profile (all tiers). */
function getConfiguredTargets(state: RouterRuntimeState): RouteTarget[] {
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
	sub: string;
	usage: string;
	description: string;
	example: string;
}

/** One entry per implemented subcommand — keep in sync with the switch below. */
export const SUBCOMMANDS: SubcommandHelp[] = [
	{ sub: "status", usage: "", description: "当前 profile + 最近决策 + 运行模式", example: "/auto-router status" },
	{ sub: "profiles", usage: "", description: "列出全部 profile，▶ 为激活", example: "/auto-router profiles" },
	{ sub: "current", usage: "", description: "打印当前 profile 名", example: "/auto-router current" },
	{ sub: "use", usage: "<profile|alias>", description: "切换 profile（会话级持久化，resume/branch 保留）", example: "/auto-router use economy" },
	{ sub: "list", usage: "", description: "当前 profile 各 tier 的候选链", example: "/auto-router list" },
	{ sub: "show", usage: "[profile]", description: "profile 详情（tier 链 + 预算）", example: "/auto-router show premium" },
	{ sub: "explain", usage: "", description: "上次路由决策的完整推理链", example: "/auto-router explain" },
	{ sub: "doctor", usage: "", description: "宿主能力探测 + 配置错误与降级", example: "/auto-router doctor" },
	{ sub: "reload", usage: "", description: "重读 auto-router.yml 配置", example: "/auto-router reload" },
	{ sub: "budget", usage: "show|set <p> <usd> [monthly]|clear <p>", description: "per-provider 预算管理（80% 警告 / 100% 阻断）", example: "/auto-router budget set google 20 monthly" },
	{ sub: "uvi", usage: "show|enable|disable|refresh", description: "UVI 配额配速监控（宿主不支持时显式降级）", example: "/auto-router uvi show" },
	{ sub: "shadow", usage: "show|enable|disable", description: "影子模式（照记决策、按配置顺序路由）", example: "/auto-router shadow enable" },
	{ sub: "rate", usage: "good|bad [comment]", description: "给上次决策打分（持久化，驱动反馈闭环）", example: "/auto-router rate good" },
	{ sub: "rules", usage: "[show]|add|remove <list> <词…>|reset", description: "查看/编辑复杂度判定规则（trivial/simple/standard/complex）", example: "/auto-router rules add mechanicalOp 同步数据" },
	{ sub: "usage", usage: "[page]", description: "本会话 settled 调用统计 + provider 接口余量（旧名 useage 仍可用）", example: "/auto-router usage 2" },
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
	rules: [
		{ action: "show", usage: "", description: "查看全部判定规则" },
		{ action: "add", usage: "<list> <关键词…>", description: "向指定列表添加关键词" },
		{ action: "remove", usage: "<list> <关键词…>", description: "从指定列表移除关键词（含内置）" },
		{ action: "reset", usage: "", description: "清空全部自定义覆盖，还原内置" },
	],
};

/**
 * Dropdown completions for the text after `/auto-router `. Mirrors the
 * host's declarative subcommand completer: subcommand names filtered by
 * prefix, each carrying its description plus the argument-shape hint; known
 * subcommands then complete their fixed action enums (`budget/uvi/shadow/
 * rate/rules`) and profile names (`use`/`show`) one level deeper. Values keep
 * earlier tokens and a trailing space because the harness replaces the whole
 * typed argument with `item.value`.
 */
export function buildRouterCompletions(argumentPrefix: string, state: RouterRuntimeState | undefined): RouterCompletionItem[] | null {
	const hasTrailingSpace = /\s$/.test(argumentPrefix);
	const [sub = "", ...restParts] = argumentPrefix.trimStart().split(/\s+/);
	const rest = restParts.join(" ");

	if (hasTrailingSpace || rest !== "") {
		const nested = buildNestedCompletions(sub, rest, state);
		if (nested) return nested;
		// Known subcommand with no argument completion — nothing to offer here.
		if (SUBCOMMANDS.some((s) => s.sub === sub)) return null;
	}
	const lower = sub.toLowerCase();
	const items = SUBCOMMANDS.filter((s) => s.sub.startsWith(lower)).map((s) => ({
		value: `${s.sub} `,
		label: s.sub,
		description: s.description,
		...(s.usage ? { hint: s.usage } : {}),
	}));
	return items.length > 0 ? items : null;
}

function buildNestedCompletions(sub: string, rest: string, state: RouterRuntimeState | undefined): RouterCompletionItem[] | null {
	const [token = "", ...tail] = rest.split(/\s+/);

	// rules add/remove <list>: complete the editable list name one level deeper.
	if (sub === "rules" && (token === "add" || token === "remove") && tail.length === 1) {
		const prefix = tail[0]!.toLowerCase();
		const items = CLASSIFIER_LIST_NAMES.filter((n) => n.startsWith(prefix)).map((n) => ({
			value: `rules ${token} ${n} `,
			label: n,
			description: CLASSIFIER_LIST_META[n].description,
			hint: `→ ${CLASSIFIER_LIST_META[n].tier} (${CLASSIFIER_LIST_META[n].match})`,
		}));
		return items.length > 0 ? items : null;
	}

	if (tail.length > 0) return null; // past the action token — no completion

	if (sub === "use" || sub === "show") {
		const profiles = state?.registry.list() ?? [];
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
	return [
		"omp-auto-router — profile/复杂度自动路由控制",
		"",
		...SUBCOMMANDS.map((c) => {
			const usage = c.usage ? ` ${c.usage}` : "";
			return `  /auto-router ${c.sub}${usage} — ${c.description}（例: ${c.example}）`;
		}),
		"",
		"请求内钉层: @fast / @swe / @reasoning / @long / @vision / @profile:<name>",
	].join("\n");
}

/**
 * Active profile for display: the session's current auto-router model wins
 * (that is what actually routes — switching via /model bypasses the
 * registry); fall back to the registry (config.active / path activation).
 */
function activeProfileName(state: RouterRuntimeState, host: RouterCommandHost): string {
	const virtual = host.activeVirtualProfile();
	if (virtual !== undefined && state.registry.profile(virtual) !== undefined) return virtual;
	return state.registry.current();
}

/**
 * Render the full complexity-classification rule surface: the five editable
 * keyword lists (effective = builtin ± user overrides, additions marked `+`,
 * removals hidden and counted) plus the fixed structural signals.
 */
export function formatClassifierRules(overrides: ClassifierOverrides | undefined): string {
	const out: string[] = ["复杂度判定规则（trivial < simple < standard < complex，权重高者胜，平局取更高 tier）", ""];
	for (const name of CLASSIFIER_LIST_NAMES) {
		const meta = CLASSIFIER_LIST_META[name];
		const removed = new Set((overrides?.remove?.[name] ?? []).map((k) => k.toLowerCase()));
		const builtin = baseClassifierList(name).filter((k) => !removed.has(k.toLowerCase()));
		const added = overrides?.add?.[name] ?? [];
		out.push(`→ ${meta.tier}  ${name}  [${meta.match}, 权重 ${meta.weight}] ${meta.description}`);
		out.push(`  ${[...builtin, ...added.map((k) => `${k} (+)`)].join(", ")}`);
	}
	out.push(
		"",
		"内置信号（不可编辑）:",
		"  context 大小: <4k→trivial(w1) · 4k–32k→simple(w1) · 32k–100k→standard(w2) · ≥100k→complex(w3)",
		"  code signals（文件路径/diff/stack-trace）→standard(w2) · code/analysis intent→standard(w1.5)",
		"  拆分分析：按 并/然后/接着/再/and/then/句末标点 拆阶段，首阶段定层——设计并实现 X→complex（先设计），实现 X 然后设计 Y→standard（先实现），后续阶段轮到各自请求时再判；硬词（重构/迁移/架构/跨文件、refactor/migrate）只在首阶段内计数",
		"  short Q&A（general intent, <200 tokens）→trivial(w1.5) · 图片输入→至少 simple(w1)",
		"  sticky escalation: 会话内只升不降 · 钉层: @fast→simple @swe→standard @reasoning→complex",
	);
	if (overrides && !overridesEmpty(overrides)) {
		const count = (m?: Partial<Record<ClassifierListName, string[]>>) =>
			CLASSIFIER_LIST_NAMES.reduce((n, name) => n + (m?.[name]?.length ?? 0), 0);
		out.push("", `overrides: +${count(overrides.add)} 添加 / −${count(overrides.remove)} 移除（/auto-router rules reset 还原内置）`);
	}
	out.push("", "编辑: /auto-router rules add|remove <list> <关键词…>");
	return out.join("\n");
}

/**
 * Apply one add/remove edit to the classifier overrides, in place on state.
 * Adding back a removed builtin cancels the removal; removing a user-added
 * keyword drops the addition. Returns changed/skipped keywords for feedback.
 */
export function applyRulesEdit(
	state: RouterRuntimeState,
	action: "add" | "remove",
	name: ClassifierListName,
	keywords: string[],
): { changed: string[]; skipped: string[] } {
	const overrides = state.classifierOverrides ?? {};
	const addList = [...(overrides.add?.[name] ?? [])];
	const removeList = [...(overrides.remove?.[name] ?? [])];
	const inBase = new Set(baseClassifierList(name).map((k) => k.toLowerCase()));
	const changed: string[] = [];
	const skipped: string[] = [];
	for (const keyword of keywords) {
		const k = keyword.toLowerCase();
		if (action === "add") {
			const ri = removeList.findIndex((x) => x.toLowerCase() === k);
			if (ri >= 0) {
				removeList.splice(ri, 1); // re-activate a removed builtin
				changed.push(keyword);
			} else if (inBase.has(k) || addList.some((x) => x.toLowerCase() === k)) {
				skipped.push(keyword);
			} else {
				addList.push(keyword);
				changed.push(keyword);
			}
		} else {
			const ai = addList.findIndex((x) => x.toLowerCase() === k);
			if (ai >= 0) {
				addList.splice(ai, 1); // drop a user addition
				changed.push(keyword);
			} else if (inBase.has(k) && !removeList.some((x) => x.toLowerCase() === k)) {
				removeList.push(keyword);
				changed.push(keyword);
			} else {
				skipped.push(keyword);
			}
		}
	}
	state.classifierOverrides = {
		add: { ...(overrides.add ?? {}), [name]: addList },
		remove: { ...(overrides.remove ?? {}), [name]: removeList },
	};
	return { changed, skipped };
}

function lines(items: (string | undefined)[]): string {
	return items.filter((item): item is string => item !== undefined).join("\n");
}

/** Explicit degradation notice when the host cannot report usage-plan quota. */
export function uviUnavailableNotice(hostName: string): string {
	return `UVI usage reports: unavailable through ${hostName} public interface — local budgets, balances, ratings and failover remain enabled.`;
}

async function runUsage(arg: string, state: RouterRuntimeState, host: RouterCommandHost): Promise<void> {
	const page = Math.max(1, Number(arg.trim()) || 1);
	const pageSize = 8;
	const calls = [...state.sessionUsage.calls.entries()].sort((a, b) => b[1] - a[1]);
	const totalPages = Math.max(1, Math.ceil(calls.length / pageSize));
	const currentPage = Math.min(page, totalPages);
	const slice = calls.slice((currentPage - 1) * pageSize, currentPage * pageSize);

	// Per-provider session cost rollup
	const providerCost = new Map<string, number>();
	for (const [key, cost] of state.sessionUsage.cost) {
		const provider = key.split("/")[0] ?? key;
		providerCost.set(provider, (providerCost.get(provider) ?? 0) + cost);
	}

	const targets = getConfiguredTargets(state);
	const providers = [...new Set(targets.map((target) => target.provider))].sort();
	const cache = state.quotaCache ?? { at: 0, data: [] };
	const refreshQuota = host.fetchQuota !== undefined && providers.length > 0 && (cache.data.length === 0 || Date.now() - cache.at > quotaRefreshMs());
	// Balance-capable providers: registry default (deepseek) plus any
	// target-level `balanceEndpoint` override from the config.
	const balanceProviders = host.fetchBalance === undefined
		? []
		: providers.filter((provider) => resolveBalanceEndpoint(provider, targets) !== undefined);
	const [quota, ...fetchedBalances] = await Promise.all([
		refreshQuota && host.fetchQuota ? host.fetchQuota(providers) : Promise.resolve(cache.data),
		...balanceProviders.map((provider) =>
			host.fetchBalance!(provider, resolveBalanceEndpoint(provider, targets) ?? ""),
		),
	]);
	if (refreshQuota) state.quotaCache = { at: Date.now(), data: quota };
	const balances = new Map<string, ProviderBalance | undefined>(
		balanceProviders.map((provider, index) => [provider, fetchedBalances[index]]),
	);
	// Mirror fetched balances into the widget cache so both surfaces
	// stay consistent without a redundant balance API call.
	for (const [provider, balance] of balances) {
		if (balance !== undefined) (state.balanceCache ??= {})[provider] = balance;
	}

	const modelRows = slice.map(([key, count]) => {
		const cost = state.sessionUsage.cost.get(key) ?? 0;
		const thinking = state.sessionUsage.thinking.get(key);
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

	host.notify(
		lines([
			`usage — page ${currentPage}/${totalPages}${state.shadowEnabled ? " (shadow mode: counting paused)" : ""}`,
			"",
			...(modelRows.length > 0 ? modelRows : ["no settled calls yet this session"]),
			"",
			...providerCostRows,
			...(quotaRows.length > 2 ? ["", "provider quota:", ...quotaRows] : ["", "provider quota: no data from host interface"]),
			...(host.quotaAvailable() ? [] : ["", uviUnavailableNotice(host.hostName)]),
			...(totalPages > 1 ? ["", `Page ${currentPage}/${totalPages} — /auto-router usage ${currentPage + 1} for next`] : []),
		]),
		"info",
	);
}

/**
 * Execute one `/auto-router` invocation against the shared behavior. Host
 * differences (model switching, reload, quota capability, authenticated
 * fetch) arrive through `host`; routing state lives in `state`.
 */
export async function runRouterCommand(rawArgs: string, state: RouterRuntimeState, host: RouterCommandHost): Promise<void> {
	const [sub, ...rest] = rawArgs.trim().split(/\s+/);
	const arg = rest.join(" ");

	switch (sub ?? "") {
		case "":
		case "status": {
			const activeName = activeProfileName(state, host);
			const active = { name: activeName, profile: state.registry.profile(activeName)! };
			const last = state.lastDecision;
			host.notify(
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
			const activeName = activeProfileName(state, host);
			host.notify(
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
			host.notify(activeProfileName(state, host), "info");
			return;
		}
		case "use": {
			if (!arg) {
				host.notify("usage: /auto-router use <profile|alias>", "warning");
				return;
			}
			const name = state.registry.resolveAlias(arg) ?? arg;
			if (!state.registry.profile(name)) {
				host.notify(`unknown profile: ${arg}`, "error");
				return;
			}
			// Profile = virtual model: switch the session model to auto-router/<name>.
			const ok = await host.setVirtualProfile(name);
			if (!ok) {
				host.notify(`model switch to auto-router/${name} failed`, "error");
				return;
			}
			state.registry.switch(name);
			host.appendProfileSwitch(name);
			state.eventLog.append({ type: "profile-switch", at: Date.now(), profile: name });
			host.notify(`switched to profile: ${name}`, "info");
			return;
		}
		case "list": {
			const profile = state.registry.profile(activeProfileName(state, host))!;
			const rows: string[] = [];
			for (const [tier, tierCfg] of Object.entries(profile.tiers)) {
				const targets = tierCfg.targets
					.map((t) => `${t.provider}/${t.model}`)
					.join(", ");
				rows.push(`${tier} (thinking=${tierCfg.thinking ?? "—"}): ${targets}`);
			}
			host.notify(lines(rows), "info");
			return;
		}
		case "show": {
			const target = arg || activeProfileName(state, host);
			const profile = state.registry.profile(target);
			if (!profile) {
				host.notify(`unknown profile: ${target}`, "error");
				return;
			}
			host.notify(
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
				host.notify("no routing decision yet", "info");
				return;
			}
			host.notify(
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
			host.notify(
				lines([
					`auto-router doctor${host.hostName === "OMP" ? "" : ` (${host.hostName})`}`,
					...(state.configErrors && state.configErrors.length > 0 ? [`config errors: ${state.configErrors.join("; ")}`] : []),
					...host.doctorLines(),
					`mode: A`,
				]),
				"info",
			);
			return;
		}
		case "reload": {
			const errors = await host.reloadConfig();
			host.notify(
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
				host.notify(lines(rows.length > 0 ? rows : ["no budgets configured — /auto-router budget set <provider> <amount> [monthly]"]), "info");
				return;
			}
			if (action === "set") {
				if (!provider || !amount || !/^\d+(\.\d+)?$/.test(amount)) {
					host.notify("usage: /auto-router budget set <provider> <usd> [monthly]", "warning");
					return;
				}
				state.budgets.setLimit(provider, { amount: Number(amount), monthly: period === "monthly" });
				host.notify(`budget set: ${provider} $${amount}${period === "monthly" ? " monthly" : " daily"}`, "info");
				return;
			}
			if (action === "clear") {
				if (!provider) {
					host.notify("usage: /auto-router budget clear <provider> [monthly]", "warning");
					return;
				}
				state.budgets.clearLimit(provider, period === "monthly" ? true : undefined);
				host.notify(`budget cleared: ${provider}`, "info");
				return;
			}
			host.notify("unknown budget action — show | set <p> <usd> [monthly] | clear <p> [monthly]", "warning");
			return;
		}
		case "uvi": {
			const [action] = arg.trim().split(/\s+/);
			if (!host.quotaAvailable()) {
				host.notify(uviUnavailableNotice(host.hostName), "warning");
				return;
			}
			if (action === "disable") {
				state.uviEnabled = false;
				host.notify("UVI monitoring disabled", "info");
				return;
			}
			if (action === "enable") {
				state.uviEnabled = true;
				host.notify("UVI monitoring enabled", "info");
				return;
			}
			if (action === "refresh") {
				state.quotaCache = { at: 0, data: [] };
				host.notify("quota cache cleared — next request refetches", "info");
				return;
			}
			const last = state.lastDecision;
			const rows = last
				? Object.entries((last.decision.hints?.uvi ?? {}) as Record<string, { uvi: number; status: string }>).map(
						([provider, r]) => `${provider}: UVI=${r.uvi.toFixed(2)} ${r.status}`,
					)
				: [];
			host.notify(
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
				host.notify("shadow mode enabled — routing in config order, decisions logged", "info");
				return;
			}
			if (action === "disable") {
				state.shadowEnabled = false;
				host.notify("shadow mode disabled", "info");
				return;
			}
			host.notify(`shadow mode: ${state.shadowEnabled ? "🟢 enabled" : "off"}`, "info");
			return;
		}
		case "rate": {
			const [rating, ...commentParts] = arg.trim().split(/\s+/);
			if (rating !== "good" && rating !== "bad") {
				host.notify("usage: /auto-router rate good|bad [comment]", "warning");
				return;
			}
			const last = state.lastDecision;
			if (!last) {
				host.notify("no decision to rate yet", "warning");
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
			host.notify(
				`rated ${rating} — ${last.decision.target.provider}/${last.decision.target.model} (${stats.total} total, ${Math.round(stats.goodFraction * 100)}% good)`,
				"info",
			);
			return;
		}
		case "usage":
		case "useage": {
			await runUsage(arg, state, host);
			return;
		}
		case "rules": {
			const [action = "", ...ruleArgs] = arg.trim().split(/\s+/).filter((s) => s.length > 0);
			if (action === "" || action === "show") {
				host.notify(formatClassifierRules(state.classifierOverrides), "info");
				return;
			}
			if (action === "reset") {
				state.classifierOverrides = {};
				host.persistClassifierOverrides();
				host.notify("classifier rules reset — 已还原为内置判定规则", "info");
				return;
			}
			if (action === "add" || action === "remove") {
				const [listName, ...keywords] = ruleArgs;
				if (!listName || keywords.length === 0 || !(CLASSIFIER_LIST_NAMES as readonly string[]).includes(listName)) {
					host.notify(
						`usage: /auto-router rules ${action} <${CLASSIFIER_LIST_NAMES.join("|")}> <关键词…>`,
						"warning",
					);
					return;
				}
				const { changed, skipped } = applyRulesEdit(state, action, listName as ClassifierListName, keywords);
				host.persistClassifierOverrides();
				host.notify(
					lines([
						changed.length > 0 ? `${action === "add" ? "added" : "removed"} → ${listName}: ${changed.join(", ")}（已持久化，下一请求生效）` : undefined,
						skipped.length > 0 ? `skipped (无变化): ${skipped.join(", ")}` : undefined,
					]),
					changed.length > 0 ? "info" : "warning",
				);
				return;
			}
			host.notify(`unknown rules action: ${action} — show|add|remove|reset`, "warning");
			return;
		}
		case "help": {
			host.notify(runHelp(), "info");
			return;
		}
		default:
			host.notify(`unknown subcommand: ${sub} — run /auto-router help for usage`, "warning");
			return;
	}
}
