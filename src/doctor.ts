import type { RepairedProviderInstallStatus } from "./provider-install";
import { propertySchema, schemaView } from "./schema";

interface DoctorSourceInfo {
	source: string;
	origin: string;
}

export interface DoctorToolInfo {
	name: string;
	description?: string;
	parameters: unknown;
	sourceInfo: DoctorSourceInfo;
}

export interface DoctorInput {
	activeTools: string[];
	tools: DoctorToolInfo[];
	providerStatuses: RepairedProviderInstallStatus[];
}

interface ToolRisk {
	name: string;
	source: string;
	origin: string;
	containerPaths: string[];
	scalarPaths: string[];
}

function collectRisks(schema: unknown, path: string, out: { containerPaths: string[]; scalarPaths: string[] }) {
	const view = schemaView(schema);
	if (view.kind === "object") {
		if (path !== "$") out.containerPaths.push(path);
		for (const [key] of Object.entries(view.properties ?? {})) {
			collectRisks(propertySchema(schema, key), `${path}.${key}`, out);
		}
		return;
	}

	if (view.kind === "array") {
		out.containerPaths.push(path);
		collectRisks(view.items, `${path}[]`, out);
		return;
	}

	if (view.kind === "number" || view.kind === "integer" || view.kind === "boolean") {
		out.scalarPaths.push(`${path} (${view.kind})`);
	}
}

function analyzeTool(tool: DoctorToolInfo): ToolRisk | undefined {
	const out = { containerPaths: [] as string[], scalarPaths: [] as string[] };
	collectRisks(tool.parameters, "$", out);
	if (out.containerPaths.length === 0 && out.scalarPaths.length === 0) return undefined;
	return {
		name: tool.name,
		source: tool.sourceInfo.source,
		origin: tool.sourceInfo.origin,
		containerPaths: out.containerPaths,
		scalarPaths: out.scalarPaths,
	};
}

function bulletList(values: string[]): string {
	return values.map((value) => `  - ${value}`).join("\n");
}

function isBaseProviderAvailable(status: RepairedProviderInstallStatus): boolean {
	return status.registered || status.modelCount > 0;
}

function formatAuthStatus(status: RepairedProviderInstallStatus): string {
	if (status.authConfigured) {
		return status.authSource ? `yes (${status.authSource})` : "yes";
	}
	return "no";
}

function formatSkipReason(status: RepairedProviderInstallStatus): string | undefined {
	if (status.reason === "missing-auth") {
		return `${status.baseProvider} has no configured API key in Pi or its fallback environment variable`;
	}
	if (status.reason === "missing-models") {
		return `${status.baseProvider} is unavailable or has no mirrorable openai-completions models`;
	}
	return undefined;
}

export function buildDoctorReport(input: DoctorInput): string {
	const active = new Set(input.activeTools);
	const activeTools = input.tools.filter((tool) => active.has(tool.name));
	const risks = activeTools.map(analyzeTool).filter((risk): risk is ToolRisk => Boolean(risk));
	const hasMcp = active.has("mcp");

	const lines: string[] = [
		"# pi-tool-repair doctor",
		"",
		`- Active tools checked: ${activeTools.length} of ${input.tools.length}`,
		`- MCP gateway detected: ${hasMcp ? "yes" : "no"}`,
		"- Pre-validation wrapper visibility: Pi cannot verify whether third-party tools already use `prepareArguments`.",
		"- Current repair layer: post-validation `tool_call` cleanup plus opt-in `withToolRepair()` for pre-validation repair.",
		"",
		"## Active tool compatibility risks",
	];

	if (risks.length === 0) {
		lines.push("", "No active tools with object/array/numeric/boolean argument shapes were detected.");
	} else {
		for (const risk of risks) {
			lines.push("", `### \`${risk.name}\` (${risk.source})`);
			if (risk.containerPaths.length > 0) {
				lines.push("- Container-shaped parameters:", bulletList(risk.containerPaths));
			}
			if (risk.scalarPaths.length > 0) {
				lines.push("- Scalar coercion candidates:", bulletList(risk.scalarPaths));
			}
			if (risk.origin === "top-level") {
				lines.push("- Action: built-in/top-level tools still depend on Pi/provider pre-validation support for validation-blocking failures.");
			} else {
				lines.push("- Action: if this tool misformats arguments before validation, wrap it with `withToolRepair()` in its owning extension.");
			}
		}
	}

	lines.push("", "## Provider shims");
	if (input.providerStatuses.length === 0) {
		lines.push("", "No repaired sibling providers have been checked yet. Run `/repair-provider-refresh`.");
	} else {
		for (const status of input.providerStatuses) {
			lines.push(
				"",
				`### \`${status.provider}\``,
				`- Base provider: \`${status.baseProvider}\``,
				`- Base provider available: ${isBaseProviderAvailable(status) ? "yes" : "no"}`,
				`- Repaired provider: \`${status.provider}\``,
				`- Registered: ${status.registered ? "yes" : "no"}`,
				`- Auth configured: ${formatAuthStatus(status)}`,
				`- Mirrored model count: ${status.modelCount}`,
			);
			const skipReason = formatSkipReason(status);
			if (skipReason) {
				lines.push(`- Skip reason: ${skipReason}`);
			}
			if (status.baseProvider === "ollama-cloud") {
				lines.push("- Note: requires `pi-ollama-cloud` to be installed and registered first; run `/repair-provider-refresh` after its model list changes.");
			}
		}
	}

	lines.push(
		"",
		"## Notes",
		"",
		"- `/repair-provider-refresh` re-runs repaired sibling provider registration against Pi's current model registry.",
		"- MCP gateway args are normalized back to a JSON string at execution time when container-shaped args reach this extension.",
		"- This report inspects advertised schemas, not live `prepareArguments` implementations.",
		"- String fields are intentionally preserved unless they are path-like Markdown autolinks such as `<src/file.ts>`.",
	);

	return lines.join("\n");
}
