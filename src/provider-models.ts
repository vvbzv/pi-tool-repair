import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const OPENCODE_GO_REPAIR_PROVIDER = "opencode-go-repair";
export const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";
export const OLLAMA_CLOUD_REPAIR_PROVIDER = "ollama-cloud-repair";
export const REPAIRED_OLLAMA_BASE_URL = "https://ollama.com/v1";

const DEFAULT_OLLAMA_MAX_TOKENS = 32768;
const DEFAULT_OLLAMA_CONTEXT_WINDOW = 128000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_OLLAMA_THINKING_LEVEL_MAP = {
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
} as const;

interface OllamaCloudCacheEntry {
	model_info?: Record<string, unknown>;
	capabilities?: string[];
}

interface OllamaCloudCache {
	models?: Record<string, OllamaCloudCacheEntry>;
}

export function mirrorProviderModel<TApi extends Api>(
	model: Model<TApi>,
	provider: string,
): Model<TApi> {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		provider,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: [...model.input],
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: model.headers ? { ...model.headers } : undefined,
		compat: model.compat ? { ...model.compat } : undefined,
	};
}

export function toProviderModelConfig<TApi extends Api>(
	model: Model<TApi>,
	options: { api?: Api } = {},
): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		api: options.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		input: [...model.input],
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: model.headers ? { ...model.headers } : undefined,
		compat: model.compat ? { ...model.compat } : undefined,
	};
}

export async function mirrorBuiltInProviderModels(
	provider: "opencode-go",
	repairedProvider: string,
): Promise<Model<"openai-completions">[]>;
export async function mirrorBuiltInProviderModels(
	provider: string,
	repairedProvider: string,
): Promise<Model<Api>[]>;
export async function mirrorBuiltInProviderModels(
	provider: string,
	repairedProvider: string,
): Promise<Model<Api>[]> {
	const { getModels } = await import("@earendil-works/pi-ai");
	return getModels(provider as never).map((model) => mirrorProviderModel(model, repairedProvider));
}

export async function mirrorRuntimeProviderModels(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	provider: string,
	repairedProvider: string,
): Promise<Model<Api>[]> {
	const models = await ctx.modelRegistry.getAvailable();
	return models
		.filter((model) => model.provider === provider)
		.map((model) => mirrorProviderModel(model, repairedProvider));
}

function ollamaContextWindow(modelInfo: Record<string, unknown> | undefined): number {
	if (!modelInfo) return DEFAULT_OLLAMA_CONTEXT_WINDOW;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return DEFAULT_OLLAMA_CONTEXT_WINDOW;
}

function bootstrapOllamaModel(
	id: string,
	entry: OllamaCloudCacheEntry,
	repairedProvider: string,
): Model<"openai-completions"> | undefined {
	const capabilities = entry.capabilities ?? [];
	if (!capabilities.includes("tools")) return undefined;
	const reasoning = capabilities.includes("thinking");
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: repairedProvider,
		baseUrl: REPAIRED_OLLAMA_BASE_URL,
		reasoning,
		thinkingLevelMap: reasoning ? { ...DEFAULT_OLLAMA_THINKING_LEVEL_MAP } : undefined,
		input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: { ...ZERO_COST },
		contextWindow: ollamaContextWindow(entry.model_info),
		maxTokens: DEFAULT_OLLAMA_MAX_TOKENS,
	};
}

export function mirrorOllamaCloudProviderModelsFromCache(
	repairedProvider: string = OLLAMA_CLOUD_REPAIR_PROVIDER,
	cachePath: string = join(homedir(), ".pi", "agent", "cache", "ollama-cloud-models.json"),
): Model<"openai-completions">[] {
	if (!existsSync(cachePath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as OllamaCloudCache;
		const entries = parsed.models ?? {};
		return Object.entries(entries)
			.map(([id, entry]) => bootstrapOllamaModel(id, entry, repairedProvider))
			.filter((model): model is Model<"openai-completions"> => Boolean(model));
	} catch {
		return [];
	}
}

export async function mirrorOllamaCloudProviderModels(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	repairedProvider: string = OLLAMA_CLOUD_REPAIR_PROVIDER,
): Promise<Model<"openai-completions">[]> {
	const models = await mirrorRuntimeProviderModels(
		ctx,
		OLLAMA_CLOUD_PROVIDER,
		repairedProvider,
	);
	return models.filter(
		(model): model is Model<"openai-completions"> => model.api === "openai-completions",
	);
}
