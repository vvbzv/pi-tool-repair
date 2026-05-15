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

const NULLISH_VALUES = new Set([null, undefined, ""]);

// Parameter names that must NEVER be structurally altered — these are
// documented as `string` (not `string[]` or JSON) and contain code/text/prose.
// Altering them (json-parse, split-lines) corrupts the tool call.
const STRING_CONTENT_KEYS = new Set([
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MAX_DEPTH = 12;

/**
 * Walk a tool args object and apply targeted fixes in place.
 * Returns short descriptions of what was changed.
 */
function repairArgs(obj: unknown, path = "$", depth = 0): string[] {
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
    // HEURISTIC: If most lines look like prose (end with .!?;: or >80 chars),
    // treat as a paragraph, not an array.
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
    // SAFETY: Skip content-bearing strings — closing braces in code or prose
    // corrupts the text (e.g. `title: "Price: ${VAR}"` would gain a spurious `}`).
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
    if (!event.input || typeof event.input !== "object") return;

    stats.totalCalls++;
    const input = event.input as Record<string, unknown>;
    const allFixes: string[] = [];

    // Tool-specific: mcp adapter expects args as JSON string, but LLMs
    // often pass a raw object/array. Stringify before generic repair.
    if (event.toolName === "mcp" && (isObject(input.args) || Array.isArray(input.args))) {
      const argsType = Array.isArray(input.args) ? "array" : "object";
      input.args = JSON.stringify(input.args);
      allFixes.push(`stringify $.args (${argsType}→JSON)`);
    }

    // Generic repair pass
    allFixes.push(...repairArgs(input));

    if (allFixes.length > 0) {
      stats.repairedCalls++;
      stats.repairs[event.toolName] =
        (stats.repairs[event.toolName] || 0) + allFixes.length;

      for (const f of allFixes) {
        const type = f.split(" ")[0];
        stats.repairTypes[type] = (stats.repairTypes[type] || 0) + 1;
      }

      stats.lastRepair = `${event.toolName}: ${allFixes.join(", ")}`;
      ctx.ui.setStatus("pi-tool-repair", statusLine(stats));
    }
  });

  // ── Compact LaPis tool results ───────────────────────────────────
  /** Reduce verbose LaPis JSON output to compact symbol/file list. */
  function compactLapisResult(tool: string, parsed: Record<string, unknown>): string | null {
    const meta = parsed._meta as Record<string, unknown> | undefined;
    const data = parsed.data;

    // search-code / memory-code: list symbols compactly
    if (tool === "search-code" || tool === "memory-code") {
      if (!data || typeof data !== "object") return null;
      const d = data as Record<string, unknown>;
      const file = d.file as string || "";
      const classes = d.classes as Array<Record<string, unknown>> | undefined;
      const standalone = d.standalone as Array<Record<string, unknown>> | undefined;
      const symbols = [
        ...(classes || []).map(s => s),
        ...(standalone || []).map(s => s),
      ];

      if (symbols.length === 0) {
        return `${tool}: ${file || "?"} — no symbols`;
      }

      const lines = symbols.map((s) => {
        const name = s.name || s.qualified_name || "?";
        const kind = s.kind || "";
        const sig = (s.signature as string) || "";
        const shortSig = sig.length > 60 ? sig.slice(0, 57) + "..." : sig;
        const ca = s.cyclomatic as number | undefined;
        const assess = s.assessment as string | undefined;
        const flags: string[] = [];
        if (ca !== undefined && ca > 5) flags.push(`CC${ca}`);
        if (assess && assess !== "low") flags.push(assess);
        const flagStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
        return `  ${kind || "?"} ${name} @L${s.start_line}-${s.end_line}${flagStr}${shortSig ? " | " + shortSig : ""}`;
      });

      const count = meta?.result_count ?? symbols.length;
      return `${tool}: ${file} — ${count} symbols\n${lines.join("\n")}`;
    }

    // list-code-repos: just names
    if (tool === "list-code-repos") {
      const repos = data as Array<Record<string, unknown>> | undefined;
      if (!repos) return null;
      const names = repos.map(r => r.name || r.path || "?").join(", ");
      return `${tool}: ${repos.length} repos — ${names}`;
    }

    // import-graph: node/edge counts
    if (tool === "import-graph") {
      if (!data || typeof data !== "object") return null;
      const d = data as Record<string, unknown>;
      const nodes = Array.isArray(d.nodes) ? d.nodes.length : "?";
      const edges = Array.isArray(d.edges) ? d.edges.length : "?";
      return `${tool}: ${nodes} nodes, ${edges} edges`;
    }

    // generic: if data has count/length, summarize
    if (Array.isArray(data) && data.length > 5) {
      const items = data.slice(0, 5).map((item: unknown) => {
        if (typeof item === "object" && item !== null) {
          const i = item as Record<string, unknown>;
          return i.name || i.symbol || i.file || i.path || JSON.stringify(i).slice(0, 40);
        }
        return String(item).slice(0, 40);
      }).join(", ");
      return `${tool}: ${data.length} items (first 5: ${items}...)`;
    }

    return null; // no change
  }

  const LAPIS_TOOLS = new Set([
    "search-code", "memory-code", "list-code-repos",
    "import-graph", "call-hierarchy", "get-code-source",
    "dead-code", "hotspots", "complexity", "cycles",
    "importance", "coupling", "extractable",
    "blast-radius", "doc-search", "doc-coverage",
    "glossary", "backlinks", "stale-pages", "broken-links",
    "index-repo", "index-docs",
  ]);

  pi.on("tool_result", (event, ctx) => {
    if (!LAPIS_TOOLS.has(event.toolName)) return;
    if (!event.output || typeof event.output !== "string") return;

    try {
      const parsed = JSON.parse(event.output);
      if (!parsed.data && !parsed._meta) return; // not LaPis format

      const compact = compactLapisResult(event.toolName, parsed);
      if (compact !== null) {
        event.output = compact;
      }
    } catch {
      // not JSON — leave output as-is
    }
  });
}
