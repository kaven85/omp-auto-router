/**
 * omp-adapter — structural types for the subset of the omp ExtensionAPI we
 * consume.
 *
 * WHY structural subset instead of `import type { ExtensionAPI } from
 * "@oh-my-pi/pi-coding-agent"`: the omp extension loader rewrites
 * `@oh-my-pi/*` specifiers to the host-bundled copies at RUNTIME, but this
 * package is developed outside the omp monorepo, so no local tsc can resolve
 * those modules. The shapes below mirror the omp docs
 * (`omp://extensions.md`) and were verified against the omp source during the
 * M0 spike. The REAL verification is the runtime smoke test inside omp —
 * drift here is caught there, not by tsc.
 *
 * The pi-ai value imports (`streamSimple`, `isProviderRetryableError`) are
 * declared ambiently in pi-ai-shims.d.ts for tsc and resolved by the loader
 * at runtime.
 */

// ─────────────────────────────────────────────────────────────────────────────
// omp ExtensionAPI surface we rely on (structural subset)
// ─────────────────────────────────────────────────────────────────────────────

export interface OmpModelRegistry {
	getApiKey(model: unknown, sessionId?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
	authStorage: {
		fetchUsageReports(options?: { signal?: AbortSignal }): Promise<unknown[]>;
	};
}

export interface OmpModelsFacade {
	list(): OmpModel[];
	current(): OmpModel | undefined;
	resolve(spec: string): OmpModel | undefined;
}

export interface OmpModel {
	provider: string;
	id: string;
	api: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface OmpUiContext {	hasUI: boolean;
	notify(message: string, level: "info" | "warning" | "error"): void;
	setStatus(text: string): void;
	/** Optional dashboard widget surface (host-dependent; probed at runtime). */
	setWidget?(id: string, lines: string[]): void;
}

export interface OmpSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface OmpSessionManager {
	getBranch(): OmpSessionEntry[];
}

export interface OmpExtensionContext {
	cwd: string;
	hasUI: boolean;
	models: OmpModelsFacade;
	modelRegistry: OmpModelRegistry;
	ui: OmpUiContext;
	sessionManager: OmpSessionManager;
	/** Host-provided context token usage snapshot (shape is host-defined; adapter defensively coerces). */
	getContextUsage(): unknown;
	setInterval(fn: () => void, ms: number): unknown;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface OmpProviderStreamModel {
	provider: string;
	id: string;
	api: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface OmpProviderConfig {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	streamSimple?: (
		model: OmpProviderStreamModel,
		context: unknown,
		options?: { signal?: AbortSignal; [k: string]: unknown },
	) => AsyncIterable<{ type: string; [k: string]: unknown }>;
	models?: Array<{
		id: string;
		name: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
	}>;
}

/** Dropdown row for argument autocomplete (mirrors pi-tui `AutocompleteItem`). */
export interface OmpAutocompleteItem {
	/** Text inserted in place of the typed argument prefix. */
	value: string;
	/** Short row label shown in the dropdown. */
	label: string;
	/** Longer explanation shown under the label (the "说明"). */
	description?: string;
	/** Dim usage hint shown inline while the row is selected. */
	hint?: string;
}

export interface OmpCommandDef {
	description: string;
	/** TUI dropdown completions for the argument after `/auto-router `; null = none. */
	getArgumentCompletions?: (argumentPrefix: string) => OmpAutocompleteItem[] | null;
	handler: (args: string, ctx: OmpExtensionContext) => Promise<void> | void;
}

export type OmpEventHandler<E = unknown> = (event: E, ctx: OmpExtensionContext) => Promise<void> | void;

export interface OmpExtensionApi {
	setLabel(label: string): void;
	on(event: string, handler: OmpEventHandler): void;
	registerProvider(name: string, config: OmpProviderConfig): void;
	registerCommand(name: string, def: OmpCommandDef): void;
	setModel(model: OmpModel): Promise<boolean>;
	setThinkingLevel(level: string): void;
	getThinkingLevel?(): string;
	appendEntry(customType: string, data?: unknown): void;
	logger: { debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}
