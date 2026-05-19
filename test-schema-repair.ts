import { formatRepairRecord } from "./src/records";
import { repairArgsWithSchema } from "./src/schema-repair";
import { isOptionalProperty, isStringArraySchema, propertySchema, schemaView } from "./src/schema";
import { editSchema, leanCtxShellSchema, multiEditSchema, readSchema } from "./test-fixtures/tool-schemas";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean) {
	if (condition) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}`);
		failed++;
	}
}

function assertJson(name: string, actual: unknown, expected: unknown) {
	assert(name, JSON.stringify(actual) === JSON.stringify(expected));
}

function assertFixes(name: string, actual: unknown[], expected: string[]) {
	assert(name, actual.map(formatRepairRecord).join(",") === expected.join(","));
}

const schema = {
	type: "object",
	required: ["path"],
	properties: {
		path: { type: "string" },
		limit: { type: "number" },
		paths: { type: "array", items: { type: "string" } },
	},
};

assert("detects object schema", schemaView(schema).kind === "object");
assert("detects required property", isOptionalProperty(schema, "path") === false);
assert("detects optional property", isOptionalProperty(schema, "limit") === true);
assert("gets child schema", schemaView(propertySchema(schema, "limit")).kind === "number");
assert("detects string array", isStringArraySchema(propertySchema(schema, "paths")) === true);

const readRepair = repairArgsWithSchema(
	{ path: "package.json", limit: "10", offset: null },
	readSchema,
	{ stage: "prepare-arguments", toolName: "read" },
);
assertJson("repairs read scalar and optional null", readRepair.value, { path: "package.json", limit: 10, offset: 1 });
assertFixes("records read scalar and optional null", readRepair.records, [
	"scalar-coerce $.limit (number)",
	"null→omit $.offset",
	"relation-default $.offset (limit→offset=1)",
]);

const readPathRepair = repairArgsWithSchema(
	{ path: "<src/utils.ts>" },
	readSchema,
	{ stage: "prepare-arguments", toolName: "read" },
);
assertJson("repairs schema string markdown path", readPathRepair.value, { path: "src/utils.ts" });
assertFixes("records schema string markdown path", readPathRepair.records, ["strip-md-link $.path"]);

const readMarkdownLinkRepair = repairArgsWithSchema(
	{ path: "[notes.md](https://example.test/notes)" },
	readSchema,
	{ stage: "prepare-arguments", toolName: "read" },
);
assertJson("repairs schema markdown linked path", readMarkdownLinkRepair.value, { path: "notes.md" });
assertFixes("records schema markdown linked path", readMarkdownLinkRepair.records, ["strip-md-link $.path"]);

const readLimitOffsetRepair = repairArgsWithSchema(
	{ path: "package.json", limit: "10" },
	readSchema,
	{ stage: "prepare-arguments", toolName: "read" },
);
assertJson("defaults read offset when limit is provided", readLimitOffsetRepair.value, { path: "package.json", limit: 10, offset: 1 });
assertFixes("records read offset relational default", readLimitOffsetRepair.records, [
	"scalar-coerce $.limit (number)",
	"relation-default $.offset (limit→offset=1)",
]);

const emptyArrayRepair = repairArgsWithSchema(
	{ paths: "[]" },
	{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
	{ stage: "prepare-arguments", toolName: "array_tool" },
);
assertJson("repairs empty array container string", emptyArrayRepair.value, { paths: [] });
assertFixes("records empty array container string", emptyArrayRepair.records, ["json-parse $.paths (array)"]);

const emptyObjectArrayRepair = repairArgsWithSchema(
	{ paths: {} },
	{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
	{ stage: "prepare-arguments", toolName: "array_tool" },
);
assertJson("repairs empty object where array expected", emptyObjectArrayRepair.value, { paths: [] });
assertFixes("records empty object where array expected", emptyObjectArrayRepair.records, ["{}→[] $.paths"]);

const stringifiedEmptyObjectArrayRepair = repairArgsWithSchema(
	{ paths: "{}" },
	{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
	{ stage: "prepare-arguments", toolName: "array_tool" },
);
assertJson("repairs stringified empty object where array expected", stringifiedEmptyObjectArrayRepair.value, { paths: [] });
assertFixes("records stringified empty object where array expected", stringifiedEmptyObjectArrayRepair.records, ["{}→[] $.paths"]);

const bareStringArrayRepair = repairArgsWithSchema(
	{ paths: "src/only.ts" },
	{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
	{ stage: "prepare-arguments", toolName: "array_tool" },
);
assertJson("repairs bare string where string array expected", bareStringArrayRepair.value, { paths: ["src/only.ts"] });
assertFixes("records bare string where string array expected", bareStringArrayRepair.records, ["string→array $.paths (1 item)"]);

const linkedPathArrayRepair = repairArgsWithSchema(
	{ paths: "[notes.md](https://example.test/notes)" },
	{ type: "object", required: [], properties: { paths: { type: "array", items: { type: "string" } } } },
	{ stage: "prepare-arguments", toolName: "array_tool" },
);
assertJson("repairs markdown linked path where string array expected", linkedPathArrayRepair.value, { paths: ["notes.md"] });
assertFixes("records markdown linked path where string array expected", linkedPathArrayRepair.records, ["strip-md-link $.paths"]);

const payloadRepair = repairArgsWithSchema(
	{ payload: '{"items":[1,2', limit: "10" },
	{ type: "object", required: [], properties: { payload: { type: "string" }, limit: { type: "number" } } },
	{ stage: "prepare-arguments", toolName: "payload_tool" },
);
assertJson("repairs truncated json-like string alongside scalar coercion", payloadRepair.value, {
	payload: '{"items":[1,2]}',
	limit: 10,
});
assertFixes("records truncated json-like string alongside scalar coercion", payloadRepair.records, [
	"close-braces $.payload",
	"scalar-coerce $.limit (number)",
]);

const truncatedArrayRepair = repairArgsWithSchema(
	{ edits: '[{"oldText":"a","newText":"b"}' },
	editSchema,
	{ stage: "prepare-arguments", toolName: "edit" },
);
assertJson("repairs truncated stringified edit array", truncatedArrayRepair.value, {
	edits: [{ oldText: "a", newText: "b" }],
});
assertFixes("records truncated stringified edit array", truncatedArrayRepair.records, [
	"close-braces $.edits",
	"json-parse $.edits (array)",
]);

const editRepair = repairArgsWithSchema(
	{ path: "x.ts", edits: '[{"oldText":"a","newText":"b"}]' },
	editSchema,
	{ stage: "prepare-arguments", toolName: "edit" },
);
assertJson("repairs stringified edit array", editRepair.value, { path: "x.ts", edits: [{ oldText: "a", newText: "b" }] });
assertFixes("records stringified edit array", editRepair.records, ["json-parse $.edits (array)"]);

const looseArrayRepair = repairArgsWithSchema(
	{ path: "x.ts", edits: "['src/a.ts', 'src/b.ts']" },
	{ type: "object", required: [], properties: { edits: { type: "array", items: { type: "string" } } } },
	{ stage: "prepare-arguments", toolName: "array_tool" },
);
assertJson("repairs single-quoted stringified array", looseArrayRepair.value, { path: "x.ts", edits: ["src/a.ts", "src/b.ts"] });
assertFixes("records single-quoted stringified array", looseArrayRepair.records, ["json-parse $.edits (array)"]);

const mismatchedArrayRepair = repairArgsWithSchema(
	{ path: "x.ts", edits: "{\"oldText\":\"a\",\"newText\":\"b\"}" },
	editSchema,
	{ stage: "prepare-arguments", toolName: "edit" },
);
assertJson("preserves mismatched object for array schema", mismatchedArrayRepair.value, {
	path: "x.ts",
	edits: "{\"oldText\":\"a\",\"newText\":\"b\"}",
});
assertFixes("does not record mismatched object for array schema", mismatchedArrayRepair.records, []);

const patch = "*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** End Patch";
const multiRepair = repairArgsWithSchema(
	{ patch },
	multiEditSchema,
	{ stage: "prepare-arguments", toolName: "edit" },
);
assertJson("preserves multi-edit patch string", multiRepair.value, { patch });
assertFixes("does not record multi-edit patch repair", multiRepair.records, []);

const multiArrayRepair = repairArgsWithSchema(
	{ path: "x.ts", multi: '[{"oldText":"a","newText":"b"}]' },
	multiEditSchema,
	{ stage: "prepare-arguments", toolName: "edit" },
);
assertJson("repairs multi-edit stringified multi array", multiArrayRepair.value, {
	path: "x.ts",
	multi: [{ oldText: "a", newText: "b" }],
});

const command = "printf '{not json}'\necho done";
const leanRepair = repairArgsWithSchema(
	{ command },
	leanCtxShellSchema,
	{ stage: "prepare-arguments", toolName: "ctx_shell" },
);
assertJson("preserves lean-ctx shell command", leanRepair.value, { command });
assertFixes("does not record lean-ctx command repair", leanRepair.records, []);

const leanAutolinkRepair = repairArgsWithSchema(
	{ command: "<build.sh>" },
	leanCtxShellSchema,
	{ stage: "prepare-arguments", toolName: "ctx_shell" },
);
assertJson("preserves non-path autolink-like string", leanAutolinkRepair.value, { command: "<build.sh>" });
assertFixes("does not record non-path autolink-like string", leanAutolinkRepair.records, []);

const nullableOptionalSchema = {
	type: "object",
	required: [],
	properties: {
		maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
	},
};
const nullableRepair = repairArgsWithSchema(
	{ maybe: null },
	nullableOptionalSchema,
	{ stage: "prepare-arguments", toolName: "nullable_tool" },
);
assertJson("preserves explicit nullable optional null", nullableRepair.value, { maybe: null });
assertFixes("does not record nullable optional null", nullableRepair.records, []);

const nullableObjectSchema = {
	type: "object",
	required: [],
	properties: {
		config: {
			anyOf: [
				{
					type: "object",
					required: [],
					properties: {
						limit: { type: "number" },
						optional: { type: "string" },
					},
				},
				{ type: "null" },
			],
		},
	},
};
const nullableObjectRepair = repairArgsWithSchema(
	{ config: { limit: "7", optional: null } },
	nullableObjectSchema,
	{ stage: "prepare-arguments", toolName: "nullable_object_tool" },
);
assertJson("repairs nested nullable object properties", nullableObjectRepair.value, {
	config: { limit: 7 },
});
assertFixes("records nested nullable object properties", nullableObjectRepair.records, [
	"scalar-coerce $.config.limit (number)",
	"null→omit $.config.optional",
]);


const nullablePathSchema = {
	type: "object",
	required: [],
	properties: {
		path: { anyOf: [{ type: "string" }, { type: "null" }] },
	},
};
const nullablePathRepair = repairArgsWithSchema(
	{ path: "<src/utils.ts>" },
	nullablePathSchema,
	{ stage: "prepare-arguments", toolName: "nullable_path_tool" },
);
assertJson("repairs nullable string path", nullablePathRepair.value, { path: "src/utils.ts" });
assertFixes("records nullable string path", nullablePathRepair.records, ["strip-md-link $.path"]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
