/**
 * pi-tool-repair — pure repair logic, extracted from Pi extension glue.
 *
 * These helpers are the implementation tested by test-repair.ts and
 * consumed by the Pi extension in src/index.ts.
 */

import type { RepairRecord } from "./records";

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
  "instructions", "template", "example", "examples", "patch",  // generic prose / patch payloads
  "expression", "statement",  // code/math expressions
  "use_case", "known_fields",  // Composio search prose params
  "output", "source", "target",  // generic text fields
]);

function isPathLikeFieldKey(key: string): boolean {
  return key === "path" || key === "file" || key === "filepath" || key === "file_path";
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const MAX_DEPTH = 12;

/**
 * Walk a tool args object and apply targeted fixes in place.
 * Returns short descriptions of what was changed.
 */
export function repairArgs(obj: unknown, path = "$", depth = 0): RepairRecord[] {
  const fixes: RepairRecord[] = [];
  if (!isObject(obj) || depth > MAX_DEPTH) return fixes;

  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    const fullPath = `${path}.${key}`;

    // 1. Strip null values → delete the key (null ≠ omit for optional fields)
    if (val === null) {
      delete (obj as Record<string, unknown>)[key];
      fixes.push({ type: "null-omit", path: fullPath, stage: "tool-call" });
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
            fixes.push({ type: "json-parse", path: fullPath, stage: "tool-call", detail: Array.isArray(parsed) ? "array" : "object" });

            // Recursively repair the parsed value in the same pass
            if (isObject(parsed)) {
              fixes.push(...repairArgs(parsed, fullPath, depth + 1));
            } else {
              parsed.forEach((item, i) => {
                if (isObject(item))
                  fixes.push(...repairArgs(item, `${fullPath}[${i}]`, depth + 1));
              });
            }

            // Skip remaining passes — they'd operate on the stale original string
            continue;
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
          fixes.push({ type: "split-lines", path: fullPath, stage: "tool-call", detail: `${lines.length} items` });
          continue;
        }
      }
    }

    // 4. Strip accidental Markdown autolinks from file-like paths
    if (
      typeof val === "string" &&
      isPathLikeFieldKey(key) &&
      /^<[^>]+\.[a-z]{1,6}>$/i.test(val) &&
      val.length < 200
    ) {
      (obj as Record<string, unknown>)[key] = val.slice(1, -1);
      fixes.push({ type: "strip-md-link", path: fullPath, stage: "tool-call" });
    }

    // 5. Close unclosed braces in truncated JSON strings
    if (typeof val === "string" && !STRING_CONTENT_KEYS.has(key)) {
      const fixed = closeUnclosedBraces(val);
      if (fixed !== val) {
        (obj as Record<string, unknown>)[key] = fixed;
        fixes.push({ type: "close-braces", path: fullPath, stage: "tool-call" });
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
  const trimmed = s.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return s;

  const stack: string[] = [];
  let inString = false;
  let esc = false;

  for (const ch of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return s;
      stack.pop();
    }
  }

  if (inString || stack.length === 0 || stack.length > 3) return s;
  return s + stack.reverse().join("");
}
