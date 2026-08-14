/**
 * Pi-shaped test harness for the Pi adapter contract tests.
 *
 * Implements the public extension surface the adapter consumes
 * (registerProvider/registerCommand/on/setModel/appendEntry + ExtensionContext)
 * with recording so tests assert host-visible behavior only.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piAutoRouterExtension from "../../src/pi-adapter/index";

export interface MockModel {
	provider: string;
	id: string;
	api: string;
	reasoning?: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
}

export interface StreamCall {
	provider: string;
	model: string;
	apiKey?: string;
	headers?: Record<string, string>;
	reasoning?: string;
	prompt?: string;
	signal?: AbortSignal;
}

export interface CommandCapture {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

type StreamEvents = Array<{ type: string; [key: string]: unknown }>;

/** Shape the adapter passes through as the stream context (message list only). */
interface MockStreamContext {
	messages: Array<{ role: string; content: unknown }>;
}

export interface PiHarness {
	agentDir: string;
	cwd: string;
	providers: Map<string, { models: Array<{ id: string }>; streamSimple: (model: MockModel, context: never, options: never) => unknown }>;
	commands: Map<string, CommandCapture>;
	handlers: Map<string, (event: never, context: never) => unknown>;
	notifications: Array<{ message: string; level: string }>;
	entries: Array<{ customType: string; data: unknown }>;
	streamCalls: StreamCall[];
	branch: Array<{ type: string; customType?: string; data?: unknown }>;
	context: {
		cwd: string;
		model?: MockModel;
		scopedModels: Array<{ model: MockModel }>;
		sessionManager: { getBranch: () => PiHarness["branch"] };
		ui: {
			notify: (message: string, level: string) => void;
			setStatus: (id: string, text: string) => void;
			setWidget: (id: string, lines: string[]) => void;
		};
		modelRegistry: {
			find: (provider: string, id: string) => MockModel | undefined;
			getProvider: (provider: string) => { streamSimple: (model: MockModel, context: unknown, options?: Record<string, unknown>) => AsyncIterable<unknown> } | undefined;
			getApiKeyAndHeaders: (model: MockModel) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
			getAvailable: () => MockModel[];
			complete: (model: MockModel, context: unknown, options?: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
		};
		isProjectTrusted: () => boolean;
		getContextUsage: () => { tokens: number };
	};
	pi: {
		registerProvider: (name: string, config: never) => void;
		registerCommand: (name: string, def: CommandCapture) => void;
		on: (event: string, handler: never) => void;
		appendEntry: (customType: string, data?: unknown) => void;
		setModel: (model: MockModel) => Promise<boolean>;
	};
	/** Models registered per real provider, keyed "provider/model". */
	targets: Map<string, MockModel>;
	/** Per-provider stream scripts, keyed "provider/model". */
	streams: Map<string, () => StreamEvents>;
	/** Per-provider auth outcomes. Default: ok with `${provider}-key`. */
	auth: Map<string, { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
	/** Models asked to adjudicate, as "provider/model". */
	completions: string[];
	/** Adjudicator replies per "provider/model"; an Error value throws. */
	adjudicationReplies: Map<string, string | Error>;
	setModelResult: boolean;
	trusted: boolean;
	uiThrows: boolean;
	fire: (event: "session_start" | "session_tree" | "session_shutdown") => Promise<void>;
	invoke: (args: string) => Promise<void>;
	stream: (profileId: string, prompt: string, options?: Record<string, unknown>) => Promise<Array<{ type: string; [key: string]: unknown }>>;
	cleanup: () => void;
}

export function baseModel(provider: string, id: string, extra: Partial<MockModel> = {}): MockModel {
	return {
		provider,
		id,
		api: "openai-completions",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...extra,
	};
}

export function createPiHarness(options: {
	userConfig?: string;
	projectConfig?: string;
	trusted?: boolean;
}): PiHarness {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-harness-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-harness-cwd-"));
	if (options.userConfig !== undefined) writeFileSync(join(agentDir, "auto-router.yml"), options.userConfig);
	if (options.projectConfig !== undefined) {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "auto-router.yml"), options.projectConfig);
	}

	const harness = {
		agentDir,
		cwd,
		trusted: options.trusted ?? false,
		uiThrows: false,
		setModelResult: true,
		providers: new Map(),
		commands: new Map(),
		handlers: new Map(),
		notifications: [],
		entries: [],
		streamCalls: [],
		branch: [],
		targets: new Map(),
		streams: new Map(),
		auth: new Map(),
		completions: [],
		adjudicationReplies: new Map(),
	} as unknown as PiHarness;

	harness.context = {
		cwd,
		scopedModels: [],
		sessionManager: { getBranch: () => harness.branch },
		ui: {
			notify: (message: string, level: string) => {
				if (harness.uiThrows) throw new Error("no ui");
				harness.notifications.push({ message, level });
			},
			setStatus: () => {
				if (harness.uiThrows) throw new Error("no ui");
			},
			setWidget: () => {
				if (harness.uiThrows) throw new Error("no ui");
			},
		},
		modelRegistry: {
			find: (provider: string, id: string) => {
				if (provider === "auto-router") {
					const registered = harness.providers.get("auto-router");
					return registered?.models.some((model) => model.id === id) ? baseModel("auto-router", id) : undefined;
				}
				return harness.targets.get(`${provider}/${id}`);
			},
			getProvider: (provider: string) => {
				if (![...harness.targets.values()].some((model) => model.provider === provider)) return undefined;
				return {
					streamSimple(model: MockModel, rawContext: unknown, options?: Record<string, unknown>) {
						// Mock boundary: the adapter always passes a message-list context.
						const context = rawContext as MockStreamContext;
						const key = `${model.provider}/${model.id}`;
						const call: StreamCall = {
							provider: model.provider,
							model: model.id,
							...(typeof options?.apiKey === "string" ? { apiKey: options.apiKey } : {}),
							...(options?.headers !== undefined ? { headers: options.headers as Record<string, string> } : {}),
							...(typeof options?.reasoning === "string" ? { reasoning: options.reasoning } : {}),
							...(options?.signal !== undefined ? { signal: options.signal as AbortSignal } : {}),
						};
						const lastMessage = context.messages.at(-1);
						const parts = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
						call.prompt = parts
							.map((part) =>
								typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
							)
							.join("");
						harness.streamCalls.push(call);
						const script: () => StreamEvents = harness.streams.get(key) ?? (() => [
							{ type: "text_delta", delta: `ok from ${key}` },
							{ type: "done", reason: "stop", message: { provider: model.provider, model: model.id, usage: { input: 2, output: 1 } } },
						]);
						const events = script();
						return (async function* (): AsyncGenerator<{ type: string; [key: string]: unknown }> {
							for (const event of events) {
								if (event.type === "throw") {
									const error = Object.assign(new Error(String(event.error ?? "boom")), {
										...(event.status !== undefined ? { status: event.status } : {}),
									});
									if (typeof event.name === "string") error.name = event.name;
									throw error;
								}
								yield event;
							}
						})();
					},
				};
			},
			getApiKeyAndHeaders: async (model: MockModel) =>
				harness.auth.get(model.provider) ?? { ok: true as const, apiKey: `${model.provider}-key` },
			getAvailable: () => [...harness.targets.values()],
			complete: async (model: MockModel) => {
				harness.completions.push(`${model.provider}/${model.id}`);
				const reply = harness.adjudicationReplies.get(`${model.provider}/${model.id}`) ?? "standard";
				if (reply instanceof Error) throw reply;
				return { content: [{ type: "text", text: reply }] };
			},
		},
		isProjectTrusted: () => harness.trusted,
		getContextUsage: () => ({ tokens: 32 }),
	};

	harness.pi = {
		registerProvider(name: string, config: never) {
			harness.providers.set(name, config);
		},
		registerCommand(name: string, def: CommandCapture) {
			harness.commands.set(name, def);
		},
		on(event: string, handler: never) {
			harness.handlers.set(event, handler);
		},
		appendEntry(customType: string, data?: unknown) {
			harness.entries.push({ customType, data });
		},
		async setModel(model: MockModel) {
			if (!harness.setModelResult) return false;
			harness.context.model = model;
			return true;
		},
	};

	harness.fire = async (event) => {
		const handler = harness.handlers.get(event);
		if (handler) await handler({} as never, harness.context as never);
	};
	harness.invoke = async (args) => {
		const command = harness.commands.get("auto-router");
		if (!command) throw new Error("auto-router command not registered");
		await command.handler(args, harness.context);
	};
	harness.stream = async (profileId, prompt, options) => {
		const provider = harness.providers.get("auto-router");
		if (!provider) throw new Error("auto-router provider not registered");
		const virtualModel = baseModel("auto-router", profileId);
		const out: Array<{ type: string; [key: string]: unknown }> = [];
		const stream = provider.streamSimple(virtualModel, {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
		} as never, (options ?? {}) as never) as AsyncIterable<{ type: string; [key: string]: unknown }>;
		for await (const event of stream) out.push(event);
		// Post-stream accounting (widget render, balance refresh) runs after the
		// terminal event ends consumer iteration; give the bridge a tick.
		const { promise: settled, resolve: markSettled } = Promise.withResolvers<void>();
		setTimeout(markSettled, 10);
		await settled;
		return out;
	};
	harness.cleanup = () => {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		const prior = (harness as unknown as Record<symbol, string | undefined>)[PRIOR_AGENT_DIR];
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
	};

	return harness;
}

const PRIOR_AGENT_DIR = Symbol("priorAgentDir");

/** Load the extension against a harness, pinning PI_CODING_AGENT_DIR for the harness lifetime. */
export async function bootHarness(harness: PiHarness, withSessionStart = true): Promise<void> {
	const record = harness as unknown as Record<symbol, string | undefined>;
	if (!(PRIOR_AGENT_DIR in record)) record[PRIOR_AGENT_DIR] = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = harness.agentDir;
	piAutoRouterExtension(harness.pi as never);
	if (withSessionStart) await harness.fire("session_start");
}

export function addTarget(harness: PiHarness, model: MockModel, script?: Parameters<PiHarness["streams"]["set"]>[1]): MockModel {
	harness.targets.set(`${model.provider}/${model.id}`, model);
	if (script) harness.streams.set(`${model.provider}/${model.id}`, script);
	return model;
}
