# pi-tool-repair 🔧

> Validate-then-repair middleware for Pi agent tool calls.
> Fixes common open-model tool-use mistakes **before execution** — zero extra LLM calls.

## The problem

Open models (DeepSeek, Kimi, Qwen, GLM) often know the right tool call but
violate strict contracts that closed models have seen millions of times:

- Sending `null` instead of omitting optional fields
- Emitting arrays as JSON strings (`"[1,2,3]"` → `[1,2,3]`)
- Wrong container types (bare string where `["foo"]` expected)
- Accidental Markdown autolinks in file paths (`<src/utils.ts>`)
- Unclosed braces from truncated streaming output

These are **harness problems**, not model problems. A forgiving harness fixes
them without a single extra LLM call.

## Install

```bash
pi install git:github.com/vvbz/pi-tool-repair
```

Or copy into your extensions folder:

```bash
cp -r pi-tool-repair ~/.pi/agent/extensions/
pi --reload
```

## What it fixes

| Pass | Failure mode | Before | After |
|---|---|---|---|
| `null→omit` | Null on optional fields | `{path: "/x", limit: null}` | `{path: "/x"}` |
| `json-parse` | Stringified array/object | `{edits: "[{\"a\":1}]"}` | `{edits: [{a:1}]}` |
| `split-lines` | Multi-line string → array | `"a\nb\nc"` | `["a","b","c"]` |
| `strip-md-link` | Markdown autolink in path | `"<src/file.ts>"` | `"src/file.ts"` |
| `close-braces` | Truncated JSON | `{"path":"/x","edi` | `{"path":"/x","edi"}` |

All repairs are logged. The Pi footer shows live stats:

```
repair: 12/47 (null→omit:8 json-parse:3 strip-md-link:1) | bash: null→omit $.command
```

## Compatibility

Works alongside any other Pi extension. Uses `tool_call` event — mutates
`event.input` in place without blocking. Chained extensions always see the
repaired arguments.

Tested with: `pi-rtk-optimizer`, `pi-guardrails`, `pi-permission-system`,
`pi-observational-memory`, `pi-fork`, `pi-minimal-subagent`.

## Why it works

From Ahmad Awais / Reasonix research:

> Open model tool failures are predictable and limited. A repair layer that
> lets Zod fail first, then applies targeted fixes, brought DeepSeek V4 Pro
> to beat Opus 4.7 in 6/10 internal evals.

This extension applies the same validate-then-repair pattern at Pi's tool
call boundary — for any model, any provider.

## License

MIT
