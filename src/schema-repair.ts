import type { RepairRecord, RepairStage } from "./records";
import { STRING_CONTENT_KEYS, closeUnclosedBraces } from "./repair";
import { isOptionalProperty, isStringArraySchema, propertySchema, schemaView } from "./schema";

export interface SchemaRepairOptions {
	toolName?: string;
	stage: RepairStage;
	path?: string;
	optional?: boolean;
}

export interface SchemaRepairResult<T = unknown> {
	value: T;
	records: RepairRecord[];
}

function safeJsonContainerParse(value: string): unknown | undefined {
	const trimmed = value.trim();
	if (trimmed.length <= 1) return undefined;
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!schema || typeof schema !== "object") return false;
	const record = schema as Record<string, unknown>;
	if (record.type === "null") return true;
	if (Array.isArray(record.type) && record.type.includes("null")) return true;
	for (const key of ["anyOf", "oneOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(schemaAllowsNull)) return true;
	}
	return false;
}

function safeNumber(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return undefined;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : undefined;
}

function safeBoolean(value: string): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function stripMarkdownAutolink(value: string, path: string): string | undefined {
	const key = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (key !== "path" && key !== "filepath" && key !== "file_path" && key !== "file") return undefined;
	if (value.length >= 200) return undefined;
	if (!/^<[^>]+\.[a-z]{1,6}>$/i.test(value)) return undefined;
	if (/^<[a-z][a-z0-9+.-]*:/i.test(value) || /^<[^@\s<>]+@[^@\s<>]+>$/i.test(value)) return undefined;
	return value.slice(1, -1);
}

function pathKey(path: string): string {
	const lastDot = path.lastIndexOf(".");
	return lastDot === -1 ? path : path.slice(lastDot + 1);
}

function repairRecord(
	type: RepairRecord["type"],
	path: string,
	options: SchemaRepairOptions,
	detail?: string,
): RepairRecord {
	return { type, path, stage: options.stage, toolName: options.toolName, detail };
}

export function repairArgsWithSchema<T = unknown>(
	value: T,
	schema: unknown,
	options: SchemaRepairOptions,
): SchemaRepairResult<T> {
	const records: RepairRecord[] = [];
	const path = options.path ?? "$";
	const view = schemaView(schema, options.optional ?? false);

	if (value === null && schema !== undefined) {
		if (schemaAllowsNull(schema)) return { value, records };
		if (view.optional) {
			records.push(repairRecord("null-omit", path, options));
			return { value: undefined as T, records };
		}
	}

	if (typeof value === "string") {
		if (view.kind === "array" || view.kind === "object") {
			const parsed = safeJsonContainerParse(value);
			if (parsed !== undefined) {
				if (view.kind === "array" && !Array.isArray(parsed)) return { value, records };
				if (view.kind === "object" && (Array.isArray(parsed) || parsed === null || typeof parsed !== "object")) return { value, records };
				records.push(repairRecord("json-parse", path, options, Array.isArray(parsed) ? "array" : "object"));
				const repaired = repairArgsWithSchema(parsed as T, schema, options);
				records.push(...repaired.records);
				return { value: repaired.value, records };
			}
		}

		if (isStringArraySchema(schema) && value.includes("\n")) {
			const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
			if (lines.length > 1) {
				records.push(repairRecord("split-lines", path, options, `${lines.length} items`));
				return { value: lines as T, records };
			}
		}

		if (view.kind === "number" || view.kind === "integer") {
			const n = safeNumber(value);
			if (n !== undefined && (view.kind === "number" || Number.isInteger(n))) {
				records.push(repairRecord("scalar-coerce", path, options, view.kind));
				return { value: n as T, records };
			}
		}

		if (view.kind === "boolean") {
			const b = safeBoolean(value);
			if (b !== undefined) {
				records.push(repairRecord("scalar-coerce", path, options, "boolean"));
				return { value: b as T, records };
			}
		}


		if (view.kind === "string") {
			const unlinked = stripMarkdownAutolink(value, path);
			if (unlinked !== undefined) {
				records.push(repairRecord("strip-md-link", path, options));
				return { value: unlinked as T, records };
			}
		}

		if (!STRING_CONTENT_KEYS.has(pathKey(path))) {
			const closed = closeUnclosedBraces(value);
			if (closed !== value) {
				records.push(repairRecord("close-braces", path, options));
				if (view.kind === "array" || view.kind === "object") {
					const parsed = safeJsonContainerParse(closed);
					if (parsed !== undefined) {
						if (view.kind === "array" && Array.isArray(parsed)) {
							records.push(repairRecord("json-parse", path, options, "array"));
							const repaired = repairArgsWithSchema(parsed as T, schema, options);
							records.push(...repaired.records);
							return { value: repaired.value, records };
						}
						if (view.kind === "object" && !Array.isArray(parsed)) {
							records.push(repairRecord("json-parse", path, options, "object"));
							const repaired = repairArgsWithSchema(parsed as T, schema, options);
							records.push(...repaired.records);
							return { value: repaired.value, records };
						}
					}
				}
				return { value: closed as T, records };
			}
		}
		return { value, records };
	}

	if (Array.isArray(value)) {
		const itemSchema = view.items;
		const repaired = value.map((item, index) => {
			const child = repairArgsWithSchema(item, itemSchema, { ...options, path: `${path}[${index}]`, optional: false });
			records.push(...child.records);
			return child.value;
		});
		return { value: repaired as T, records };
	}

	if (value && typeof value === "object" && view.kind === "object") {
		const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
		for (const key of Object.keys(output)) {
			const childSchema = propertySchema(schema, key);
			const child = repairArgsWithSchema(output[key], childSchema, {
				...options,
				path: `${path}.${key}`,
				optional: isOptionalProperty(schema, key),
			});
			records.push(...child.records);
			if (child.value === undefined && isOptionalProperty(schema, key)) {
				delete output[key];
			} else {
				output[key] = child.value;
			}
		}
		return { value: output as T, records };
	}

	return { value, records };
}
