export type SchemaKind = "object" | "array" | "string" | "number" | "integer" | "boolean" | "unknown";

export interface SchemaView {
	kind: SchemaKind;
	optional: boolean;
	properties?: Record<string, unknown>;
	items?: unknown;
}

function schemaType(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return undefined;
	return (schema as Record<string, unknown>).type;
}

function unionKinds(schema: unknown): SchemaKind[] {
	if (!schema || typeof schema !== "object") return [];
	const record = schema as Record<string, unknown>;
	const candidates: unknown[] = [];
	if (Array.isArray(record.type)) candidates.push(...record.type);
	for (const key of ["anyOf", "oneOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants)) {
			for (const variant of variants) candidates.push(schemaType(variant));
		}
	}
	return candidates.filter(
		(kind): kind is SchemaKind =>
			kind === "object" ||
			kind === "array" ||
			kind === "string" ||
			kind === "number" ||
			kind === "integer" ||
			kind === "boolean" ||
			kind === "unknown",
	);
}

function primarySchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	const record = schema as Record<string, unknown>;
	for (const key of ["anyOf", "oneOf"] as const) {
		const variants = record[key];
		if (!Array.isArray(variants)) continue;
		const supported = variants.filter((variant) => {
			const kind = schemaType(variant);
			return kind === "object" || kind === "array" || kind === "string" || kind === "number" || kind === "integer" || kind === "boolean";
		});
		if (supported.length === 1) return supported[0];
	}
	if (Array.isArray(record.type)) {
		const nonNull = record.type.filter((kind) => kind !== "null");
		if (nonNull.length === 1) {
			return { ...record, type: nonNull[0] };
		}
	}
	return schema;
}

export function isOptionalProperty(parentSchema: unknown, key: string): boolean {
	const target = primarySchema(parentSchema);
	if (!target || typeof target !== "object") return false;
	const required = (target as Record<string, unknown>).required;
	return Array.isArray(required) ? !required.includes(key) : true;
}

export function propertySchema(parentSchema: unknown, key: string): unknown {
	const target = primarySchema(parentSchema);
	if (!target || typeof target !== "object") return undefined;
	const props = (target as Record<string, unknown>).properties;
	if (!props || typeof props !== "object") return undefined;
	return (props as Record<string, unknown>)[key];
}

export function schemaView(schema: unknown, optional = false): SchemaView {
	const type = schemaType(schema);
	const directKind: SchemaKind =
		type === "object" ||
		type === "array" ||
		type === "string" ||
		type === "number" ||
		type === "integer" ||
		type === "boolean"
			? type
			: "unknown";
	const union = unionKinds(schema).filter((kind) => kind !== "unknown");
	const kind = directKind !== "unknown"
		? directKind
		: union.length === 1
			? union[0]
			: "unknown";

	const target = primarySchema(schema);
	if (!target || typeof target !== "object") return { kind, optional };
	const record = target as Record<string, unknown>;
	return {
		kind,
		optional,
		properties:
			record.properties && typeof record.properties === "object"
				? (record.properties as Record<string, unknown>)
				: undefined,
		items: record.items,
	};
}

export function isStringArraySchema(schema: unknown): boolean {
	const view = schemaView(schema);
	if (view.kind !== "array") return false;
	return schemaView(view.items).kind === "string";
}
