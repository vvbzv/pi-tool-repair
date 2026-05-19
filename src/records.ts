export type RepairStage = "raw-json" | "prepare-arguments" | "tool-call";

export type RepairType =
	| "null-omit"
	| "json-parse"
	| "split-lines"
	| "wrap-string-array"
	| "empty-object-array"
	| "strip-md-link"
	| "close-braces"
	| "scalar-coerce"
	| "relation-default"
	| "mcp-args-stringify";

export interface RepairRecord {
	type: RepairType;
	path: string;
	stage: RepairStage;
	toolName?: string;
	detail?: string;
}

function displayType(type: RepairType): string {
	switch (type) {
		case "null-omit":
			return "null→omit";
		case "mcp-args-stringify":
			return "stringify";
		case "wrap-string-array":
			return "string→array";
		case "empty-object-array":
			return "{}→[]";
		case "relation-default":
			return "relation-default";
		default:
			return type;
	}
}

function displayDetail(record: RepairRecord): string {
	if (!record.detail) return "";
	return ` (${record.detail})`;
}

export function formatRepairRecord(record: unknown): string {
	if (typeof record === "string") return record;
	if (!record || typeof record !== "object") return String(record);
	const typed = record as RepairRecord;
	return `${displayType(typed.type)} ${typed.path}${displayDetail(typed)}`;
}

export function withRepairStage(
	records: RepairRecord[],
	stage: RepairStage,
	toolName?: string,
): RepairRecord[] {
	return records.map((record) => ({
		...record,
		stage,
		toolName: record.toolName ?? toolName,
	}));
}
