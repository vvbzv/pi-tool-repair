import repairExtension from "./src/index";
import { buildDoctorReport } from "./src/doctor";
import {
	OLLAMA_CLOUD_PROVIDER,
	OLLAMA_CLOUD_REPAIR_PROVIDER,
	OPENCODE_GO_PROVIDER,
	OPENCODE_GO_REPAIR_PROVIDER,
} from "./src/provider-models";

const runtimeAvailableModels = [
	{
		id: "llama-3.3-70b",
		name: "Llama 3.3 70B",
		provider: OLLAMA_CLOUD_PROVIDER,
		api: "openai-completions",
		baseUrl: "https://ollama.example/v1",
		reasoning: true,
		thinkingLevelMap: { low: "low", high: "high" },
		input: ["text", "image"],
		cost: { input: 0.42, output: 0.84 },
		contextWindow: 131072,
		maxTokens: 8192,
		headers: { "X-Model": "llama-3.3-70b" },
		compat: { strictToolCalls: true },
	},
] satisfies Array<Record<string, unknown>>;

function createContext(options: {
	apiKeys?: Record<string, string | undefined>;
	available?: Array<Record<string, unknown>>;
} = {}) {
	return {
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: { getEntries() { return []; } },
		modelRegistry: {
			async getApiKeyForProvider(provider: string) {
				return options.apiKeys?.[provider];
			},
			async getAvailable() {
				return (options.available ?? []) as any[];
			},
		},
		model: undefined,
		isIdle() { return true; },
		signal: undefined,
		abort() {},
		hasPendingMessages() { return false; },
		shutdown() {},
		getContextUsage() { return undefined; },
		compact() {},
		getSystemPrompt() { return ""; },
		ui: { notify() {}, setStatus() {} },
	} as any;
}

async function main() {
	const tools = [
		{
			name: "edit",
			description: "Edit file",
			parameters: {
				type: "object",
				required: ["path", "edits"],
				properties: {
					path: { type: "string" },
					edits: {
						type: "array",
						items: {
							type: "object",
							properties: {
								oldText: { type: "string" },
								newText: { type: "string" },
							},
						},
					},
				},
			},
			sourceInfo: { path: "builtin", source: "pi", scope: "project", origin: "top-level" },
		},
		{
			name: "mcp",
			description: "MCP gateway",
			parameters: {
				type: "object",
				properties: {
					server: { type: "string" },
					tool: { type: "string" },
					args: { type: "object", properties: {}, required: [] },
				},
			},
			sourceInfo: { path: "adapter", source: "pi-mcp-adapter", scope: "project", origin: "package" },
		},
		{
			name: "ctx_shell",
			description: "Lean shell",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string" },
					description: { type: "string" },
				},
			},
			sourceInfo: { path: "ctx", source: "pi-lean-ctx", scope: "project", origin: "package" },
		},
	] as const;

	const report = buildDoctorReport({
		activeTools: ["edit", "mcp"],
		tools: tools as unknown as any[],
		providerStatuses: [
			{
				baseProvider: OPENCODE_GO_PROVIDER,
				provider: OPENCODE_GO_REPAIR_PROVIDER,
				registered: true,
				modelCount: 5,
				authConfigured: true,
				authSource: "registry",
			},
			{
				baseProvider: OLLAMA_CLOUD_PROVIDER,
				provider: OLLAMA_CLOUD_REPAIR_PROVIDER,
				registered: false,
				modelCount: 0,
				reason: "missing-models",
				authConfigured: true,
				authSource: "registry",
			},
		],
	});

	let ok = true;
	function expect(name: string, condition: boolean) {
		console.log(condition ? `  ✓ ${name}` : `  ✗ ${name}`);
		ok = ok && condition;
	}

	expect("doctor report has heading", report.includes("# pi-tool-repair doctor"));
	expect("doctor report mentions active tools", report.includes("Active tools checked: 2 of 3"));
	expect("doctor report flags edit container risk", report.includes("`edit`"));
	expect("doctor report mentions MCP gateway", report.includes("MCP gateway detected"));
	expect("doctor report explains wrapper visibility limit", report.includes("cannot verify whether third-party tools already use `prepareArguments`"));
	expect("doctor report includes provider shim section", report.includes("## Provider shims"));
	expect("doctor report includes opencode-go-repair status", report.includes(`### \`${OPENCODE_GO_REPAIR_PROVIDER}\``));
	expect("doctor report reports registry auth source", report.includes("Auth configured: yes (registry)"));
	expect("doctor report reports auth even when models are unavailable", report.includes("Auth configured: yes (registry)"));
	expect("doctor report includes ollama-cloud-repair status", report.includes(`### \`${OLLAMA_CLOUD_REPAIR_PROVIDER}\``));
	expect("doctor report explains missing mirrored models", report.includes("Skip reason: ollama-cloud is unavailable or has no mirrorable openai-completions models"));
	expect("doctor report mentions repair-provider-refresh", report.includes("/repair-provider-refresh"));
	expect("doctor report mentions pi-ollama-cloud dependency", report.includes("requires `pi-ollama-cloud` to be installed and registered first"));

	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let sentMessage: { customType: string; content: string; display: boolean } | undefined;

	await repairExtension({
		on() {},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
		registerTool() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() { return undefined; },
		registerMessageRenderer() {},
		sendMessage(message: { customType: string; content: string; display: boolean }) {
			sentMessage = message;
		},
		sendUserMessage() {},
		appendEntry() {},
		setSessionName() {},
		getSessionName() { return undefined; },
		setLabel() {},
		exec() { throw new Error("not used"); },
		getActiveTools() { return ["edit", "mcp"]; },
		getAllTools() { return tools as unknown as any[]; },
		setActiveTools() {},
		getCommands() { return []; },
		setModel() { return Promise.resolve(false); },
		getThinkingLevel() { return "medium"; },
		setThinkingLevel() {},
		registerProvider() {},
		unregisterProvider() {},
		events: { on() {}, off() {}, once() {}, emit() {} },
	} as any);

	const doctorCommand = commands.get("repair-doctor");
	const refreshCommand = commands.get("repair-provider-refresh");
	expect("registers repair-doctor command", typeof doctorCommand?.handler === "function");
	expect("registers repair-provider-refresh command", typeof refreshCommand?.handler === "function");
	if (doctorCommand && refreshCommand) {
		await refreshCommand.handler("", createContext({
			apiKeys: {
				[OPENCODE_GO_PROVIDER]: "stored-opencode-key",
				[OLLAMA_CLOUD_PROVIDER]: "stored-ollama-key",
			},
			available: runtimeAvailableModels,
		}));
		await doctorCommand.handler("", createContext());
		expect("doctor command emits message", sentMessage?.customType === "pi-tool-repair-doctor");
		expect("doctor command emits registered provider details after refresh", sentMessage?.content.includes(`### \`${OLLAMA_CLOUD_REPAIR_PROVIDER}\``) === true);
		expect("doctor command reports refreshed auth source", sentMessage?.content.includes("Auth configured: yes (registry)") === true);

		await refreshCommand.handler("", createContext({
			apiKeys: {
				[OPENCODE_GO_PROVIDER]: "stored-opencode-key",
				[OLLAMA_CLOUD_PROVIDER]: "stored-ollama-key",
			},
		}));
		await doctorCommand.handler("", createContext());
		expect("doctor command reflects refreshed skip reason", sentMessage?.content.includes("Skip reason: ollama-cloud is unavailable or has no mirrorable openai-completions models") === true);
		expect("doctor command emits visible report", sentMessage?.display === true && sentMessage.content.includes("# pi-tool-repair doctor"));
	}

	process.exit(ok ? 0 : 1);
}

void main();