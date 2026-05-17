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

	lines.push(
		"",
		"## Notes",
		"",
		"- MCP gateway args are normalized back to a JSON string at execution time when container-shaped args reach this extension.",
		"- This report inspects advertised schemas, not live `prepareArguments` implementations.",
		"- String fields are intentionally preserved unless they are path-like Markdown autolinks such as `<src/file.ts>`.",
	);

	return lines.join("\n");
}
