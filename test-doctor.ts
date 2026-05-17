import repairExtension from "./src/index";
import { buildDoctorReport } from "./src/doctor";

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

	let registered: { name: string; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	let sentMessage: { customType: string; content: string; display: boolean } | undefined;

	repairExtension({
		on() {},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			registered = { name, handler: options.handler };
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

	expect("registers repair-doctor command", registered?.name === "repair-doctor");
	if (registered) {
		await registered.handler("", {
			hasUI: false,
			cwd: process.cwd(),
			sessionManager: { getEntries() { return []; } },
			modelRegistry: {},
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
		} as any);
	}
	expect("doctor command emits message", sentMessage?.customType === "pi-tool-repair-doctor");
	expect("doctor command emits visible report", sentMessage?.display === true && sentMessage.content.includes("# pi-tool-repair doctor"));

	process.exit(ok ? 0 : 1);
}

void main();
