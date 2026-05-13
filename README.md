# pi-tool-repair 🔧

> **Validate-then-repair middleware for Pi agent tool calls.**
> Fixes common open-model tool-use mistakes **before execution**
> — zero extra LLM calls, zero latency penalty.

---

## Why this exists

### The open-model tool-calling gap

Closed models (Claude, GPT-5) have seen strict tool schemas millions of
times during RLHF and fine-tuning. They almost never violate contracts.

Open models (DeepSeek V4, Kimi K2.6, Qwen, GLM, Mistral) are equally
capable at _reasoning_ about what tool to call and what arguments to pass
— but they lack the same volume of schema-constrained training. The
result is predictable, repeatable failure modes:

| Failure mode | Example | Why it happens |
|---|---|---|
| Null on optional fields | `{path: "/x", limit: null}` | Model emits null instead of omitting the key |
| Stringified JSON | `{edits: "[{\"a\":1}]"}` | Model double-encodes structured data |
| Container mismatch | `"src/a.ts\nsrc/b.ts"` instead of `["src/a.ts","src/b.ts"]` | Model emits a flat string for a list parameter |
| Markdown autolinks | `"<src/utils.ts>"` | Model applies prose formatting to code paths |
| Truncated JSON | `{"path":"/x","edi` | Streaming cutoff leaves unclosed braces |

These are **harness problems, not model problems.** The model knows the
right answer — it just violates the strict contract that the tool schema
demands. A forgiving harness closes this gap.

### The evidence

From Ahmad Awais / Reasonix research (2026):

> By adding a smart tool-input repair layer, DeepSeek V4 Pro started
> beating Opus 4.7 in 6/10 internal evals. The failure modes across
> open models are very predictable and limited — a few targeted fixes
> cover nearly all cases.

The same validate-then-repair approach, applied at Pi's tool-call
boundary, brings these gains to **any model, any provider** — without
modifying the model, retraining, or adding LLM calls.

---

## How it works

### The validate-then-repair pattern

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
- **No re-validation** — Pi doesn't re-validate after our mutation (per Pi's `tool_call` contract)
- **In-place mutation** — `event.input` is mutable. We modify it, don't replace it
- **Chained extensions** — other `tool_call` handlers see our repairs
- **Never blocks** — we never return `{block: true}`. If args are unfixable, the tool fails naturally with its own error
- **Zero overhead** — no async work, no network calls, no LLM calls. Pure data transformation

### Integration point

Pi's `tool_call` event fires after `tool_execution_start` but **before**
the tool actually executes. The `event.input` object is directly mutable
with guaranteed behavior:

> Mutations to `event.input` affect the actual tool execution. Later
> `tool_call` handlers see mutations made by earlier handlers. No
> re-validation is performed after your mutation.

This is the perfect insertion point for a repair layer — we get the raw
model output before any tool code runs, and our fixes propagate to
everything downstream.

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

### Uninstall

```bash
pi uninstall git:github.com/yanapattin-source/pi-tool-repair
```

Or remove from `~/.pi/agent/settings.json` packages array.

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
{ edits: '[{"oldText":"foo","newText":"bar"}]' }

// After (repaired)
{ edits: [{ oldText: "foo", newText: "bar" }] }
```

**Safety:** Only applies when the string is ≥3 characters and starts
with bracket/brace. Invalid JSON is left alone. Short strings like
`"{}"` (2 chars) are never parsed — too risky for false positives.

### 3. `split-lines` — Multi-line string to array

**Problem:** When a tool parameter expects `string[]`, models sometimes
emit a single newline-delimited string instead. Common with `grep`
patterns, file path lists, or multi-item arguments.

**Fix:** Detect strings containing newlines with non-whitespace content
on at least two lines. Split by newline, trim each line, and replace
with a string array.

```typescript
// Before (model output)
{ paths: "src/auth.ts\nsrc/db.ts\nsrc/api.ts" }

// After (repaired)
{ paths: ["src/auth.ts", "src/db.ts", "src/api.ts"] }
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
{ path: "<src/components/Button.tsx>" }

// After (repaired)
{ path: "src/components/Button.tsx" }
```

**Safety:** Only matches strings under 200 characters with a file-like
extension (1-6 letter extension after a dot). Won't match generic angle
bracket usage like `<T>` or XML tags.

### 5. `close-braces` — Truncated JSON repair

**Problem:** During streaming, model output can be truncated mid-JSON.
The last chunk arrives with unclosed braces or brackets. Most tool
frameworks reject this as invalid JSON.

**Fix:** Count open vs closed braces and brackets. If the imbalance is
1-3 (plausibly a truncation, not completely garbled), append the missing
closing characters.

```typescript
// Before (model output — truncated by streaming)
{ body: '{"name":"test","items":[1,2' }

// After (repaired)
{ body: '{"name":"test","items":[1,2]}' }
```

**Safety:** Only repairs imbalance ≤3 characters. Heavier imbalance
(e.g., 10+ unclosed braces) is left alone — it's probably not JSON at
all. String content inside quotes is correctly tracked and not counted.

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

| Extension | Status | Notes |
|---|---|---|
| `pi-permission-system` | ✅ Compatible | Repair runs BEFORE permission checks — repaired args pass permission gates cleanly |
| `pi-guardrails` | ✅ Compatible | Guardrails operates on file paths, repair operates on tool args — no overlap |
| `pi-rtk-optimizer` | ✅ Compatible | Repair fixes input args, RTK optimizes bash commands and output — different lifecycle stages |
| `pi-observational-memory` | ✅ Compatible | No shared hooks — repair is tool_call, memory is compaction |
| `pi-fork` | ✅ Compatible | Forks inherit the extension normally |
| `pi-minimal-subagent` | ✅ Compatible | Subagents get their own extension instance with fresh stats |
| `LaPis` | ✅ Compatible | No overlap — LaPis is code analysis, repair is tool call middleware |

### With different models

The extension is model-agnostic. It works identically whether you're
using DeepSeek, Kimi, Claude, GPT, Gemini, or local models. The repair
passes are based on the _structure_ of the tool call arguments, not
which model produced them.

Closed models (Claude, GPT-5) will rarely trigger repairs — they've
been trained extensively on strict schemas. Open models will trigger
repairs more often. Both benefit from the safety net.

### With all tool types

The extension intercepts **every** tool call — built-in tools (`read`,
`bash`, `write`, `edit`, `grep`, `find`, `ls`), extension-registered
tools, and MCP-proxied tools. The repair passes are generic: they walk
any object structure and apply fixes regardless of which tool is being
called.

---

## Configuration

No configuration required. The extension works out of the box with
sensible defaults.

If you want to disable specific repair passes, edit the extension code
directly in `src/index.ts` — comment out the pass you want to skip in
the `repairArgs` function.

Future versions may add a config file at
`~/.pi/agent/extensions/pi-tool-repair/config.json` for per-pass toggles.

---

## Testing

### Unit tests (standalone, no Pi required)

```bash
cd pi-tool-repair
npx tsx test-repair.ts
```

Runs 10 test cases covering all 5 repair passes, nested repairs, and
false-positive guards. All should pass.

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
- **Split-lines is heuristic.** Converting `"a\nb"` to `["a","b"]` is
  a guess based on common failure patterns. If the tool genuinely
  expects a multi-line string, this fix could be wrong. However, the
  pattern of models emitting multi-line strings where arrays are
  expected is overwhelmingly more common.
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
   `src/index.ts`
2. Add test cases to `test-repair.ts`
3. Run the tests: `npx tsx test-repair.ts`
4. Submit a PR

Good candidates for new passes:
- Model emits `"true"`/`"false"` strings where boolean expected
- Model emits numbers as strings (`"42"` → `42`)
- Nested nulls in arrays of objects

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
