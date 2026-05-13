/**
 * pi-tool-repair — Validate-then-repair middleware for Pi agent tool calls.
 *
 * Applies the harness-engineering patterns pioneered by Ahmad Awais / Reasonix:
 *   - Remove null values where optional fields should be omitted
 *   - Parse JSON-stringified arrays/objects back to proper types
 *   - Fix container mismatches (multi-line string → string array)
 *   - Strip accidental Markdown autolinks from file paths
 *   - Close unclosed braces in truncated JSON strings
 *
 * Designed for open models (DeepSeek, Kimi, Qwen, GLM) that often know
 * the right thing but violate strict tool contracts. Closed models see
 * these contracts millions of times in training; open models don't.
 * A forgiving harness closes the gap without a single extra LLM call.
 *
 * All repairs are logged and surfaced as a compact footer status line.
 *
 * Install:  pi install git:github.com/vvbz/pi-tool-repair
 *           or copy this folder into ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RepairStats {
  totalCalls: number;
  repairedCalls: number;
  repairs: Record<string, number>;
  repairTypes: Record<string, number>;
  lastRepair?: string;
}

// ---------------------------------------------------------------------------
// Repair helpers
// ---------------------------------------------------------------------------

const NULLISH_VALUES = new Set([null]);

// Parameter names that must NEVER be structurally altered — these are
// documented as `string` (not `string[]` or JSON) and contain code/text/prose.
// Altering them (json-parse, split-lines) corrupts the tool call.
const STRING_CONTENT_KEYS = new Set([
  "content", "command",
  "oldText", "newText",
  "old_text", "new_text", "new_body",
  "old_string", "new_string",
  "text", "message", "code", "prompt",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Walk a tool args object and apply targeted fixes in place.
 * Returns short descriptions of what was changed.
 */
function repairArgs(obj: unknown, path = "$"): string[] {
  const fixes: string[] = [];
  if (!isObject(obj)) return fixes;

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
    // SAFETY: Skip content-bearing string params — code that happens to be
    // valid JSON (e.g. `["BTC","ETH"]` as a Python list literal) must not be
    // converted to an actual array/object.
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
    // SAFETY: Skip string-only parameters that legitimately contain newlines.
    // write.content = Python/JS scripts, bash.command = shell scripts,
    // edit.old_text/new_text = code blocks -- splitting these to arrays breaks them.
    // Only split when the parameter is documented as accepting string[].
    if (
      typeof val === "string" &&
      val.includes("\n") &&
      val.trim().length > 0 &&
      !STRING_CONTENT_KEYS.has(key)
    ) {
      const lines = val.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1) {
        (obj as Record<string, unknown>)[key] = lines;
        fixes.push(`split-lines ${fullPath} (${lines.length} items)`);
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
    if (typeof val === "string") {
      const fixed = closeUnclosedBraces(val);
      if (fixed !== val) {
        (obj as Record<string, unknown>)[key] = fixed;
        fixes.push(`close-braces ${fullPath}`);
      }
    }

    // Recurse
    if (isObject(val)) fixes.push(...repairArgs(val, fullPath));
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (isObject(item)) fixes.push(...repairArgs(item, `${fullPath}[${i}]`));
      });
    }
  }

  return fixes;
}

/** Append missing closing braces/brackets to truncated JSON strings. */
function closeUnclosedBraces(s: string): string {
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

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function statusLine(stats: RepairStats): string {
  if (stats.repairedCalls === 0) return "repair: 0 fixes";
  const top = Object.entries(stats.repairTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${t}:${n}`)
    .join(" ");
  const last = stats.lastRepair
    ? ` | ${stats.lastRepair.length > 60 ? stats.lastRepair.slice(0, 60) + "…" : stats.lastRepair}`
    : "";
  return `repair: ${stats.repairedCalls}/${stats.totalCalls} (${top})${last}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const stats: RepairStats = {
    totalCalls: 0,
    repairedCalls: 0,
    repairs: {},
    repairTypes: {},
  };

  // Restore stats from previous sessions
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "pi-tool-repair-stats") {
        const data = entry.data as RepairStats | undefined;
        if (data) {
          stats.totalCalls = data.totalCalls || 0;
          stats.repairedCalls = data.repairedCalls || 0;
          stats.repairs = data.repairs || {};
          stats.repairTypes = data.repairTypes || {};
        }
      }
    }
    ctx.ui.setStatus("pi-tool-repair", statusLine(stats));
  });

  pi.on("session_shutdown", async () => {
    pi.appendEntry("pi-tool-repair-stats", { ...stats });
  });

  // ── Core: intercept every tool call and repair args ────────────────
  pi.on("tool_call", (event, ctx) => {
    stats.totalCalls++;

    if (!event.input || typeof event.input !== "object") return;

    const input = event.input as Record<string, unknown>;
    const fixes = repairArgs(input);

    if (fixes.length > 0) {
      stats.repairedCalls++;
      stats.repairs[event.toolName] =
        (stats.repairs[event.toolName] || 0) + fixes.length;

      for (const f of fixes) {
        const type = f.split(" ")[0];
        stats.repairTypes[type] = (stats.repairTypes[type] || 0) + 1;
      }

      stats.lastRepair = `${event.toolName}: ${fixes.join(", ")}`;
      ctx.ui.setStatus("pi-tool-repair", statusLine(stats));
    }
  });
}
