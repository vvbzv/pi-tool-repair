/**
 * Standalone test for pi-tool-repair — imports the real production repair logic.
 * Run: npm test
 */
import { repairArgs } from "./src/repair";

// ── Test cases ──────────────────────────────────

let passed = 0, failed = 0;

function test(name: string, input: unknown, expected: unknown, expectedFixes: string[]) {
  const obj = JSON.parse(JSON.stringify(input));
  const fixes = repairArgs(obj);
  const ok = JSON.stringify(obj) === JSON.stringify(expected);
  const fixOk = fixes.join(",") === expectedFixes.join(",");
  if (ok && fixOk) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    if (!ok) console.log(`    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(obj)}`);
    if (!fixOk) console.log(`    expected fixes: [${expectedFixes}]\n    got fixes:      [${fixes}]`);
    failed++;
  }
}

// ── Original 10 tests ──────────────────────────

test("null on optional field",
  { path: "/x", limit: null },
  { path: "/x" },
  ["null→omit $.limit"]
);

test("stringified array",
  { edits: '[{"old":"a","new":"b"}]' },
  { edits: [{ old: "a", new: "b" }] },
  ["json-parse $.edits"]
);

test("stringified object",
  { config: '{"port":3000,"debug":true}' },
  { config: { port: 3000, debug: true } },
  ["json-parse $.config"]
);

test("multi-line string → array",
  { paths: "src/a.ts\nsrc/b.ts\nsrc/c.ts" },
  { paths: ["src/a.ts", "src/b.ts", "src/c.ts"] },
  ["split-lines $.paths (3 items)"]
);

test("markdown autolink in path",
  { path: "<src/utils.ts>" },
  { path: "src/utils.ts" },
  ["strip-md-link $.path"]
);

test("unclosed braces in truncated JSON",
  { body: '{"name":"test","items":[1,2' },
  { body: '{"name":"test","items":[1,2]}' },
  ["close-braces $.body"]
);

test("nested null + json-parse",
  { file: { path: null, items: '["a","b"]' } },
  { file: { items: ["a", "b"] } },
  ["null→omit $.file.path", "json-parse $.file.items"]
);

test("clean input unchanged",
  { path: "/x", limit: 10 },
  { path: "/x", limit: 10 },
  []
);

test("short string not parsed as JSON",
  { key: "{}" },
  { key: "{}" },
  []
);

test("non-JSON curly string",
  { text: "{not valid json!!}" },
  { text: "{not valid json!!}" },
  []
);

// ── v0.1.1 tests: split-lines safety ───────────

test("write content preserved multi-line",
  { path: "test.py", content: "#!/usr/bin/env python3\n\nprint('hello')" },
  { path: "test.py", content: "#!/usr/bin/env python3\n\nprint('hello')" },
  []
);

test("bash command preserved multi-line",
  { command: "for f in *.txt;\ndo echo $f;\ndone" },
  { command: "for f in *.txt;\ndo echo $f;\ndone" },
  []
);

test("edit oldText preserved multi-line",
  { path: "x.ts", oldText: "function foo() {\n  return 1;\n}", newText: "function foo() {\n  return 2;\n}" },
  { path: "x.ts", oldText: "function foo() {\n  return 1;\n}", newText: "function foo() {\n  return 2;\n}" },
  []
);

test("paths array still splits",
  { paths: "src/a.ts\nsrc/b.ts" },
  { paths: ["src/a.ts", "src/b.ts"] },
  ["split-lines $.paths (2 items)"]
);

test("patch old_string preserved",
  { path: "x.ts", old_string: "line1\nline2", new_string: "new1\nnew2" },
  { path: "x.ts", old_string: "line1\nline2", new_string: "new1\nnew2" },
  []
);

// ── v0.1.2 tests: snake_case params ─────────────

test("hashline set_line new_text preserved",
  { edits: [{ set_line: { anchor: "5:ab", new_text: "def foo():\n    return 1\n" } }] },
  { edits: [{ set_line: { anchor: "5:ab", new_text: "def foo():\n    return 1\n" } }] },
  []
);

test("hashline replace old_text/new_text preserved",
  { edits: [{ replace: { old_text: "def old():\n    pass", new_text: "def new():\n    return 42" } }] },
  { edits: [{ replace: { old_text: "def old():\n    pass", new_text: "def new():\n    return 42" } }] },
  []
);

test("replace_symbol new_body preserved",
  { edits: [{ replace_symbol: { symbol: "main", new_body: "print('hi')\n    return 0" } }] },
  { edits: [{ replace_symbol: { symbol: "main", new_body: "print('hi')\n    return 0" } }] },
  []
);

// ── v0.1.3 tests: json-parse safety ─────────────

test("json-parse: code list literal NOT parsed",
  { path: "x.py", edits: [{ set_line: { anchor: "1:ab", new_text: '["BTC", "ETH"]' } }] },
  { path: "x.py", edits: [{ set_line: { anchor: "1:ab", new_text: '["BTC", "ETH"]' } }] },
  []
);

test("json-parse: code dict literal NOT parsed",
  { path: "x.py", edits: [{ set_line: { anchor: "1:ab", new_text: '{"key": "value"}' } }] },
  { path: "x.py", edits: [{ set_line: { anchor: "1:ab", new_text: '{"key": "value"}' } }] },
  []
);

test("json-parse: content NOT parsed (trading params)",
  { path: "strat.py", content: '{"lookback": 14, "symbols": ["BTC", "ETH"]}' },
  { path: "strat.py", content: '{"lookback": 14, "symbols": ["BTC", "ETH"]}' },
  []
);

test("json-parse: edits still parses (non-content key)",
  { edits: '[{"old_text":"a","new_text":"b"}]' },
  { edits: [{ old_text: "a", new_text: "b" }] },
  ["json-parse $.edits"]
);

test("json-parse: paths array stringified parses",
  { paths: '["src/a.ts","src/b.ts"]' },
  { paths: ["src/a.ts", "src/b.ts"] },
  ["json-parse $.paths"]
);

// ── End-to-end: full edit call simulation ───────

test("E2E: bulk hashline edit with mixed single/multi",
  {
    path: "strat.py",
    edits: [
      { set_line: { anchor: "10:ab", new_text: "print('hello')" } },
      { set_line: { anchor: "15:cd", new_text: "def new_func():\n    return 42\n" } },
      { replace: { old_text: "OLD_CONSTANT = 1", new_text: "NEW_CONSTANT = 2" } },
      { replace_lines: { start_anchor: "20:ef", end_anchor: "22:gh", new_text: "# replaced block\n# with comment\n" } },
    ]
  },
  {
    path: "strat.py",
    edits: [
      { set_line: { anchor: "10:ab", new_text: "print('hello')" } },
      { set_line: { anchor: "15:cd", new_text: "def new_func():\n    return 42\n" } },
      { replace: { old_text: "OLD_CONSTANT = 1", new_text: "NEW_CONSTANT = 2" } },
      { replace_lines: { start_anchor: "20:ef", end_anchor: "22:gh", new_text: "# replaced block\n# with comment\n" } },
    ]
  },
  []
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
