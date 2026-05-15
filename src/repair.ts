/**
 * pi-tool-repair — pure repair logic, extracted from Pi extension glue.
 *
 * These helpers are the implementation tested by test-repair.ts and
 * consumed by the Pi extension in src/index.ts.
 */

export const NULLISH_VALUES = new Set([null, undefined, ""]);

export const STRING_CONTENT_KEYS = new Set([
  "content", "command",
  "oldText", "newText",
  "old_text", "new_text", "new_body",
  "old_string", "new_string",
  "text", "message", "code", "prompt",
  "args",     // mcp adapter expects JSON string, never parse to object
  "pattern",  // regex patterns like [a-z]+ must stay strings
  "query",    // search queries
  "goal", "context",  // task/subagent descriptions
  "body", "description", "summary", "note", "notes",  // prose fields
  "path", "name", "title", "subject", "label", "labels",  // text identifiers
  "data",     // process tool stdin (multi-line scripts)
  "script",   // cronjob script content
  "instructions", "template", "example", "examples",  // generic prose
  "expression", "statement",  // code/math expressions
  "use_case", "known_fields",  // Composio search prose params
  "output", "source", "target",  // generic text fields
]);

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const MAX_DEPTH = 12;

/**
 * Walk a tool args object and apply targeted fixes in place.
 * Returns short descriptions of what was changed.
 */
export function repairArgs(obj: unknown, path = "$", depth = 0): string[] {
  const fixes: string[] = [];
  if (!isObject(obj) || depth > MAX_DEPTH) return fixes;

  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    const fullPath = `${path}.${key}`;

    // 1. Strip null values → delete the key (null ≠ omit for optional fields)
    if (NULLISH_VALUES.has(val)) {
      delete (obj as Record<string, unknown>)[key];
      fixes.push(`null→omit ${fullPath}`);
      continue;
    }

    // 2. String that looks like JSON → parse it
    if (
      typeof val === "string" &&
      !STRING_CONTENT_KEYS.has(key)
    ) {
      const t = val.trim();
      if ((t.startsWith("[") || t.startsWith("{")) && t.length > 2) {
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed) || isObject(parsed)) {
            (obj as Record<string, unknown>)[key] = parsed;
            fixes.push(`json-parse ${fullPath} (${Array.isArray(parsed) ? "array" : "object"})`);
          }
        } catch { /* not valid JSON, leave alone */ }
      }
    }

    // 3. Multi-line string where array likely expected
    if (
      typeof val === "string" &&
      val.includes("\n") &&
      val.trim().length > 0 &&
      !STRING_CONTENT_KEYS.has(key)
    ) {
      const lines = val.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1) {
        const proseCount = lines.filter(
          l => l.length > 80 || /[.!?;:]$/.test(l)
        ).length;
        if (proseCount / lines.length <= 0.4) {
          (obj as Record<string, unknown>)[key] = lines;
          fixes.push(`split-lines ${fullPath} (${lines.length} items)`);
        }
      }
    }

    // 4. Strip accidental Markdown autolinks from file-like paths
    if (
      typeof val === "string" &&
      /^<[^>]+\.[a-z]{1,6}>$/i.test(val) &&
      val.length < 200
    ) {
      (obj as Record<string, unknown>)[key] = val.slice(1, -1);
      fixes.push(`strip-md-link ${fullPath}`);
    }

    // 5. Close unclosed braces in truncated JSON strings
    if (typeof val === "string" && !STRING_CONTENT_KEYS.has(key)) {
      const fixed = closeUnclosedBraces(val);
      if (fixed !== val) {
        (obj as Record<string, unknown>)[key] = fixed;
        fixes.push(`close-braces ${fullPath}`);
      }
    }

    // Recurse
    if (isObject(val)) fixes.push(...repairArgs(val, fullPath, depth + 1));
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (isObject(item)) fixes.push(...repairArgs(item, `${fullPath}[${i}]`, depth + 1));
      });
    }
  }

  return fixes;
}

/** Append missing closing braces/brackets to truncated JSON strings. */
export function closeUnclosedBraces(s: string): string {
  let brace = 0;
  let bracket = 0;
  let inString = false;
  let esc = false;

  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"' && !esc) { inString = !inString; continue; }
    if (!inString) {
      if (ch === "{") brace++;
      if (ch === "}") brace--;
      if (ch === "[") bracket++;
      if (ch === "]") bracket--;
    }
  }

  // Only repair if the imbalance is plausibly a truncation (1-3 missing closers)
  const total = brace + bracket;
  if (total <= 0 || total > 3) return s;

  let fixed = s;
  while (bracket > 0) { fixed += "]"; bracket--; }
  while (brace > 0) { fixed += "}"; brace--; }
  return fixed;
}
