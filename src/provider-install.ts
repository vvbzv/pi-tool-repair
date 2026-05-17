import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	mirrorBuiltInProviderModels,
	mirrorOllamaCloudProviderModels,
	mirrorOllamaCloudProviderModelsFromCache,
	mirrorRuntimeProviderModels,
	OLLAMA_CLOUD_PROVIDER,
	OLLAMA_CLOUD_REPAIR_PROVIDER,
	OPENCODE_GO_PROVIDER,
	OPENCODE_GO_REPAIR_PROVIDER,
	toProviderModelConfig,
} from "./provider-models";
import {
	registerRepairedOpenAICompletionsProvider,
	REPAIRED_OPENAI_COMPLETIONS_API,
	streamSimpleOpenAICompletionsWithRepair,
	unregisterRepairedOpenAICompletionsProvider,
} from "./provider-shim";

export interface RepairedProviderInstallStatus {
	baseProvider: string;
	provider: string;
	registered: boolean;
	modelCount: number;
	reason?: "missing-auth" | "missing-models";
	authConfigured?: boolean;
	authSource?: "registry" | "env" | "stored-file" | "models-json";
}

export interface RepairedProviderSpec {
	baseProvider: string;
	repairedProvider: string;
	displayName: string;
	apiKeyEnvVar: string;
	loadModels(ctx: ExtensionContext): Promise<Model<"openai-completions">[]> | Model<"openai-completions">[];
}

interface BootstrapOptions {
	authPath?: string;
	modelsPath?: string;
	cachePath?: string;
}

const DEFAULT_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_MODELS_PATH = join(homedir(), ".pi", "agent", "models.json");

function resolveApiKey(
	registryApiKey: string | undefined,
	envVarName: string,
): Pick<RepairedProviderInstallStatus, "authSource"> & { apiKey?: string } {
	if (registryApiKey) {
		return { apiKey: registryApiKey, authSource: "registry" };
	}

	const envApiKey = process.env[envVarName];
	if (envApiKey) {
		return { apiKey: envApiKey, authSource: "env" };
	}

	return {};
}

function resolveConfigValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("!")) {
		try {
			const output = execSync(value.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			return output || undefined;
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("$")) {
		return process.env[value.slice(1)] || undefined;
	}
	return value;
}

function readStoredApiKey(provider: string, authPath: string = DEFAULT_AUTH_PATH): string | undefined {
	if (!existsSync(authPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
		const entry = parsed[provider];
		return entry?.type === "api_key" && typeof entry.key === "string" ? entry.key : undefined;
	} catch {
		return undefined;
	}
}

function stripJsonCommentsAndTrailingCommas(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match.startsWith("\"") ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => (match.startsWith("\"") ? match : tail ?? ""));
}

function readModelsJsonApiKey(
	provider: string,
	modelsPath: string = DEFAULT_MODELS_PATH,
): string | undefined {
	if (!existsSync(modelsPath)) return undefined;
	try {
		const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(readFileSync(modelsPath, "utf8"))) as {
			providers?: Record<string, { apiKey?: string }>;
		};
		return resolveConfigValue(parsed.providers?.[provider]?.apiKey);
	} catch {
		return undefined;
	}
}

function resolveBootstrapApiKey(
	provider: string,
	envVarName: string,
	options: BootstrapOptions = {},
): Pick<RepairedProviderInstallStatus, "authSource"> & { apiKey?: string } {
	const storedApiKey = readStoredApiKey(provider, options.authPath);
	if (storedApiKey) {
		return { apiKey: storedApiKey, authSource: "stored-file" };
	}

	const modelsApiKey = readModelsJsonApiKey(provider, options.modelsPath);
	if (modelsApiKey) {
		return { apiKey: modelsApiKey, authSource: "models-json" };
	}

	return resolveApiKey(undefined, envVarName);
}

function unregisterProvider(pi: ExtensionAPI, provider: string) {
	unregisterRepairedOpenAICompletionsProvider(provider);
	try {
		pi.unregisterProvider(provider);
	} catch {
		// No-op: refresh should stay idempotent even if the sibling provider was never registered.
	}
}

function toProviderConfig(
	displayName: string,
	apiKey: string,
	models: Model<"openai-completions">[],
): ProviderConfig {
	return {
		name: displayName,
		api: REPAIRED_OPENAI_COMPLETIONS_API,
		apiKey,
		baseUrl: models[0]?.baseUrl,
		models: models.map((model) => toProviderModelConfig(model)),
		streamSimple: streamSimpleOpenAICompletionsWithRepair as ProviderConfig["streamSimple"],
	};
}

function registerProvider(
	pi: ExtensionAPI,
	spec: Pick<RepairedProviderSpec, "repairedProvider" | "displayName">,
	apiKey: string,
	models: Model<"openai-completions">[],
) {
	unregisterProvider(pi, spec.repairedProvider);
	pi.registerProvider(spec.repairedProvider, toProviderConfig(spec.displayName, apiKey, models));
	registerRepairedOpenAICompletionsProvider(spec.repairedProvider);
}

function missingStatus(
	spec: Pick<RepairedProviderSpec, "baseProvider" | "repairedProvider">,
	modelCount: number,
	reason: "missing-auth" | "missing-models",
	authConfigured: boolean,
	authSource?: RepairedProviderInstallStatus["authSource"],
): RepairedProviderInstallStatus {
	return {
		baseProvider: spec.baseProvider,
		provider: spec.repairedProvider,
		registered: false,
		modelCount,
		reason,
		authConfigured,
		authSource,
	};
}

export async function installRepairedProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	spec: RepairedProviderSpec,
): Promise<RepairedProviderInstallStatus> {
	const models = await Promise.resolve(spec.loadModels(ctx));
	const registryApiKey = await ctx.modelRegistry.getApiKeyForProvider(spec.baseProvider);
	const auth = resolveApiKey(registryApiKey, spec.apiKeyEnvVar);
	if (!auth.apiKey) {
		unregisterProvider(pi, spec.repairedProvider);
		return missingStatus(spec, models.length, "missing-auth", false);
	}
	if (models.length === 0) {
		unregisterProvider(pi, spec.repairedProvider);
		return missingStatus(spec, 0, "missing-models", true, auth.authSource);
	}

	registerProvider(pi, spec, auth.apiKey, models);
	return {
		baseProvider: spec.baseProvider,
		provider: spec.repairedProvider,
		registered: true,
		modelCount: models.length,
		authConfigured: true,
		authSource: auth.authSource,
	};
}

async function bootstrapInstallRepairedProvider(
	pi: ExtensionAPI,
	spec: Pick<RepairedProviderSpec, "baseProvider" | "repairedProvider" | "displayName" | "apiKeyEnvVar">,
	models: Promise<Model<"openai-completions">[]> | Model<"openai-completions">[],
	options: BootstrapOptions = {},
): Promise<RepairedProviderInstallStatus> {
	const resolvedModels = await Promise.resolve(models);
	const auth = resolveBootstrapApiKey(spec.baseProvider, spec.apiKeyEnvVar, options);
	if (!auth.apiKey) {
		unregisterProvider(pi, spec.repairedProvider);
		return missingStatus(spec, resolvedModels.length, "missing-auth", false);
	}
	if (resolvedModels.length === 0) {
		unregisterProvider(pi, spec.repairedProvider);
		return missingStatus(spec, 0, "missing-models", true, auth.authSource);
	}
	registerProvider(pi, spec, auth.apiKey, resolvedModels);
	return {
		baseProvider: spec.baseProvider,
		provider: spec.repairedProvider,
		registered: true,
		modelCount: resolvedModels.length,
		authConfigured: true,
		authSource: auth.authSource,
	};
}

export async function bootstrapInstallOpencodeGoRepairProvider(
	pi: ExtensionAPI,
	options: BootstrapOptions = {},
): Promise<RepairedProviderInstallStatus> {
	return bootstrapInstallRepairedProvider(
		pi,
		{
			baseProvider: OPENCODE_GO_PROVIDER,
			repairedProvider: OPENCODE_GO_REPAIR_PROVIDER,
			displayName: "OpenCode Go (repaired)",
			apiKeyEnvVar: "OPENCODE_API_KEY",
		},
		mirrorBuiltInProviderModels(OPENCODE_GO_PROVIDER, OPENCODE_GO_REPAIR_PROVIDER) as Promise<Model<"openai-completions">[]>,
		options,
	);
}

export async function bootstrapInstallOllamaCloudRepairProvider(
	pi: ExtensionAPI,
	options: BootstrapOptions = {},
): Promise<RepairedProviderInstallStatus> {
	return bootstrapInstallRepairedProvider(
		pi,
		{
			baseProvider: OLLAMA_CLOUD_PROVIDER,
			repairedProvider: OLLAMA_CLOUD_REPAIR_PROVIDER,
			displayName: "Ollama Cloud (repaired)",
			apiKeyEnvVar: "OLLAMA_API_KEY",
		},
		mirrorOllamaCloudProviderModelsFromCache(OLLAMA_CLOUD_REPAIR_PROVIDER, options.cachePath),
		options,
	);
}

export async function installOpencodeGoRepairProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<RepairedProviderInstallStatus> {
	return installRepairedProvider(pi, ctx, {
		baseProvider: OPENCODE_GO_PROVIDER,
		repairedProvider: OPENCODE_GO_REPAIR_PROVIDER,
		displayName: "OpenCode Go (repaired)",
		apiKeyEnvVar: "OPENCODE_API_KEY",
		loadModels: async () =>
			await mirrorRuntimeProviderModels(
				ctx,
				OPENCODE_GO_PROVIDER,
				OPENCODE_GO_REPAIR_PROVIDER,
			) as Model<"openai-completions">[],
	});
}

export async function installOllamaCloudRepairProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<RepairedProviderInstallStatus> {
	return installRepairedProvider(pi, ctx, {
		baseProvider: OLLAMA_CLOUD_PROVIDER,
		repairedProvider: OLLAMA_CLOUD_REPAIR_PROVIDER,
		displayName: "Ollama Cloud (repaired)",
		apiKeyEnvVar: "OLLAMA_API_KEY",
		loadModels: async () =>
			await mirrorOllamaCloudProviderModels(
				ctx,
				OLLAMA_CLOUD_REPAIR_PROVIDER,
			),
	});
}

export function formatRepairedProviderInstallStatus(
	status: RepairedProviderInstallStatus,
): string {
	if (status.registered) {
		return `${status.provider}: registered ${status.modelCount} mirrored models from ${status.baseProvider}`;
	}

	if (status.reason === "missing-models") {
		return `${status.provider}: skipped because ${status.baseProvider} models are unavailable`;
	}

	if (status.reason === "missing-auth") {
		return `${status.provider}: skipped because ${status.baseProvider} auth is unavailable`;
	}

	return `${status.provider}: skipped`;
}
