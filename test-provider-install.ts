import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import repairExtension from "./src/index";
import {
	bootstrapInstallOllamaCloudRepairProvider,
	bootstrapInstallOpencodeGoRepairProvider,
	formatRepairedProviderInstallStatus,
	installOllamaCloudRepairProvider,
	installOpencodeGoRepairProvider,
	installRepairedProvider,
} from "./src/provider-install";
import {
	mirrorBuiltInProviderModels,
	mirrorOllamaCloudProviderModels,
	OLLAMA_CLOUD_PROVIDER,
	OLLAMA_CLOUD_REPAIR_PROVIDER,
	OPENCODE_GO_PROVIDER,
	OPENCODE_GO_REPAIR_PROVIDER,
} from "./src/provider-models";
import { REPAIRED_OPENAI_COMPLETIONS_API, streamSimpleOpenAICompletionsWithRepair } from "./src/provider-shim";

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

function pickModelFields(model: Record<string, unknown>) {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: model.headers,
		compat: model.compat,
	};
}

const runtimeOllamaModels = [
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
	{
		id: "qwen3-32b",
		name: "Qwen 3 32B",
		provider: OLLAMA_CLOUD_PROVIDER,
		api: "openai-completions",
		baseUrl: "https://ollama.example/v1",
		reasoning: false,
		thinkingLevelMap: { medium: "medium" },
		input: ["text"],
		cost: { input: 0.12, output: 0.24 },
		contextWindow: 65536,
		maxTokens: 4096,
		headers: { "X-Model": "qwen3-32b" },
		compat: { strictToolCalls: false },
	},
] as const;

const runtimeAvailableModels = [
	...runtimeOllamaModels,
	{
		id: "other-provider-model",
		name: "Other Provider Model",
		provider: "some-other-provider",
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		thinkingLevelMap: {},
		input: ["text"],
		cost: { input: 0, output: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
		headers: {},
		compat: {},
	},
] satisfies Array<Record<string, unknown>>;

function createContext(options: {
	apiKey?: string;
	apiKeys?: Record<string, string | undefined>;
	available?: Array<Record<string, unknown>>;
} = {}) {
	return {
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: { getEntries() { return []; } },
		modelRegistry: {
			async getApiKeyForProvider(provider: string) {
				return options.apiKeys?.[provider] ?? options.apiKey;
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
		ui: {
			notify() {},
			setStatus() {},
		},
	} as any;
}

function createPi() {
	const registeredProviders: Array<{ name: string; config: Record<string, unknown> }> = [];
	const unregisteredProviders: string[] = [];
	const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();

	const pi = {
		on(eventName: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
			events.set(eventName, handler);
		},
		registerCommand(name: string, command: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command);
		},
		registerProvider(name: string, config: Record<string, unknown>) {
			registeredProviders.push({ name, config });
		},
		unregisterProvider(name: string) {
			unregisteredProviders.push(name);
		},
		registerTool() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() { return undefined; },
		registerMessageRenderer() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
		setSessionName() {},
		getSessionName() { return undefined; },
		setLabel() {},
		exec() { throw new Error("not used"); },
		getActiveTools() { return []; },
		getAllTools() { return []; },
		setActiveTools() {},
		getCommands() { return []; },
		setModel() { return Promise.resolve(false); },
		getThinkingLevel() { return "medium"; },
		setThinkingLevel() {},
		events: { on() {}, off() {}, once() {}, emit() {} },
	};

	return { pi: pi as any, registeredProviders, unregisteredProviders, commands, events };
}

async function main() {
	const { getModels } = await import("@earendil-works/pi-ai");
	const sourceModels = getModels(OPENCODE_GO_PROVIDER);
	const mirroredModels = await mirrorBuiltInProviderModels(
		OPENCODE_GO_PROVIDER,
		OPENCODE_GO_REPAIR_PROVIDER,
	);

	assert("mirrors all built-in opencode-go models", mirroredModels.length === sourceModels.length, {
		source: sourceModels.length,
		mirrored: mirroredModels.length,
	});
	assert(
		"rewrites mirrored provider name to opencode-go-repair",
		mirroredModels.every((model) => model.provider === OPENCODE_GO_REPAIR_PROVIDER),
	);
	assert(
		"preserves required built-in model fields while mirroring",
		JSON.stringify(mirroredModels.map((model) => pickModelFields(model as unknown as Record<string, unknown>))) ===
			JSON.stringify(sourceModels.map((model) => pickModelFields(model as unknown as Record<string, unknown>))),
	);

	const mirroredRuntimeModels = await mirrorOllamaCloudProviderModels(
		createContext({ available: runtimeAvailableModels }),
	);
	assert(
		"mirrors runtime ollama-cloud models from the model registry",
		mirroredRuntimeModels.length === runtimeOllamaModels.length,
		mirroredRuntimeModels,
	);
	assert(
		"rewrites mirrored provider name to ollama-cloud-repair",
		mirroredRuntimeModels.every((model) => model.provider === OLLAMA_CLOUD_REPAIR_PROVIDER),
		mirroredRuntimeModels,
	);
	assert(
		"preserves required runtime model fields while mirroring",
		JSON.stringify(mirroredRuntimeModels.map((model) => pickModelFields(model as unknown as Record<string, unknown>))) ===
			JSON.stringify(runtimeOllamaModels.map((model) => pickModelFields(model))),
		mirroredRuntimeModels,
	);

	const directPi = createPi();
	const directCtx = createContext({
		apiKey: "stored-opencode-key",
		available: sourceModels as unknown as Array<Record<string, unknown>>,
	});
	const directStatus = await installOpencodeGoRepairProvider(directPi.pi, directCtx);
	const directRegistration = directPi.registeredProviders.at(-1);
	assert("registers repaired sibling provider", directStatus.registered === true && directRegistration?.name === OPENCODE_GO_REPAIR_PROVIDER, {
		status: directStatus,
		registration: directRegistration,
	});
	assert(
		"uses repaired shim api and stream wrapper",
		directRegistration?.config.api === REPAIRED_OPENAI_COMPLETIONS_API &&
			directRegistration.config.streamSimple === streamSimpleOpenAICompletionsWithRepair,
		directRegistration,
	);
	assert(
		"registers mirrored provider models without overriding base provider names",
		Array.isArray(directRegistration?.config.models) &&
			(directRegistration.config.models as Array<Record<string, unknown>>).every((model) => model.api === undefined) &&
			directPi.registeredProviders.every((entry) => entry.name !== OPENCODE_GO_PROVIDER),
		directRegistration,
	);
	assert(
		"formats registration status with sibling provider name",
		formatRepairedProviderInstallStatus(directStatus).includes(OPENCODE_GO_REPAIR_PROVIDER),
		directStatus,
	);

	const ollamaPi = createPi();
	const ollamaCtx = createContext({
		apiKeys: { [OLLAMA_CLOUD_PROVIDER]: "stored-ollama-key" },
		available: runtimeAvailableModels,
	});
	const ollamaStatus = await installOllamaCloudRepairProvider(ollamaPi.pi, ollamaCtx);
	const ollamaRegistration = ollamaPi.registeredProviders.at(-1);
	assert(
		"registers ollama-cloud repaired sibling provider",
		ollamaStatus.registered === true && ollamaRegistration?.name === OLLAMA_CLOUD_REPAIR_PROVIDER,
		{ status: ollamaStatus, registration: ollamaRegistration },
	);
	assert(
		"uses mirrored runtime models and repaired stream for ollama-cloud-repair",
		ollamaRegistration?.config.api === REPAIRED_OPENAI_COMPLETIONS_API &&
			ollamaRegistration.config.streamSimple === streamSimpleOpenAICompletionsWithRepair &&
			(ollamaRegistration.config.models as Array<Record<string, unknown>>).every((model) => model.api === undefined) &&
			JSON.stringify((ollamaRegistration.config.models as Array<Record<string, unknown>>).map((model) => pickModelFields(model))) ===
				JSON.stringify(
					mirroredRuntimeModels.map((model) =>
						pickModelFields({ ...(model as unknown as Record<string, unknown>), api: undefined }),
					),
				),
		ollamaRegistration,
	);
	assert(
		"does not override the base ollama-cloud provider",
		ollamaPi.registeredProviders.every((entry) => entry.name !== OLLAMA_CLOUD_PROVIDER),
		ollamaPi.registeredProviders,
	);

	const savedOllamaEnv = process.env.OLLAMA_API_KEY;
	process.env.OLLAMA_API_KEY = "env-ollama-key";
	const envOllamaPi = createPi();
	const envOllamaStatus = await installOllamaCloudRepairProvider(
		envOllamaPi.pi,
		createContext({ available: runtimeAvailableModels }),
	);
	assert(
		"falls back to OLLAMA_API_KEY when stored ollama auth is absent",
		envOllamaStatus.registered === true && envOllamaStatus.authSource === "env",
		envOllamaStatus,
	);

	const bootstrapDir = mkdtempSync(join(tmpdir(), "pi-tool-repair-"));
	const bootstrapAuthPath = join(bootstrapDir, "auth.json");
	const bootstrapCachePath = join(bootstrapDir, "ollama-cloud-models.json");
	writeFileSync(
		bootstrapAuthPath,
		JSON.stringify({
			[OPENCODE_GO_PROVIDER]: { type: "api_key", key: "bootstrap-opencode-key" },
			[OLLAMA_CLOUD_PROVIDER]: { type: "api_key", key: "bootstrap-ollama-key" },
		}),
	);
	writeFileSync(
		bootstrapCachePath,
		JSON.stringify({
			timestamp: Date.now(),
			models: {
				"kimi-k2.6": {
					capabilities: ["completion", "thinking", "tools", "vision"],
					model_info: { "kimi-k2.context_length": 262144 },
				},
			},
		}),
	);
	const bootstrapPi = createPi();
	const bootstrapOpencodeStatus = await bootstrapInstallOpencodeGoRepairProvider(bootstrapPi.pi, {
		authPath: bootstrapAuthPath,
	});
	const bootstrapOllamaStatus = await bootstrapInstallOllamaCloudRepairProvider(bootstrapPi.pi, {
		authPath: bootstrapAuthPath,
		cachePath: bootstrapCachePath,
	});
	assert(
		"bootstrap installs opencode-go-repair before session context exists",
		bootstrapOpencodeStatus.registered === true &&
			bootstrapPi.registeredProviders.some((entry) => entry.name === OPENCODE_GO_REPAIR_PROVIDER),
		bootstrapPi.registeredProviders,
	);
	assert(
		"bootstrap installs ollama-cloud-repair from cache before session context exists",
		bootstrapOllamaStatus.registered === true &&
			bootstrapPi.registeredProviders.some((entry) => entry.name === OLLAMA_CLOUD_REPAIR_PROVIDER),
		bootstrapPi.registeredProviders,
	);
	assert(
		"bootstrap registrations use repaired shim api",
		bootstrapPi.registeredProviders.every((entry) => entry.config.api === REPAIRED_OPENAI_COMPLETIONS_API),
		bootstrapPi.registeredProviders,
	);

	const modelsJsonDir = mkdtempSync(join(tmpdir(), "pi-tool-repair-models-"));
	const modelsJsonPath = join(modelsJsonDir, "models.json");
	const missingBootstrapAuthPath = join(modelsJsonDir, "missing-auth.json");
	writeFileSync(
		modelsJsonPath,
		JSON.stringify({
			providers: {
				[OPENCODE_GO_PROVIDER]: { apiKey: "models-json-opencode-key" },
			},
		}),
	);
	const bootstrapModelsPi = createPi();
	const savedBootstrapOpencodeEnv = process.env.OPENCODE_API_KEY;
	delete process.env.OPENCODE_API_KEY;
	const bootstrapModelsStatus = await bootstrapInstallOpencodeGoRepairProvider(bootstrapModelsPi.pi, {
		authPath: missingBootstrapAuthPath,
		modelsPath: modelsJsonPath,
	});
	assert(
		"bootstrap uses models.json provider auth when auth file and env are absent",
		bootstrapModelsStatus.registered === true && bootstrapModelsStatus.authSource === "models-json",
		bootstrapModelsStatus,
	);
	rmSync(modelsJsonDir, { recursive: true, force: true });
	if (savedBootstrapOpencodeEnv === undefined) {
		delete process.env.OPENCODE_API_KEY;
	} else {
		process.env.OPENCODE_API_KEY = savedBootstrapOpencodeEnv;
	}
	rmSync(bootstrapDir, { recursive: true, force: true });
	if (savedOllamaEnv === undefined) {
		delete process.env.OLLAMA_API_KEY;
	} else {
		process.env.OLLAMA_API_KEY = savedOllamaEnv;
	}

	const noModelsPi = createPi();
	const noModelsStatus = await installRepairedProvider(noModelsPi.pi, createContext({ apiKey: "stored-opencode-key" }), {
		baseProvider: OPENCODE_GO_PROVIDER,
		repairedProvider: OPENCODE_GO_REPAIR_PROVIDER,
		displayName: "OpenCode Go (repaired)",
		apiKeyEnvVar: "OPENCODE_API_KEY",
		loadModels: async () => [],
	});
	assert("skips cleanly when mirrored models are unavailable", noModelsStatus.registered === false && noModelsStatus.reason === "missing-models", noModelsStatus);
	assert("does not register sibling provider when models are unavailable", noModelsPi.registeredProviders.length === 0, noModelsPi.registeredProviders);
	assert(
		"unregisters sibling provider when models are unavailable",
		noModelsPi.unregisteredProviders.includes(OPENCODE_GO_REPAIR_PROVIDER),
		noModelsPi.unregisteredProviders,
	);

	const savedOpencodeEnv = process.env.OPENCODE_API_KEY;
	delete process.env.OPENCODE_API_KEY;
	const noAuthPi = createPi();
	const noAuthStatus = await installRepairedProvider(noAuthPi.pi, createContext(), {
		baseProvider: OPENCODE_GO_PROVIDER,
		repairedProvider: OPENCODE_GO_REPAIR_PROVIDER,
		displayName: "OpenCode Go (repaired)",
		apiKeyEnvVar: "OPENCODE_API_KEY",
		loadModels: async () => mirroredModels as any,
	});
	assert("skips cleanly when auth is unavailable", noAuthStatus.registered === false && noAuthStatus.reason === "missing-auth", noAuthStatus);
	assert("does not register sibling provider when auth is unavailable", noAuthPi.registeredProviders.length === 0, noAuthPi.registeredProviders);
	assert(
		"unregisters sibling provider when auth is unavailable",
		noAuthPi.unregisteredProviders.includes(OPENCODE_GO_REPAIR_PROVIDER),
		noAuthPi.unregisteredProviders,
	);
	if (savedOpencodeEnv === undefined) {
		delete process.env.OPENCODE_API_KEY;
	} else {
		process.env.OPENCODE_API_KEY = savedOpencodeEnv;
	}

	const noOllamaModelsPi = createPi();
	const noOllamaModelsStatus = await installOllamaCloudRepairProvider(
		noOllamaModelsPi.pi,
		createContext({ apiKeys: { [OLLAMA_CLOUD_PROVIDER]: "stored-ollama-key" } }),
	);
	assert(
		"skips ollama-cloud-repair cleanly when runtime models are unavailable",
		noOllamaModelsStatus.registered === false && noOllamaModelsStatus.reason === "missing-models",
		noOllamaModelsStatus,
	);
	assert(
		"does not register ollama-cloud-repair when runtime models are unavailable",
		noOllamaModelsPi.registeredProviders.length === 0,
		noOllamaModelsPi.registeredProviders,
	);

	delete process.env.OLLAMA_API_KEY;
	const noOllamaAuthPi = createPi();
	const noOllamaAuthStatus = await installOllamaCloudRepairProvider(
		noOllamaAuthPi.pi,
		createContext({ available: runtimeAvailableModels }),
	);
	assert(
		"skips ollama-cloud-repair cleanly when auth is unavailable",
		noOllamaAuthStatus.registered === false && noOllamaAuthStatus.reason === "missing-auth",
		noOllamaAuthStatus,
	);
	assert(
		"does not register ollama-cloud-repair when auth is unavailable",
		noOllamaAuthPi.registeredProviders.length === 0,
		noOllamaAuthPi.registeredProviders,
	);

	const extensionPi = createPi();
	await repairExtension(extensionPi.pi);
	const sessionStart = extensionPi.events.get("session_start");
	const refreshCommand = extensionPi.commands.get("repair-provider-refresh");
	assert("wires session_start provider registration", typeof sessionStart === "function");
	assert("registers repair-provider-refresh command", typeof refreshCommand?.handler === "function", refreshCommand);
	if (sessionStart) {
		await sessionStart(
			{},
			createContext({
				apiKeys: {
					[OPENCODE_GO_PROVIDER]: "stored-opencode-key",
					[OLLAMA_CLOUD_PROVIDER]: "stored-ollama-key",
				},
				available: [...runtimeAvailableModels, ...(sourceModels as unknown as Array<Record<string, unknown>>)],
			}),
		);
	}
	assert(
		"session_start installs opencode-go repaired sibling provider",
		extensionPi.registeredProviders.some((entry) => entry.name === OPENCODE_GO_REPAIR_PROVIDER),
		extensionPi.registeredProviders,
	);
	assert(
		"session_start installs ollama-cloud repaired sibling provider",
		extensionPi.registeredProviders.some((entry) => entry.name === OLLAMA_CLOUD_REPAIR_PROVIDER),
		extensionPi.registeredProviders,
	);
	if (refreshCommand) {
		await refreshCommand.handler(
			"",
			createContext({
				apiKeys: {
					[OPENCODE_GO_PROVIDER]: "stored-opencode-key",
					[OLLAMA_CLOUD_PROVIDER]: "stored-ollama-key",
				},
				available: [...runtimeAvailableModels, ...(sourceModels as unknown as Array<Record<string, unknown>>)],
			}),
		);
	}
	assert(
		"refresh command re-registers opencode-go-repair",
		extensionPi.unregisteredProviders.filter((name) => name === OPENCODE_GO_REPAIR_PROVIDER).length >= 2,
		extensionPi.unregisteredProviders,
	);
	assert(
		"refresh command re-registers ollama-cloud-repair",
		extensionPi.unregisteredProviders.filter((name) => name === OLLAMA_CLOUD_REPAIR_PROVIDER).length >= 2,
		extensionPi.unregisteredProviders,
	);

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

void main();
