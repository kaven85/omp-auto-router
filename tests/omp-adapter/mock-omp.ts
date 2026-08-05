/**
 * Mock omp ExtensionAPI harness for adapter tests. Models the structural
 * subset in omp-api.ts with in-memory behavior.
 */

import { EventEmitter } from "node:events";

import type { OmpAutocompleteItem, OmpEventHandler, OmpExtensionApi, OmpExtensionContext, OmpModel, OmpProviderConfig } from "../../src/omp-adapter/omp-api";

export interface MockModel extends OmpModel {
	_stream?: (events: Array<{ type: string; [k: string]: unknown }>) => Promise<void>;
}

export class MockExtensionApi implements OmpExtensionApi {
	readonly emitter = new EventEmitter();
	label = "";
	providers: Map<string, OmpProviderConfig> = new Map();
	commands: Map<
		string,
		{
			description: string;
			getArgumentCompletions?: (argumentPrefix: string) => OmpAutocompleteItem[] | null;
			handler: (args: string, ctx: OmpExtensionContext) => void | Promise<void>;
		}
	> = new Map();
	entries: Array<{ customType: string; data?: unknown }> = [];
	thinkingLevels: string[] = [];
	modelSwitches: string[] = [];
	models: OmpModel[] = [];
	currentModel: OmpModel | undefined;
	logs: unknown[][] = [];

	setLabel(label: string): void {
		this.label = label;
	}
	on(event: string, handler: OmpEventHandler): void {
		this.emitter.on(event, handler);
	}
	registerProvider(name: string, config: OmpProviderConfig): void {
		this.providers.set(name, config);
	}
	registerCommand(
		name: string,
		def: {
			description: string;
			getArgumentCompletions?: (argumentPrefix: string) => OmpAutocompleteItem[] | null;
			handler: (args: string, ctx: OmpExtensionContext) => void | Promise<void>;
		},
	): void {
		this.commands.set(name, def);
	}
	async setModel(model: OmpModel): Promise<boolean> {
		this.modelSwitches.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}
	setThinkingLevel(level: string): void {
		this.thinkingLevels.push(level);
	}
	getThinkingLevel(): string {
		return this.thinkingLevels.at(-1) ?? "medium";
	}
	appendEntry(customType: string, data?: unknown): void {
		this.entries.push({ customType, data });
	}
	logger = {
		debug: (...args: unknown[]) => this.logs.push(["debug", ...args]),
		info: (...args: unknown[]) => this.logs.push(["info", ...args]),
		warn: (...args: unknown[]) => this.logs.push(["warn", ...args]),
		error: (...args: unknown[]) => this.logs.push(["error", ...args]),
	};

	/** Fire an extension event with a synthetic ctx and optional event payload. */
	async fire(event: string, ctx: OmpExtensionContext, payload: unknown = {}): Promise<void> {
		const handlers = this.emitter.listeners(event) as Array<(...args: unknown[]) => unknown>;
		for (const handler of handlers) {
			await handler(payload, ctx);
		}
	}

	makeCtx(overrides?: Partial<OmpExtensionContext>): OmpExtensionContext {
		const api = this;
		return {
			cwd: "/tmp/work",
			hasUI: true,
			models: {
				list: () => api.models,
				current: () => api.currentModel,
				resolve: (spec: string) => {
					for (const m of api.models) {
						if (spec === `${m.provider}/${m.id}` || spec === m.id) return m;
					}
					return undefined;
				},
			},
			modelRegistry: {
				getApiKey: async () => "test-key",
				authStorage: {
					fetchUsageReports: async () => [],
				},
			},
			ui: {
				hasUI: true,
				notify: () => {},
				setStatus: () => {},
			},
			sessionManager: {
				getBranch: () =>
					api.entries.map((e, i) => ({
						type: "custom",
						customType: e.customType,
						data: e.data as unknown,
						index: i,
					})),
			},
			getContextUsage: () => undefined,
			setInterval: () => 0,
			setTimeout: () => 0,
			clearTimer: () => {},
			...(overrides ?? {}),
		};
	};
}
