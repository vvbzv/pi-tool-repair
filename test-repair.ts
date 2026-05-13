/**
 * Standalone test for the pi-tool-repair repair logic.
 * Run: npx tsx test-repair.ts
 */
// Copy the repair functions inline for standalone testing
const NULLISH_VALUES = new Set([null]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function closeUnclosedBraces(s: string): string {
  let brace = 0, bracket = 0, inString = false, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"' && !esc) { inString = !inString; continue; }
    if (!inString) {
      if (ch === "{") brace++; if (ch === "}") brace--;
      if (ch === "[") bracket++; if (ch === "]") bracket--;
    }
  }
  const total = brace + bracket;
  if (total <= 0 || total > 3) return s;
  let fixed = s;
  while (bracket > 0) { fixed += "]"; bracket--; }
  while (brace > 0) { fixed += "}"; brace--; }
  return fixed;
}

function repairArgs(obj: unknown, path = "$"): string[] {
  const fixes: string[] = [];
  if (!isObject(obj)) return fixes;
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    const fullPath = `${path}.${key}`;
    // 1. null→omit
    if (NULLISH_VALUES.has(val)) {
      delete (obj as Record<string, unknown>)[key];
      fixes.push(`null→omit ${fullPath}`);
      continue;
    }
    // 2. json-parse
    if (typeof val === "string") {
      const t = val.trim();
      if ((t.startsWith("[") || t.startsWith("{")) && t.length > 2) {
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed) || isObject(parsed)) {
            (obj as Record<string, unknown>)[key] = parsed;
            fixes.push(`json-parse ${fullPath}`);
          }
        } catch { /* skip */ }
      }
    }
    // 3. split-lines
    if (typeof val === "string" && val.includes("\n") && val.trim().length > 0) {
      const lines = val.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length > 1) {
        (obj as Record<string, unknown>)[key] = lines;
        fixes.push(`split-lines ${fullPath} (${lines.length} items)`);
      }
    }
    // 4. strip-md-link
    if (typeof val === "string" && /^<[^>]+\.[a-z]{1,6}>$/i.test(val) && val.length < 200) {
      (obj as Record<string, unknown>)[key] = val.slice(1, -1);
      fixes.push(`strip-md-link ${fullPath}`);
    }
    // 5. close-braces
    if (typeof val === "string") {
      const fixed = closeUnclosedBraces(val);
      if (fixed !== val) {
        (obj as Record<string, unknown>)[key] = fixed;
        fixes.push(`close-braces ${fullPath}`);
      }
    }
    if (isObject(val)) fixes.push(...repairArgs(val, fullPath));
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (isObject(item)) fixes.push(...repairArgs(item, `${fullPath}[${i}]`));
      });
    }
  }
  return fixes;
}

// ── Test cases ──────────────────────────────────

let passed = 0, failed = 0;

function test(name: string, input: unknown, expected: unknown, expectedFixes: string[]) {
  const obj = JSON.parse(JSON.stringify(input)); // deep clone
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

// Test 1: null→omit
test("null on optional field",
  { path: "/x", limit: null },
  { path: "/x" },
  ["null→omit $.limit"]
);

// Test 2: json-parse (array)
test("stringified array",
  { edits: '[{"old":"a","new":"b"}]' },
  { edits: [{ old: "a", new: "b" }] },
  ["json-parse $.edits"]
);

// Test 3: json-parse (object)
test("stringified object",
  { config: '{"port":3000,"debug":true}' },
  { config: { port: 3000, debug: true } },
  ["json-parse $.config"]
);

// Test 4: split-lines
test("multi-line string → array",
  { paths: "src/a.ts\nsrc/b.ts\nsrc/c.ts" },
  { paths: ["src/a.ts", "src/b.ts", "src/c.ts"] },
  ["split-lines $.paths (3 items)"]
);

// Test 5: strip-md-link
test("markdown autolink in path",
  { path: "<src/utils.ts>" },
  { path: "src/utils.ts" },
  ["strip-md-link $.path"]
);

// Test 6: close-braces
test("unclosed braces in truncated JSON",
  { body: '{"name":"test","items":[1,2' },
  { body: '{"name":"test","items":[1,2]}' },
  ["close-braces $.body"]
);

// Test 7: nested repair
test("nested null + json-parse",
  { file: { path: null, content: '["a","b"]' } },
  { file: { content: ["a", "b"] } },
  ["null→omit $.file.path", "json-parse $.file.content"]
);

// Test 8: no-op (clean input)
test("clean input unchanged",
  { path: "/x", limit: 10 },
  { path: "/x", limit: 10 },
  []
);

// Test 9: false positive guard (short string)
test("short string not parsed as JSON",
  { key: "{}" },
  { key: "{}" },
  []
);

// Test 10: ignore non-JSON string with braces
test("non-JSON curly string",
  { text: "{not valid json!!}" },
  { text: "{not valid json!!}" },
  []
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
