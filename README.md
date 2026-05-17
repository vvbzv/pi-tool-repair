# pi-tool-repair 🔧

> **Validate/repair middleware for Pi agent tool calls.**
> Repairs parsed tool input objects at Pi's `tool_call` hook and exposes
> reusable pre-validation helpers for tool authors.

---

## Why this exists

### The open-model tool-calling gap

Closed models (Claude, GPT-5) have seen strict tool schemas millions of
times during RLHF and fine-tuning. They almost never violate contracts.

Open models (DeepSeek V4, Kimi K2.6, Qwen, GLM, Mistral) are equally
capable at _reasoning_ about what tool to call and what arguments to pass
— but they lack the same volume of schema-constrained training. The
result is predictable, repeatable failure modes:

| Failure mode            | Example                                                     | Why it happens                                 |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Null on optional fields | `{path: "/x", limit: null}`                                 | Model emits null instead of omitting the key   |
| Stringified JSON        | `{edits: "[{\"a\":1}]"}`                                    | Model double-encodes structured data           |
| Container mismatch      | `"src/a.ts\nsrc/b.ts"` instead of `["src/a.ts","src/b.ts"]` | Model emits a flat string for a list parameter |
| Markdown autolinks      | `"<src/utils.ts>"`                                          | Model applies prose formatting to code paths   |
| Truncated JSON          | `{"path":"/x","edi`                                         | Streaming cutoff leaves unclosed braces        |

These are **harness problems, not model problems.** The model knows the
right answer — it just violates the strict contract that the tool schema
demands. A forgiving harness closes this gap.

### The evidence

Anecdotal internal evals reported by Ahmad Awais / Reasonix (2026)
suggest that targeted tool-input repair can materially improve open-model
coding-agent reliability. This project applies the same general idea to
Pi, but does not claim benchmark parity with Reasonix.

---

## How it works

### The validate-then-repair pattern
> **Important:** Pi's `tool_call` extension event runs after Pi validates tool
> arguments. The installed extension can repair already-validated objects and
> keep later extensions consistent, but validation-blocking failures require a
> tool-level `prepareArguments` wrapper or a Pi/provider pre-validation hook.


```
Model emits tool call
  │
  ├─► pi-tool-repair intercepts (tool_call event)
  │
  ├─► Walk every argument value:
  │     ├─ null?   → delete key (omit, don't send null)
  │     ├─ "[..."? → JSON.parse into real array
  │     ├─ "{..."? → JSON.parse into real object
  │     ├─ "a\nb"? → split into string array
  │     ├─ <path>? → strip angle brackets
  │     └─ open {? → close unclosed braces
  │
  ├─► Mutate event.input in-place
  │     (later extensions see repaired args)
  │
  └─► Tool executes with clean arguments
```

**Key design properties:**

- **Post-validation hook** — Pi does not re-validate after our mutation (per Pi's `tool_call` contract)
- **In-place mutation** — `event.input` is mutable. We modify it, don't replace it
- **Chained extensions** — other `tool_call` handlers see our repairs
- **Never blocks** — we never return `{block: true}`. If args are unfixable, the tool fails naturally with its own error
- **Zero overhead** — no async work, no network calls, no LLM calls. Pure data transformation

### Integration point

Pi's `tool_call` event fires after `tool_execution_start` and Pi argument
validation, but before the tool actually executes. The `event.input` object is
directly mutable with guaranteed behavior:

> Mutations to `event.input` affect the actual tool execution. Later
> `tool_call` handlers see mutations made by earlier handlers. No
> re-validation is performed after your mutation.

This is the right insertion point for post-validation cleanup and chained
extension compatibility. Tool authors that need validation-blocking repairs can
wrap their own `ToolDefinition` with this package's pre-validation helpers.

---

## Installation

```bash
pi install git:github.com/yanapattin-source/pi-tool-repair
```

Or manually:

```bash
git clone https://github.com/yanapattin-source/pi-tool-repair \
  ~/.pi/agent/extensions/pi-tool-repair
```

Then `/reload` in Pi or restart. The extension auto-wires — no
configuration needed.

### Remove

```bash
pi remove git:github.com/yanapattin-source/pi-tool-repair
```

If your Pi build still uses the older verb, this is equivalent:

```bash
pi uninstall git:github.com/yanapattin-source/pi-tool-repair
```

---

## The five repair passes

### 1. `null→omit` — Null value stripping

**Problem:** Models emit `null` for optional fields instead of omitting
the key entirely. Many tool schemas treat `null` as a type error (the
field is `Optional<String>` meaning "String or absent", not "String or
null").

**Fix:** Delete any top-level or nested key whose value is `null`.

```typescript
// Before (model output)
{ path: "/src/file.ts", offset: null, limit: null }

// After (repaired)
{ path: "/src/file.ts" }
```

**Safety:** Only strips `null`. Does not strip `undefined`, `0`, `false`,
or empty strings — those are valid values.

### 2. `json-parse` — Stringified JSON unwrapping

**Problem:** Models sometimes emit structured data (arrays, objects) as
JSON-encoded strings. The tool schema expects an actual array/object,
not a string that happens to contain JSON.

**Fix:** Detect strings starting with `[` or `{`, attempt `JSON.parse`.
If successful and the result is an array or object, replace the string
with the parsed value.

```typescript
// Before (model output)
{
  edits: '[{"oldText":"foo","newText":"bar"}]',
}

// After (repaired)
{
  edits: [{ oldText: "foo", newText: "bar" }]
}
```

**Safety:** Only applies when the string is ≥3 characters and starts
with bracket/brace. Invalid JSON is left alone. Short strings like
`"{}"` (2 chars) are never parsed — too risky for false positives.

**Content safety (v0.1.3):** The `STRING_CONTENT_KEYS` set (shared with
split-lines) prevents json-parse from converting code/text params that
happen to be valid JSON. A Python list literal like `["BTC","ETH"]` in
`new_text` is preserved as a string, not parsed into an array.

```typescript
// DANGER (pre-v0.1.3): code that's valid JSON gets corrupted
{
  edits: [{ replace: { old_text: "x", new_text: '["BTC","ETH"]' } }]
}
// → new_text became ["BTC", "ETH"] (array!) — edit tool broke

// SAFE (v0.1.3): content params are never parsed
{
  edits: [{ replace: { old_text: "x", new_text: '["BTC","ETH"]' } }]
}
// → new_text stays '["BTC","ETH"]' (string) — edit tool works
```

### 3. `split-lines` — Multi-line string to array (with safety skips)

**Problem:** When a tool parameter expects `string[]`, models sometimes
emit a single newline-delimited string instead. Common cases are
non-protected plural/list-like parameters such as `paths` or other
multi-item arguments.

**Fix:** Detect strings containing newlines with non-whitespace content
on at least two lines. Split by newline, trim each line, and replace
with a string array.

**Safety skips (v0.1.3):** Both `json-parse` and `split-lines` share
`STRING_CONTENT_KEYS` from `src/repair.ts`. Known content-bearing,
query-like, or identifier fields — including `content`, `command`,
`oldText`, `newText`, `old_text`, `new_text`, `new_body`,
`old_string`, `new_string`, `text`, `message`, `code`, `prompt`,
`args`, `pattern`, `query`, `body`, `description`, `path`, `name`,
`title`, `data`, and `script` — are **never split or parsed**. These
fields are documented or commonly used as strings where newlines,
regex-like brackets, JSON-looking examples, or prose are intentional.

```typescript
// Before (model output)
{
  paths: "src/auth.ts\nsrc/db.ts\nsrc/api.ts"
}

// After (repaired)
{
  paths: ["src/auth.ts", "src/db.ts", "src/api.ts"]
}
```

**Safety:** Only fires when ≥2 non-empty lines exist. Single-line
strings with trailing newlines are unaffected. Empty strings are skipped.

### 4. `strip-md-link` — Markdown autolink removal

**Problem:** Models trained on large corpora of Markdown sometimes treat
file paths as Markdown autolinks, wrapping them in angle brackets.
`<src/utils.ts>` is valid Markdown but not a valid file path.

**Fix:** Detect strings matching the pattern `<text.extension>` (angle
brackets around what looks like a filename with extension). Strip the
brackets.

```typescript
// Before (model output)
{
  path: "<src/components/Button.tsx>"
}

// After (repaired)
{
  path: "src/components/Button.tsx"
}
```

**Safety:** Only matches strings under 200 characters with a file-like
extension (1-6 letter extension after a dot). Won't match generic angle
bracket usage like `<T>` or XML tags.

### 5. `close-braces` — Truncated JSON repair

**Problem:** During streaming, model output can be truncated mid-JSON.
The last chunk arrives with unclosed braces or brackets. Most tool
frameworks reject this as invalid JSON.

**Fix:** Track braces and brackets with a delimiter stack. If the
remaining unclosed delimiter count is 1-3 (plausibly a truncation, not
completely garbled), append the missing closing characters in nesting
order.

```typescript
// Before (model output — truncated by streaming)
{
  payload: '{"name":"test","items":[1,2'
}

// After (repaired)
{
  payload: '{"name":"test","items":[1,2]}'
}
```

**Safety:** Only repairs imbalance ≤3 characters. Heavier imbalance
(e.g., 10+ unclosed braces) is left alone — it's probably not JSON at
all. String content inside quotes is correctly tracked and not counted;
if the input ends inside an unterminated string, the extension leaves it
unchanged instead of appending structural closers.

---

## Live statistics

The Pi footer shows real-time repair stats:

```
repair: 12/47 (null→omit:8 json-parse:3 strip-md-link:1) | bash: null→omit $.command
```

**Reading the status:**

- `12/47` — 12 tool calls repaired out of 47 total (25.5% repair rate)
- `(null→omit:8 json-parse:3 ...)` — breakdown by repair type
- After `|` — most recent repair: which tool, which fix, which path

Stats persist across sessions via `pi.appendEntry`. High repair rates
on specific tools indicate the model struggles with that tool's schema
— useful for debugging or model selection.

**Hidden stats:** The extension also tracks per-tool repair counts and
per-repair-type counts internally. These are accessible via the stats
entry in the session (custom type `pi-tool-repair-stats`).

---

## Compatibility

### With other Pi extensions

| Extension                 | Status                  | Notes                                                                                                                                                                                              |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-permission-system`    | ✅ Compatible           | Repair runs in the `tool_call` phase; if ordered before permission checks, repaired args pass permission gates cleanly                                                                             |
| `pi-guardrails`           | ✅ Compatible           | Guardrails operates on file paths, repair operates on tool args — no overlap                                                                                                                       |
| `pi-rtk-optimizer`        | ✅ Compatible           | Repair fixes input args, RTK optimizes bash commands and output — different lifecycle stages                                                                                                       |
| `pi-observational-memory` | ✅ Compatible           | No shared hooks — repair is tool_call, memory is compaction                                                                                                                                        |
| `pi-fork`                 | ✅ Compatible           | Forks inherit the extension normally                                                                                                                                                               |
| `pi-minimal-subagent`     | ✅ Compatible           | Subagents get their own extension instance with fresh stats                                                                                                                                        |
| `LaPis` / `memory-code`   | ✅ Compatible           | This extension only repairs tool-call inputs and does not compact or mutate LaPis tool results                                                                                                     |
| `pi-hashline-readmap`     | ✅ Compatible (v0.1.3+) | Different lifecycle layers: repair runs on `tool_call` hook (arg fixes), readmap registers tools only. STRING_CONTENT_KEYS covers readmap's snake_case params (`new_text`, `old_text`, `new_body`) |
| `pi-snap-edit`            | ✅ Compatible           | Same architecture — repair fixes args, snap-edit executes tools                                                                                                                                    |

### With different models

The extension is model-agnostic. It works identically whether you're
using DeepSeek, Kimi, Claude, GPT, Gemini, or local models. The repair
passes are based on the _structure_ of the tool call arguments, not
which model produced them.

Closed models (Claude, GPT-5) will rarely trigger repairs — they've
been trained extensively on strict schemas. Open models will trigger
repairs more often. Both benefit from the safety net.

### With tool sources

| Tool source | Supported now | Pre-validation support | Notes |
| :---------- | :------------ | :--------------------- | :---- |
| Pi built-ins | Yes, after validation | Only if Pi core adds a pre-validation hook | Current hook still records and repairs values that survive validation. |
| `pi-mono-multi-edit` | Yes | Yes, if it wraps tools with `withToolRepair()` | `patch`, `oldText`, and `newText` stay strings. |
| `pi-lean-ctx` | Yes | Yes, if it wraps tools with `withToolRepair()` | Commands, queries, and compressed output stay strings. |
| MCP adapter tools | Yes | Adapter-specific | Object/array `args` are repaired before stringification when visible. |
| Custom Pi tools | Yes | Yes | Tool authors can use `withToolRepair(tool)`. |

The installed extension sees every tool call that reaches Pi's `tool_call`
event — built-ins (`read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`),
extension-registered tools, and MCP-proxied tools. Calls rejected earlier by
Pi validation need pre-validation integration through `prepareArguments`, a
tool wrapper, or future Pi/provider support.

## Doctor command

Run this inside Pi:

```text
/repair-doctor
```

It inspects the currently active tools, highlights object/array/numeric/boolean
argument shapes that are more likely to need repair, reports whether an MCP
gateway is active, and reminds you that Pi does not expose third-party
`prepareArguments` implementations for direct inspection.


## For extension authors

Use `withToolRepair()` when registering a custom tool that should be repaired
before Pi validates arguments.

```typescript
import { withToolRepair } from "@yanapattin-source/pi-tool-repair/src/api";

pi.registerTool(withToolRepair({
  name: "my_tool",
  label: "my_tool",
  description: "Example repaired tool",
  parameters: myTypeBoxSchema,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: JSON.stringify(params) }],
      details: {},
    }
  },
}));
```

The wrapper preserves an existing `prepareArguments` function and then applies
schema-aware repair. Fields declared as strings stay strings, so patch payloads,
commands, prompts, and source code are not parsed or split.

### `pi-mono-multi-edit`

Recommended shape:

- Wrap the registered edit tool with `withToolRepair()`.
- Keep `patch`, `oldText`, and `newText` as schema strings.
- Keep `multi` as an array schema.

This allows stringified `multi` arrays to repair before validation while
Codex-style patch payloads remain untouched.

### `pi-lean-ctx`

Recommended shape:

- Wrap `ctx_*` tools with `withToolRepair()` if they accept structured inputs.
- Keep `command`, `query`, `path`, and prose fields as schema strings.
- Use array schemas only for fields that should truly accept arrays.

This lets the repair layer fix model-emitted containers without corrupting shell
commands or compressed Lean Context output.

---

## Configuration

No configuration required. The extension works out of the box with
sensible defaults.

If you want to disable specific repair passes, edit the repair logic in
`src/repair.ts` — comment out the pass you want to skip in
the `repairArgs` function.

Future versions may add a config file at
`~/.pi/agent/extensions/pi-tool-repair/config.json` for per-pass toggles.

---

## Testing

### Unit tests (standalone, no Pi required)

```bash
cd pi-tool-repair
npm test
```

Runs the repair regression suite covering all repair passes, nested
repairs, and false-positive guards.

### Integration test (in Pi)

1. Start Pi with DeepSeek or another open model
2. Ask: "read the file package.json and list all dependencies"
3. Watch the Pi footer for `repair:` counter ticking up
4. If the model emits null on optional fields or stringified arrays,
   you'll see live repairs

### Stress test

Ask the agent to perform 20+ tool calls in a single session with
complex nested arguments. Check the repair rate — typical open models
show 15-30% of tool calls needing at least one fix.

---

## Design philosophy

1. **Zero-config.** Works immediately after install. No setup, no config
   files, no CLI flags.
2. **Zero-cost.** No LLM calls, no network requests, no async work.
   Pure data transformation in the hot path.
3. **Never blocks.** If we can't fix it, the tool executes with original
   args and fails naturally. We don't add new failure modes.
4. **Transparent.** All repairs are logged to the status bar. You always
   know what was changed and why.
5. **Minimal scope.** We fix _argument structure_, not argument _correctness_.
   We don't guess what the model meant — we only fix clear contract
   violations.

---

## Limitations

- **Does not fix semantic errors.** If the model calls `read` on the
  wrong file path, repair won't correct it. We only fix structural
  contract violations (null/missing fields, type mismatches).
- **Heuristic repair, not schema-guided validation.** The extension
  avoids known content-bearing string fields, but unknown tools with
  unusual schemas may still need a future per-tool allowlist or
  schema-aware repair path.
- **Generic fallback is still heuristic.** The `tool_call` hook uses safe
  content-key guards, but unknown open-shaped fields may still need
  tool-specific protection. Pre-validation helpers (`withToolRepair()` and
  `repairArgsWithSchema()`) are the schema-aware path.
- **Split-lines is heuristic.** Converting `"a\nb"` to `["a","b"]` is
  a guess based on common failure patterns. If the tool genuinely
  expects a multi-line string and its field name is not protected, this
  fix could be wrong.
- **Does not handle tool selection errors.** If the model calls `bash`
  when it should call `grep`, repair can't help. That's a model
  reasoning problem, not a contract problem.
- **Stats reset on fresh install.** Session-persisted stats are tied
  to the Pi session. A new session starts with fresh counters.

---

## Contributing

The source repo is at `github.com/yanapattin-source/pi-tool-repair`.

To add a new repair pass:

1. Add the detection + fix logic to the `repairArgs` function in
   `src/repair.ts`
2. Add test cases to `test-repair.ts`
3. Run the tests: `npx tsx test-repair.ts`
4. Submit a PR

Good candidates for new passes:

- Pi/provider pre-validation integration for built-in tools
- Additional MCP-aware protections for unknown open-shaped `args`
- Nested null cleanup inside arrays of objects

---

## Credits

Inspired by the harness-engineering research from Ahmad Awais and the
Reasonix framework. The validate-then-repair pattern, append-only
context discipline, and model-aware contract mediation are patterns
pioneered in the open-source AI coding agent community.

Built for the [Pi coding agent](https://pi.dev) by
[@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

---

## License

MIT
