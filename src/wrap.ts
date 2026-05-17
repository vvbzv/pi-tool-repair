import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { repairArgsWithSchema } from "./schema-repair";

export function withToolRepair<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
	const existingPrepare = tool.prepareArguments;
	return {
		...tool,
		prepareArguments(args: unknown): Static<TParams> {
			const prepared = existingPrepare ? existingPrepare(args) : args;
			const repaired = repairArgsWithSchema(prepared, tool.parameters, {
				stage: "prepare-arguments",
				toolName: tool.name,
			});
			return repaired.value as Static<TParams>;
		},
	};
}
