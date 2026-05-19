import type { AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions, StreamFunction, ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "./node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";

import {
	createRepairedOpenAICompletionsSimpleStream,
	registerRepairedOpenAICompletionsProvider,
	unregisterRepairedOpenAICompletionsProvider,
} from "./src/provider-shim";
import { OPENCODE_GO_PROVIDER, OPENCODE_GO_REPAIR_PROVIDER } from "./src/provider-models";
import { editSchema, multiEditSchema, readSchema } from "./test-fixtures/tool-schemas";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: unknown) {
	if (condition) {
		console.log(`  ✓ ${name}`);
		passed++;
		return;
	}

	console.log(`  ✗ ${name}`);
	if (detail !== undefined) {
		console.log(`    ${JSON.stringify(detail)}`);
	}
	failed++;
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

type FakeStreamFixture = {
	contentIndex: number;
	partialToolCall?: ToolCall;
	eventToolCall?: ToolCall;
};

function fakeOpenAIStream(
	rawChunks: string[],
	toolName: string,
	options: { contentIndex?: number; separateEventToolCall?: boolean } = {},
): { baseStream: StreamFunction<"openai-completions", SimpleStreamOptions>; fixture: FakeStreamFixture } {
	const fixture: FakeStreamFixture = {
		contentIndex: options.contentIndex ?? 0,
	};

	return {
		fixture,
		baseStream: () => {
			const stream = new AssistantMessageEventStream();
			const partial = assistantMessage();
			const partialToolCall = { type: "toolCall" as const, id: "call_1", name: toolName, arguments: {} };

			for (let index = 0; index < fixture.contentIndex; index++) {
				partial.content.push({ type: "text", text: `prefix ${index}` });
			}
			partial.content.push(partialToolCall);

			const eventToolCall = options.separateEventToolCall
				? { ...partialToolCall, arguments: { ...partialToolCall.arguments } }
				: partialToolCall;
			fixture.partialToolCall = partialToolCall;
			fixture.eventToolCall = eventToolCall;

			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_start", contentIndex: fixture.contentIndex, partial });
				for (const delta of rawChunks) {
					stream.push({ type: "toolcall_delta", contentIndex: fixture.contentIndex, delta, partial });
				}
				stream.push({ type: "toolcall_end", contentIndex: fixture.contentIndex, toolCall: eventToolCall, partial });
				stream.push({ type: "done", reason: "toolUse", message: partial });
				stream.end(partial);
			});

			return stream;
		},
	};
}

async function collectEvents(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const output: AssistantMessageEvent[] = [];
	for await (const event of events) {
		output.push(event);
	}
	return output;
}

async function runCase(
	name: string,
	schema: unknown,
	rawChunks: string[],
	expected: Record<string, unknown>,
	options: { contentIndex?: number; separateEventToolCall?: boolean; toolName?: string } = {},
) {
	const toolName = options.toolName ?? "edit";
	const { baseStream, fixture } = fakeOpenAIStream(rawChunks, toolName, options);
	const wrapped = createRepairedOpenAICompletionsSimpleStream(baseStream);
	const context: Context = {
		messages: [],
		tools: [{ name: toolName, description: toolName, parameters: schema as never }],
	};
	const model = { id: "test-model", api: "openai-completions", provider: "test-provider" } as Model<"openai-completions">;
	registerRepairedOpenAICompletionsProvider(model.provider);
	try {
		const events = await collectEvents(wrapped(model, context));
		const endEvent = events.find((event) => event.type === "toolcall_end");
		const doneEvent = events.find((event) => event.type === "done");
		const expectedBlock = { type: "toolCall", id: "call_1", name: toolName, arguments: expected };

		assert(
			`${name} repairs toolcall_end arguments`,
			JSON.stringify(endEvent?.type === "toolcall_end" ? endEvent.toolCall.arguments : undefined) === JSON.stringify(expected),
			endEvent,
		);
		assert(
			`${name} repairs matching partial block`,
			JSON.stringify(endEvent?.type === "toolcall_end" ? endEvent.partial.content[fixture.contentIndex] : undefined) === JSON.stringify(expectedBlock),
			endEvent,
		);
		assert(
			`${name} repairs final message block`,
			JSON.stringify(doneEvent?.type === "done" ? doneEvent.message.content[fixture.contentIndex] : undefined) === JSON.stringify(expectedBlock),
			doneEvent,
		);

		if (fixture.contentIndex > 0) {
			assert(
				`${name} preserves earlier content blocks`,
				JSON.stringify(doneEvent?.type === "done" ? doneEvent.message.content[0] : undefined) === JSON.stringify({ type: "text", text: "prefix 0" }),
				doneEvent,
			);
		}

		if (options.separateEventToolCall) {
			assert(`${name} uses contentIndex instead of object identity`, fixture.eventToolCall !== fixture.partialToolCall, fixture);
			assert(
				`${name} repairs the stored partial toolCall`,
				JSON.stringify(fixture.partialToolCall?.arguments) === JSON.stringify(expected),
				fixture.partialToolCall,
			);
		}
	} finally {
		unregisterRepairedOpenAICompletionsProvider(model.provider);
	}
}

async function runPassThroughCase() {
	registerRepairedOpenAICompletionsProvider(OPENCODE_GO_REPAIR_PROVIDER);
	try {
		const fixture: FakeStreamFixture = { contentIndex: 0 };
		const source = new AssistantMessageEventStream();
		const partial = assistantMessage();
		const partialToolCall = { type: "toolCall" as const, id: "call_1", name: "edit", arguments: {} };
		partial.content.push(partialToolCall);
		fixture.partialToolCall = partialToolCall;
		fixture.eventToolCall = partialToolCall;

		queueMicrotask(() => {
			source.push({ type: "start", partial });
			source.push({ type: "toolcall_start", contentIndex: fixture.contentIndex, partial });
			source.push({
				type: "toolcall_delta",
				contentIndex: fixture.contentIndex,
				delta: '{"path":"x.ts","edits":"[{\\"oldText\\":\\"a\\",\\"newText\\":\\"b\\"}"}',
				partial,
			});
			source.push({ type: "toolcall_end", contentIndex: fixture.contentIndex, toolCall: partialToolCall, partial });
			source.push({ type: "done", reason: "toolUse", message: partial });
			source.end(partial);
		});

		const wrapped = createRepairedOpenAICompletionsSimpleStream(() => source);
		const context: Context = {
			messages: [],
			tools: [{ name: "edit", description: "edit", parameters: editSchema as never }],
		};
		const model = { id: "test-model", api: "openai-completions", provider: OPENCODE_GO_PROVIDER } as Model<"openai-completions">;
		const wrappedSource = wrapped(model, context);
		const events = await collectEvents(wrappedSource);
		const endEvent = events.find((event) => event.type === "toolcall_end");
		const doneEvent = events.find((event) => event.type === "done");

		assert("non-repaired providers reuse the original stream", wrappedSource === source, {
			sourceConstructor: source.constructor.name,
			wrappedConstructor: wrappedSource.constructor.name,
		});
		assert(
			"non-repaired providers keep toolcall_end arguments unchanged",
			JSON.stringify(endEvent?.type === "toolcall_end" ? endEvent.toolCall.arguments : undefined) === JSON.stringify({}),
			endEvent,
		);
		assert(
			"non-repaired providers keep final message block unchanged",
			JSON.stringify(doneEvent?.type === "done" ? doneEvent.message.content[fixture.contentIndex] : undefined) ===
				JSON.stringify({ type: "toolCall", id: "call_1", name: "edit", arguments: {} }),
			doneEvent,
		);
	} finally {
		unregisterRepairedOpenAICompletionsProvider(OPENCODE_GO_REPAIR_PROVIDER);
	}
}

async function main() {
	await runCase(
		"truncated stringified edit array",
		editSchema,
		['{"path":"x.ts","edits":"[{\\"oldText\\":\\"a\\",\\"newText\\":\\"b\\"}"}'],
		{ path: "x.ts", edits: [{ oldText: "a", newText: "b" }] },
	);

	await runCase(
		"malformed raw json",
		editSchema,
		['{"path":"x.ts",', '"edits":"[{\\"oldText\\":\\"a\\",\\"newText\\":\\"b\\"}"'],
		{ path: "x.ts", edits: [{ oldText: "a", newText: "b" }] },
	);

	const patch = "*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** End Patch";
	await runCase("known-schema patch string", multiEditSchema, [JSON.stringify({ patch })], { patch });
	await runCase(
		"provider shim single-quoted array",
		{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
		[JSON.stringify({ paths: "['a.ts', 'b.ts']" })],
		{ paths: ["a.ts", "b.ts"] },
	);
	await runCase(
		"provider shim markdown linked path",
		readSchema,
		[JSON.stringify({ path: "[notes.md](https://example.test/notes)" })],
		{ path: "notes.md" },
		{ toolName: "read" },
	);
	await runCase(
		"provider shim empty object for array",
		{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
		[JSON.stringify({ paths: {} })],
		{ paths: [] },
	);
	await runCase(
		"provider shim bare string for string array",
		{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
		[JSON.stringify({ paths: "src/only.ts" })],
		{ paths: ["src/only.ts"] },
	);
	await runCase(
		"provider shim read limit defaults offset",
		readSchema,
		[JSON.stringify({ path: "README.md", limit: "20" })],
		{ path: "README.md", limit: 20, offset: 1 },
		{ toolName: "read" },
	);
	await runCase(
		"non-zero content index with distinct event toolCall reference",
		editSchema,
		['{"path":"x.ts","edits":"[{\\"oldText\\":\\"a\\",\\"newText\\":\\"b\\"}"}'],
		{ path: "x.ts", edits: [{ oldText: "a", newText: "b" }] },
		{ contentIndex: 1, separateEventToolCall: true },
	);
	await runPassThroughCase();

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

void main();
