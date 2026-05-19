/**
 * Standalone test for pi-tool-repair — imports the real production repair logic.
 * Run: npm test
 */
import { repairArgs } from "./src/repair";
import { repairToolInput } from "./src/index";
import { formatRepairRecord } from "./src/records";
import { mcpGatewaySchema, multiEditSchema, readSchema } from "./test-fixtures/tool-schemas";

// ── Test cases ──────────────────────────────────

let passed = 0,
	failed = 0;

function test(
	name: string,
	input: unknown,
	expected: unknown,
	expectedFixes: string[],
) {
	const obj = JSON.parse(JSON.stringify(input));
	const fixes = repairArgs(obj);
	assertRepair(name, obj, fixes, expected, expectedFixes);
}

function testToolInput(
	name: string,
	toolName: string,
	input: Record<string, unknown>,
	expected: unknown,
	expectedFixes: string[],
	schema?: unknown,
) {
	const obj = JSON.parse(JSON.stringify(input));
	const fixes = repairToolInput(toolName, obj, schema);
	assertRepair(name, obj, fixes, expected, expectedFixes);
}

function assertRepair(
	name: string,
	actual: unknown,
	actualFixes: unknown[],
	expected: unknown,
	expectedFixes: string[],
) {
	const actualFixText = actualFixes.map(formatRepairRecord);
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	const fixOk = actualFixText.join(",") === expectedFixes.join(",");
	if (ok && fixOk) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}`);
		if (!ok)
			console.log(
				`    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(actual)}`,
			);
		if (!fixOk)
			console.log(
				`    expected fixes: [${expectedFixes}]\n    got fixes:      [${actualFixText}]`,
			);
		failed++;
	}
}

// ── Original 10 tests ──────────────────────────

test("null on optional field", { path: "/x", limit: null }, { path: "/x" }, [
	"null→omit $.limit",
]);

test(
	"stringified array",
	{ edits: '[{"old":"a","new":"b"}]' },
	{ edits: [{ old: "a", new: "b" }] },
	["json-parse $.edits (array)"],
);

test(
	"stringified object",
	{ config: '{"port":3000,"debug":true}' },
	{ config: { port: 3000, debug: true } },
	["json-parse $.config (object)"],
);

test(
	"multi-line string → array",
	{ paths: "src/a.ts\nsrc/b.ts\nsrc/c.ts" },
	{ paths: ["src/a.ts", "src/b.ts", "src/c.ts"] },
	["split-lines $.paths (3 items)"],
);

test(
	"markdown autolink in path",
	{ path: "<src/utils.ts>" },
	{ path: "src/utils.ts" },
	["strip-md-link $.path"],
);

test(
	"markdown linked path",
	{ path: "[notes.md](https://example.test/notes)" },
	{ path: "notes.md" },
	["strip-md-link $.path"],
);

test(
	"single-quoted array string",
	{ paths: "['src/a.ts', 'src/b.ts']" },
	{ paths: ["src/a.ts", "src/b.ts"] },
	["json-parse $.paths (array)"],
);

test(
	"unclosed braces in truncated JSON",
	{ payload: '{"name":"test","items":[1,2' },
	{ payload: '{"name":"test","items":[1,2]}' },
	["close-braces $.payload"],
);

test(
	"nested null + json-parse",
	{ file: { path: null, items: '["a","b"]' } },
	{ file: { items: ["a", "b"] } },
	["null→omit $.file.path", "json-parse $.file.items (array)"],
);

test(
	"clean input unchanged",
	{ path: "/x", limit: 10 },
	{ path: "/x", limit: 10 },
	[],
);

test("short string not parsed as JSON", { key: "{}" }, { key: "{}" }, []);

test(
	"non-JSON curly string",
	{ text: "{not valid json!!}" },
	{ text: "{not valid json!!}" },
	[],
);

// ── v0.1.1 tests: split-lines safety ───────────

test(
	"write content preserved multi-line",
	{ path: "test.py", content: "#!/usr/bin/env python3\n\nprint('hello')" },
	{ path: "test.py", content: "#!/usr/bin/env python3\n\nprint('hello')" },
	[],
);

test(
	"bash command preserved multi-line",
	{ command: "for f in *.txt;\ndo echo $f;\ndone" },
	{ command: "for f in *.txt;\ndo echo $f;\ndone" },
	[],
);

test(
	"edit oldText preserved multi-line",
	{
		path: "x.ts",
		oldText: "function foo() {\n  return 1;\n}",
		newText: "function foo() {\n  return 2;\n}",
	},
	{
		path: "x.ts",
		oldText: "function foo() {\n  return 1;\n}",
		newText: "function foo() {\n  return 2;\n}",
	},
	[],
);

test(
	"paths array still splits",
	{ paths: "src/a.ts\nsrc/b.ts" },
	{ paths: ["src/a.ts", "src/b.ts"] },
	["split-lines $.paths (2 items)"],
);

test(
	"patch old_string preserved",
	{ path: "x.ts", old_string: "line1\nline2", new_string: "new1\nnew2" },
	{ path: "x.ts", old_string: "line1\nline2", new_string: "new1\nnew2" },
	[],
);

test(
	"generic repair preserves non-path autolink-like command",
	{ command: "<build.sh>" },
	{ command: "<build.sh>" },
	[],
);

test(
	"generic repair preserves markdown prose link outside path fields",
	{ message: "[notes.md](https://example.test/notes)" },
	{ message: "[notes.md](https://example.test/notes)" },
	[],
);

// ── v0.1.2 tests: snake_case params ─────────────

test(
	"hashline set_line new_text preserved",
	{
		edits: [
			{ set_line: { anchor: "5:ab", new_text: "def foo():\n    return 1\n" } },
		],
	},
	{
		edits: [
			{ set_line: { anchor: "5:ab", new_text: "def foo():\n    return 1\n" } },
		],
	},
	[],
);

test(
	"hashline replace old_text/new_text preserved",
	{
		edits: [
			{
				replace: {
					old_text: "def old():\n    pass",
					new_text: "def new():\n    return 42",
				},
			},
		],
	},
	{
		edits: [
			{
				replace: {
					old_text: "def old():\n    pass",
					new_text: "def new():\n    return 42",
				},
			},
		],
	},
	[],
);

test(
	"replace_symbol new_body preserved",
	{
		edits: [
			{
				replace_symbol: {
					symbol: "main",
					new_body: "print('hi')\n    return 0",
				},
			},
		],
	},
	{
		edits: [
			{
				replace_symbol: {
					symbol: "main",
					new_body: "print('hi')\n    return 0",
				},
			},
		],
	},
	[],
);

// ── v0.1.3 tests: json-parse safety ─────────────

test(
	"json-parse: code list literal NOT parsed",
	{
		path: "x.py",
		edits: [{ set_line: { anchor: "1:ab", new_text: '["BTC", "ETH"]' } }],
	},
	{
		path: "x.py",
		edits: [{ set_line: { anchor: "1:ab", new_text: '["BTC", "ETH"]' } }],
	},
	[],
);

test(
	"json-parse: code dict literal NOT parsed",
	{
		path: "x.py",
		edits: [{ set_line: { anchor: "1:ab", new_text: '{"key": "value"}' } }],
	},
	{
		path: "x.py",
		edits: [{ set_line: { anchor: "1:ab", new_text: '{"key": "value"}' } }],
	},
	[],
);

test(
	"json-parse: content NOT parsed (trading params)",
	{ path: "strat.py", content: '{"lookback": 14, "symbols": ["BTC", "ETH"]}' },
	{ path: "strat.py", content: '{"lookback": 14, "symbols": ["BTC", "ETH"]}' },
	[],
);

test(
	"json-parse: edits still parses (non-content key)",
	{ edits: '[{"old_text":"a","new_text":"b"}]' },
	{ edits: [{ old_text: "a", new_text: "b" }] },
	["json-parse $.edits (array)"],
);

test(
	"json-parse: paths array stringified parses",
	{ paths: '["src/a.ts","src/b.ts"]' },
	{ paths: ["src/a.ts", "src/b.ts"] },
	["json-parse $.paths (array)"],
);

// ── v0.2.0 tests: null→omit strips only null ──

test(
	"null→omit: strips null only",
	{ optional: null, empty: "", zero: 0, falsy: false },
	{ empty: "", zero: 0, falsy: false },
	["null→omit $.optional"],
);

test(
	"null→omit: preserves empty content strings",
	{ content: "", command: "", newText: "", pattern: "" },
	{ content: "", command: "", newText: "", pattern: "" },
	[],
);

// ── v0.2.0 tests: json parse ordering + recursive repair ──

test(
	"json-parse: pretty object is not split after parsing",
	{ config: '{\n  "a": 1\n}' },
	{ config: { a: 1 } },
	["json-parse $.config (object)"],
);

test(
	"json-parse: pretty array is not split after parsing",
	{ paths: '[\n  "src/a.ts",\n  "src/b.ts"\n]' },
	{ paths: ["src/a.ts", "src/b.ts"] },
	["json-parse $.paths (array)"],
);

test(
	"json-parse: recursively repairs parsed object",
	{ config: '{"limit":null,"name":"ok"}' },
	{ config: { name: "ok" } },
	["json-parse $.config (object)", "null→omit $.config.limit"],
);

// ── v0.2.0 tests: truncated json closure with stack ──

test(
	"close-braces: closes array containing object in nesting order",
	{ value: '[{"a":1' },
	{ value: '[{"a":1}]' },
	["close-braces $.value"],
);

test(
	"close-braces: closes object containing array object in nesting order",
	{ value: '{"a":[{"b":1' },
	{ value: '{"a":[{"b":1}]}' },
	["close-braces $.value"],
);

test(
	"close-braces: ignores non-json-looking strings",
	{ value: "price uses ${VAR" },
	{ value: "price uses ${VAR" },
	[],
);
test(
	"close-braces: ignores unterminated string values",
	{ value: '{"message":"hello' },
	{ value: '{"message":"hello' },
	[],
);

test(
	"split-lines: does not run stale close-braces after splitting",
	{ paths: "[src/a.ts\nsrc/b.ts" },
	{ paths: ["[src/a.ts", "src/b.ts"] },
	["split-lines $.paths (2 items)"],
);

// ── v0.2.0 tests: MCP args repair helper ──

testToolInput(
	"mcp: repairs nested null before args stringify",
	"mcp",
	{ args: { optional: null, keep: "x" } },
	{ args: '{"keep":"x"}' },
	["null→omit $.args.optional", "stringify $.args (object→JSON)"],
);

testToolInput(
	"schema-aware read: numeric string coerces before fallback",
	"read",
	{ path: "x.ts", limit: "10" },
	{ path: "x.ts", limit: 10, offset: 1 },
	["scalar-coerce $.limit (number)", "relation-default $.offset (limit→offset=1)"],
	readSchema,
);

testToolInput(
	"mcp schema-aware string args still stringify after repair",
	"mcp",
	{ server: "lean-ctx", tool: "ctx_search", args: "{\"optional\":null,\"keep\":\"x\"}" },
	{ server: "lean-ctx", tool: "ctx_search", args: "{\"keep\":\"x\"}" },
	["json-parse $.args (object)", "null→omit $.args.optional", "stringify $.args (object→JSON)"],
	mcpGatewaySchema,
);

testToolInput(
	"schema-aware multi-edit patch avoids generic split fallback",
	"edit",
	{ patch: "*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** End Patch" },
	{ patch: "*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** End Patch" },
	[],
	multiEditSchema,
);

testToolInput(
	"mcp schema-aware string args preserve patch payload",
	"mcp",
	{
		server: "multi-edit",
		tool: "edit",
		args: "{\"patch\":\"*** Begin Patch\\n*** Update File: x.ts\\n@@\\n-a\\n+b\\n*** End Patch\"}",
	},
	{
		server: "multi-edit",
		tool: "edit",
		args: "{\"patch\":\"*** Begin Patch\\n*** Update File: x.ts\\n@@\\n-a\\n+b\\n*** End Patch\"}",
	},
	["json-parse $.args (object)", "stringify $.args (object→JSON)"],
	mcpGatewaySchema,
);

testToolInput(
	"mcp generic repair preserves command payload",
	"mcp",
	{ args: { command: "<build.sh>" } },
	{ args: "{\"command\":\"<build.sh>\"}" },
	["stringify $.args (object→JSON)"],
);


// ── End-to-end: full edit call simulation ───────

test(
	"E2E: bulk hashline edit with mixed single/multi",
	{
		path: "strat.py",
		edits: [
			{ set_line: { anchor: "10:ab", new_text: "print('hello')" } },
			{
				set_line: {
					anchor: "15:cd",
					new_text: "def new_func():\n    return 42\n",
				},
			},
			{
				replace: { old_text: "OLD_CONSTANT = 1", new_text: "NEW_CONSTANT = 2" },
			},
			{
				replace_lines: {
					start_anchor: "20:ef",
					end_anchor: "22:gh",
					new_text: "# replaced block\n# with comment\n",
				},
			},
		],
	},
	{
		path: "strat.py",
		edits: [
			{ set_line: { anchor: "10:ab", new_text: "print('hello')" } },
			{
				set_line: {
					anchor: "15:cd",
					new_text: "def new_func():\n    return 42\n",
				},
			},
			{
				replace: { old_text: "OLD_CONSTANT = 1", new_text: "NEW_CONSTANT = 2" },
			},
			{
				replace_lines: {
					start_anchor: "20:ef",
					end_anchor: "22:gh",
					new_text: "# replaced block\n# with comment\n",
				},
			},
		],
	},
	[],
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
