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
import { isObject, repairArgs } from "./repair";

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
