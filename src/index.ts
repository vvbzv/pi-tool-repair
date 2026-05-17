/**
 * pi-tool-repair — Validate-then-repair middleware for Pi agent tool calls.
 *
 * Applies the harness-engineering patterns pioneered by Ahmad Awais / Reasonix:
 *   - Remove null values where optional fields should be omitted
 *   - Parse JSON-stringified arrays/objects back to proper types
 *   - Fix container mismatches (multi-line string → string array)
 *   - Strip accidental Markdown autolinks from file paths
 *   - Close unclosed braces in truncated JSON strings
 *
 * Designed for open models (DeepSeek, Kimi, Qwen, GLM) that often know
 * the right thing but violate strict tool contracts. Closed models see
 * these contracts millions of times in training; open models don't.
 * A forgiving harness closes the gap without a single extra LLM call.
 *
 * All repairs are logged and surfaced as a compact footer status line.
 *
 * Install:  pi install git:github.com/yanapattin-source/pi-tool-repair
 *           or copy this folder into ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RepairRecord } from "./records";
import { formatRepairRecord } from "./records";
import { isObject, repairArgs } from "./repair";
import { repairArgsWithSchema } from "./schema-repair";
import { buildDoctorReport } from "./doctor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const toolSchemas = new Map<string, unknown>();

function refreshToolSchemas(pi: ExtensionAPI) {
	toolSchemas.clear();
	for (const tool of pi.getAllTools()) {
		toolSchemas.set(tool.name, tool.parameters);
	}
}

/** Pure helper: apply tool-specific + generic repairs to input. */
export function repairToolInput(
	toolName: string,
	input: Record<string, unknown>,
	schema?: unknown,
): RepairRecord[] {
	const fixes: RepairRecord[] = [];

	if (schema) {
		const repaired = repairArgsWithSchema(input, schema, {
			stage: "tool-call",
			toolName,
		});
		if (isObject(repaired.value)) {
			for (const key of Object.keys(input)) delete input[key];
			Object.assign(input, repaired.value);
		}
		fixes.push(...repaired.records);
	}

	if (
		toolName === "mcp" &&
		(isObject(input.args) || Array.isArray(input.args))
	) {
		const args = input.args;

		// Run generic nested repair as a cleanup pass because MCP args are often
		// open-shaped objects even when the outer tool schema is known.
		if (isObject(args)) {
			fixes.push(...repairArgs(args, "$.args"));
		} else {
			(args as unknown[]).forEach((item, i) => {
				if (isObject(item)) fixes.push(...repairArgs(item, `$.args[${i}]`));
			});
		}

		const argsType = Array.isArray(args) ? "array" : "object";
		input.args = JSON.stringify(args);
		fixes.push({ type: "mcp-args-stringify", path: "$.args", stage: "tool-call", detail: `${argsType}→JSON` });
		return fixes;
	}

	if (schema) return fixes;

	fixes.push(...repairArgs(input));
	return fixes;
}

interface RepairStats {
	totalCalls: number;
	repairedCalls: number;
	repairs: Record<string, number>;
	repairTypes: Record<string, number>;
	lastRepair?: string;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function statusLine(stats: RepairStats): string {
	if (stats.repairedCalls === 0) return "repair: 0 fixes";
	const top = Object.entries(stats.repairTypes)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([t, n]) => `${t}:${n}`)
		.join(" ");
	const last = stats.lastRepair
		? ` | ${stats.lastRepair.length > 60 ? stats.lastRepair.slice(0, 60) + "…" : stats.lastRepair}`
		: "";
	return `repair: ${stats.repairedCalls}/${stats.totalCalls} (${top})${last}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const stats: RepairStats = {
		totalCalls: 0,
		repairedCalls: 0,
		repairs: {},
		repairTypes: {},
	};

	// Restore stats from previous sessions
	pi.on("session_start", async (_event, ctx) => {
		refreshToolSchemas(pi);
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				entry.customType === "pi-tool-repair-stats"
			) {
				const data = entry.data as RepairStats | undefined;
				if (data) {
					stats.totalCalls = data.totalCalls || 0;
					stats.repairedCalls = data.repairedCalls || 0;
					stats.repairs = data.repairs || {};
					stats.repairTypes = data.repairTypes || {};
				}
			}
		}
		ctx.ui.setStatus("pi-tool-repair", statusLine(stats));
	});

	pi.on("session_shutdown", async () => {
		pi.appendEntry("pi-tool-repair-stats", { ...stats });
	});


	pi.registerCommand("repair-doctor", {
		description: "Inspect active tool schemas and repair compatibility risks",
		handler: async (_args, _ctx) => {
			const report = buildDoctorReport({
				activeTools: pi.getActiveTools(),
				tools: pi.getAllTools(),
			});
			pi.sendMessage(
				{
					customType: "pi-tool-repair-doctor",
					content: report,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});
	pi.on("agent_start", () => {
		refreshToolSchemas(pi);
	});

	// ── Core: intercept every tool call and repair args ────────────────
	pi.on("tool_call", (event, ctx) => {
		if (!event.input || typeof event.input !== "object") return;

		stats.totalCalls++;
		const input = event.input as Record<string, unknown>;
		const allFixes = repairToolInput(event.toolName, input, toolSchemas.get(event.toolName));

		if (allFixes.length > 0) {
			stats.repairedCalls++;
			stats.repairs[event.toolName] =
				(stats.repairs[event.toolName] || 0) + allFixes.length;

			for (const record of allFixes) {
				stats.repairTypes[record.type] = (stats.repairTypes[record.type] || 0) + 1;
			}

			stats.lastRepair = `${event.toolName}: ${allFixes.map(formatRepairRecord).join(", ")}`;
		}

		ctx.ui.setStatus("pi-tool-repair", statusLine(stats));
	});
}
