# LoopSpec v0.1 — reference

A `LoopSpec` is one typed YAML document that declares a single **bounded** agent loop.
Every input (a blueprint, a hand-written file, an NL draft) normalizes to this shape before
any code is emitted. Canonical types live in
[`packages/core/src/types.ts`](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/packages/core/src/types.ts); the compact LLM-facing guide is
[`LOOPSPEC_GUIDE`](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/packages/core/src/toon.ts).

> **The load-bearing rule:** the compiler refuses to emit an unbounded loop. `terminate` is
> required and `caps` are mandatory (auto-injected if omitted).

## Top-level fields

| Field | Required | Description |
|---|---|---|
| `loopspec` | ✓ | Format version — `"0.1"`. |
| `id` | ✓ | Identifier; matches `[A-Za-z0-9_.:-]+` (lowered into code/comments). |
| `pattern` | ✓ | `react` · `plan-execute-reflect` · `evaluator-optimizer` · `loop-until-dry` · `map-reduce` · `poll-until` · `cron`. |
| `body` | ✓ | The iteration: a non-empty list of steps. |
| `terminate` | ✓ | Exit predicate + signal tier (see below). |
| `caps` | auto | Limits. Auto-injected per-pattern if omitted; set them explicitly. |
| `meta` | | `{ name, version, description }`. |
| `inputs` | | `{ <name>: { type, required?, default?, description? } }`. |
| `state` | | `{ store: journal, vars: { <name>: { type, init } } }`. Only `journal` is supported in 0.1 (`memory` is reserved). |
| `schedule` | | `{ mode: manual\|cron\|watch\|forever, cron? }`. |
| `retry` | | `{ max, backoff_ms }` — transient http/shell/agent failures retry with exponential backoff (default no retry). |
| `gates` | | Durable human-approval gates `{ after?, when?, ask, strategy?, auto_approve_in? }` — lowered to an inline, fail-closed `ctx.breakpoint()` after the named step (standalone + babysitter). |
| `observe` | | `{ trace: journal\|none, hooks?, notify? }`. |
| `target` | | Default compile target + emitted surfaces: `{ runtime: standalone\|babysitter\|claude-code\|claude-native\|n8n, emit: [cli, skill, doctor] }`. |
| `provenance` | | `{ factory_version, source, run_id }` (baked into the artifact). |

## Compile target notes

`target.runtime` chooses the default compile output when `loopc compile` is run without
`--target`. It does not weaken validation: every target still starts from the same bounded,
validated LoopSpec.

- `standalone` is the hard-guarantee runtime target. It emits `loop.mjs`, `loop.lock`, a local
  journal, and optional vendored runtime bundle.
- `claude-native` emits a Claude Code project skill under `.claude/skills/<loop>/SKILL.md`.
  The skill command name comes from the sanitized loop id, and the original LoopSpec is embedded
  at `.claude/skills/<loop>/reference/loopspec.json`.
- Use `--target all` when you want the Claude-native skill to sit next to a standalone artifact.
  In that layout, the generated skill can delegate to standalone for runtime-enforced journals,
  replay, caps, durable sleep, breakpoints, and budget metering. Without standalone, the skill is
  still usable from Claude Code, but those guarantees are soft and agent-honored.

## Types

`string` · `int` · `number` · `boolean` · `json` · `list` · `enum[a,b,c]`

## Step kinds (closed set — no raw code)

```yaml
- { id, kind: agent, harness, prompt, allowed-tools?, save?, on_done? }   # harness: llm | claude-code | codex | opencode | antigravity | cursor-agent | cli | internal
- { id, kind: shell, cmd, save?, on_done? }                               # runs a shell command
- { id, kind: http,  request: { method, url, headers?, body? }, envelope?, save?, on_done? }
- { id, kind: breakpoint, ask, strategy?, auto_approve_in? }              # durable human gate
- { id, kind: sleep, for: "5m" | until: "${...}" }                        # exactly one of for/until; durable
- { id, kind: reduce, over: "${...}", as?, body: [...] }                  # fan out over a collection
```

Each step may carry a `when: "${...}"` guard. `agent`/`shell`/`http` steps may `save` json-path
extractions into state; `agent` `save` reads the harness's structured result envelope.

- **`save`**: `{ <stateVar>: "$.path.into.result" }`
- **`envelope`** (http only, opt-in): when `true`, the step result is `{ status, ok, headers, body }`
  instead of the bare parsed body — so `save: { code: "$.status", payload: "$.body.field" }` can read
  the HTTP status of a JSON response. Default (omitted) keeps the body-direct shape.
- **`on_done`**: `{ incr: <var> }` | `{ set: { <var>: value-or-${expr} } }` | `{ append: { <listVar>: value-or-${expr} } }`
  (`append` into a `list` var is how `reduce` accumulates per-item results.)

## Expression language (`${...}`)

A small, safe subset — **no function calls, no arbitrary identifiers**:

- Roots: `state.x`, `inputs.y`, `env.Z`, `meta.m`, `iteration`, `item` (inside `reduce`).
- Operators: `== != < <= > >=`, `&& || !` (and `and` / `or` / `not`), `+ - * / %`, `in`.
- Literals: numbers, `'strings'`/`"strings"`, `true` / `false` / `null`.

`&&`/`||` return operands (JS semantics), so `${a || b}` works as a fallback. The same AST is
used by the validator (reference + safety checks), the runtime (evaluation), and the emitter
(lowered to JS) — so all three agree.

## terminate

```yaml
terminate:
  signal: state-predicate   # oracle > state-predicate > llm-judge > self-assess
  until: "${state.status == 'green'}"
  on_exit: { kind: shell, cmd: "./notify.sh ${state.status}" }   # optional action on exit
```

Rank your signal by trustworthiness: an **oracle** (tests/compiler/schema) is strongest; a
model's **self-assessment** is weakest (and requires explicit caps).

### Termination grounding — the label is checked, not trusted

A declared signal is only as strong as the steps that *feed* the exit predicate. The
factory classifies the evidence chain behind every `until` (`terminationGrounding` in
`@loopyc/core`):

| Grounding | Meaning |
|---|---|
| `external` | The exit var(s) are `save`d by **http/shell** steps — real-world evidence decides. |
| `structural` | Only `on_done` mutations (e.g. an unconditional `done` flag) — deterministic sequencing. |
| `mixed` | Some evidence, some agent self-report. |
| `agent` | Only **agent** `save`s feed the exit — the model grades its own work. |

Taints propagate: a `done` flag set only `when` an agent-reported score clears a bar is
still agent-fed. Declaring `oracle` or `state-predicate` over an agent-fed predicate
trips the `ungrounded-exit` warning and the scorecard caps the termination dimension at
the self-assessment ceiling — an honest `llm-judge`/`self-assess` label scores *higher*
than an inflated one. To upgrade a loop's grade, ground the exit: let a shell exit code,
an http status, or a scan count decide, not the agent's own report.

## caps (mandatory)

```yaml
caps:
  max_iterations: 288
  no_progress: { fingerprint: "${state.status}", max_repeats: 12 }   # anti-thrash
  budget: { tokens: 200000, usd: 5.0, wallclock: "24h" }
  on_cap_exceeded: breakpoint    # fail | breakpoint | exit-clean
```

Per-pattern defaults (when omitted) are in
[`normalize.ts`](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/packages/core/src/normalize.ts).

## artifacts and notify (optional, deny-by-default)

```yaml
artifacts:
  include: ["reports/**/*.md", "metrics/*.json"]
  exclude: ["reports/private/**", "**/.env*"]
  max_files: 1000
  max_bytes: 50000000
notify:
  policy: on-change
  channels: [ops]
```

Artifact paths are relative allowlist globs with explicit file/count ceilings. Active content,
secret/dependency allowlists, traversal, and absolute paths are compile-blocking. Notification
channels are logical names; webhook URLs/tokens never belong in LoopSpec. No contract means no
indexed files, and an empty channel list means no external calls. See
[Artifacts and notifications](./artifacts-and-notifications.md).

## Validation — hard gates

`loopc validate` blocks compilation on any of these:

1. `terminate` present, with a `signal` and a parseable `until`.
2. **Exit reachable** — `until` reads a state var some step writes, or `iteration`.
3. `self-assess` termination requires **explicit** caps.
4. Every `state`/`inputs` reference is declared; every `save`/`on_done` target is declared.
5. Exactly one of `sleep.for` / `sleep.until`.
6. Names (ids, vars, inputs, reduce aliases) are safe identifiers; expressions are in the safe
   subset; `schedule: cron` has a `cron`; gate `after` references a real step.
7. Artifact globs stay relative and cannot allowlist secrets/active content; notification channels
   are logical names rather than URLs or credentials.

Soft warnings (non-blocking, downgrade the score): weak signal, **ungrounded exit** (a
strong signal label over an agent-fed predicate), auto-injected caps, missing
`no_progress` on poll/loop-until-dry, missing budget, `trace: none`.

## Worked example

See [`examples/deploy-watch.yaml`](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/examples/deploy-watch.yaml) — a `poll-until` loop that
checks a deploy, lets an agent fix it when red, sleeps between checks, and exits when green.
Scaffold any pattern with `loopc new <id> --blueprint <name>`.
