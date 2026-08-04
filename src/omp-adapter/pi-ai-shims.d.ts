/**
 * Ambient declarations for the host-bundled `@oh-my-pi/pi-ai` value imports.
 *
 * This file MUST stay import/export-free: `declare module` in a module file is
 * treated as augmentation (module must exist); in a script file it declares a
 * brand-new ambient module. At runtime the omp extension loader rewrites
 * `@oh-my-pi/*` specifiers to the host-bundled copies, so these shapes only
 * serve local tsc.
 */

declare module "@oh-my-pi/pi-ai" {
	export interface Model<TApi extends string = string> {
		provider: string;
		id: string;
		api: TApi;
		baseUrl?: string;
		reasoning?: boolean;
		input?: ("text" | "image")[];
		contextWindow?: number;
		maxTokens?: number;
		cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
		[key: string]: unknown;
	}
	export interface TextContent {
		type: "text";
		text: string;
		textSignature?: string;
	}
	export interface ImageContent {
		type: "image";
		data: string;
		mimeType: string;
	}
	export type Message =
		| { role: "user"; content: (TextContent | ImageContent)[] }
		| { role: "assistant"; content: unknown[] }
		| { role: "system"; content: string };
	export interface Tool {
		type: "function";
		[key: string]: unknown;
	}
	export interface Context {
		systemPrompt?: string[];
		messages: Message[];
		tools?: Tool[];
	}
	export interface SimpleStreamOptions {
		apiKey?: string | (() => Promise<string | undefined> | string | undefined);
		signal?: AbortSignal;
		[option: string]: unknown;
	}
	export type AssistantMessageEvent = {
		type: string;
		contentIndex?: number;
		[key: string]: unknown;
	};
	export type AssistantMessageEventStream = AsyncIterable<AssistantMessageEvent> & {
		abort(): void;
		[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
	};
	export function streamSimple<TApi extends string = string>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
}

declare module "@oh-my-pi/pi-ai/error" {
	export function isProviderRetryableError(error: unknown, hooks?: unknown): boolean;
}
