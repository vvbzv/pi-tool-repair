import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions, StreamFunction, ToolCall } from "@earendil-works/pi-ai";

import { repairRawJsonObject } from "./raw-json";
import { repairArgsWithSchema } from "./schema-repair";

export const REPAIRED_OPENAI_COMPLETIONS_API = "openai-completions-repair" as const;
type OpenAICompletionsSimpleStream = StreamFunction<Api, SimpleStreamOptions>;

const repairedProviderNames = new Set<string>();

class LocalAssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
	private queue: AssistantMessageEvent[] = [];
	private waiting: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
	private done = false;
	private finalResultPromise: Promise<AssistantMessage>;
	private resolveFinalResult!: (result: AssistantMessage) => void;

	constructor() {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: AssistantMessageEvent) {
		if (this.done) {
			return;
		}

		if (event.type === "done" || event.type === "error") {
			this.done = true;
			this.resolveFinalResult(event.type === "done" ? event.message : event.error);
		}

		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
			return;
		}

		this.queue.push(event);
	}

	end(result?: AssistantMessage) {
		this.done = true;
		if (result) {
			this.resolveFinalResult(result);
		}

		while (this.waiting.length > 0) {
			this.waiting.shift()?.({ value: undefined, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		while (true) {
			if (this.queue.length > 0) {
				const event = this.queue.shift();
				if (event) {
					yield event;
				}
				continue;
			}

			if (this.done) {
				return;
			}

			const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => this.waiting.push(resolve));
			if (result.done) {
				return;
			}
			yield result.value;
		}
	}

	result() {
		return this.finalResultPromise;
	}
}

function importErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

const streamSimpleOpenAICompletions: OpenAICompletionsSimpleStream = (model, context, options) => {
	const stream = new LocalAssistantMessageEventStream();
	const baseModel = { ...model, api: "openai-completions" as const };

	void import("@earendil-works/pi-ai/openai-completions")
		.then(({ streamSimpleOpenAICompletions: baseStream }) => baseStream(baseModel, context, options))
		.then(async (source) => {
			for await (const event of source) {
				stream.push(event);
			}
			stream.end(await source.result());
		})
		.catch((error) => {
			const message = importErrorMessage(model, error);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
		});

	return stream as unknown as ReturnType<OpenAICompletionsSimpleStream>;
};

export function registerRepairedOpenAICompletionsProvider(provider: string) {
	repairedProviderNames.add(provider);
}

export function unregisterRepairedOpenAICompletionsProvider(provider: string) {
	repairedProviderNames.delete(provider);
}

function shouldRepairProvider(model: Model<Api>) {
	return repairedProviderNames.has(model.provider);
}

function toolSchema(context: Context, toolName: string): unknown {
	return context.tools?.find((tool) => tool.name === toolName)?.parameters;
}

function toolCallBlock(message: AssistantMessage, contentIndex: number): ToolCall | undefined {
	const block = message.content[contentIndex];
	return block?.type === "toolCall" ? block : undefined;
}

function repairToolCall(raw: string, toolCall: ToolCall, schema: unknown): Record<string, any> | undefined {
	const repairedRaw = repairRawJsonObject(raw).raw;

	try {
		const parsed = JSON.parse(repairedRaw);
		const repaired = repairArgsWithSchema(parsed, schema, {
			stage: "prepare-arguments",
			toolName: toolCall.name,
		});
		return repaired.value as Record<string, any>;
	} catch {
		return undefined;
	}
}

function applyToolCallArguments(message: AssistantMessage, contentIndex: number, argumentsValue: Record<string, any>) {
	const block = toolCallBlock(message, contentIndex);
	if (block) {
		block.arguments = argumentsValue;
	}
}

export function createRepairedOpenAICompletionsSimpleStream(
	baseStream: OpenAICompletionsSimpleStream = streamSimpleOpenAICompletions,
): OpenAICompletionsSimpleStream {
	return (model, context, options) => {
		const source = baseStream(model, context, options);
		if (!shouldRepairProvider(model)) {
			return source;
		}

		const stream = new (source.constructor as new () => typeof source)();
		const rawByContentIndex = new Map<number, string>();
		const repairedByContentIndex = new Map<number, Record<string, any>>();

		(async () => {
			for await (const event of source) {
				if (event.type === "toolcall_start") {
					rawByContentIndex.set(event.contentIndex, "");
					stream.push(event);
					continue;
				}

				if (event.type === "toolcall_delta") {
					rawByContentIndex.set(event.contentIndex, (rawByContentIndex.get(event.contentIndex) ?? "") + event.delta);
					stream.push(event);
					continue;
				}

				if (event.type === "toolcall_end") {
					const raw = rawByContentIndex.get(event.contentIndex) ?? "";
					const schema = toolSchema(context, event.toolCall.name);
					if (raw && schema) {
						const repaired = repairToolCall(raw, event.toolCall, schema);
						if (repaired !== undefined) {
							event.toolCall.arguments = repaired;
							applyToolCallArguments(event.partial, event.contentIndex, repaired);
							repairedByContentIndex.set(event.contentIndex, repaired);
						}
					}
					rawByContentIndex.delete(event.contentIndex);
					stream.push(event);
					continue;
				}

				if (event.type === "done") {
					for (const [contentIndex, argumentsValue] of repairedByContentIndex) {
						applyToolCallArguments(event.message, contentIndex, argumentsValue);
					}
					stream.push(event);
					repairedByContentIndex.clear();
					stream.end(event.message);
					return;
				}

				if (event.type === "error") {
					for (const [contentIndex, argumentsValue] of repairedByContentIndex) {
						applyToolCallArguments(event.error, contentIndex, argumentsValue);
					}
					stream.push(event);
					repairedByContentIndex.clear();
					stream.end(event.error);
					return;
				}

				stream.push(event);
			}

			stream.end();
		})();

		return stream;
	};
}

export const streamSimpleOpenAICompletionsWithRepair = createRepairedOpenAICompletionsSimpleStream();
