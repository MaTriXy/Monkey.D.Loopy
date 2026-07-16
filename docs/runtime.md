# `@loopyc/runtime` — durable execution engine

The runtime that compiled **standalone** artifacts depend on. It owns the **outer** loop:
journaling, replay, caps, durable sleep, and breakpoints. The **inner** ReAct turn is never
owned by the runtime — `agent` steps delegate to a harness. Source:
[`packages/runtime`](../packages/runtime).

## API

```ts
import { createRuntime } from "@loopyc/runtime";

const runtime = createRuntime(config, options?);
await runtime.run();    // loop until terminate() or a cap; resumable
await runtime.step();   // advance exactly one iteration → RunResult
runtime.requestStop({ actor, reason });      // cross-process marker; honored at a safe boundary
await runtime.resume({ actor, reason });     // clear an acknowledged graceful stop + continue
await runtime.recoverUncertain(resolution);  // explicit retry | assume-done | abort
await runtime.main(process.argv.slice(2));  // run | step | resume | stop | recover | doctor
await runtime.doctor(); // preflight checks
```

### `RuntimeConfig` (what generated `loop.mjs` provides)

```ts
{
  spec: { id, meta?, caps, schedule?, signal?, observe?, provenance? },
  initialState: () => Record<string, unknown>,
  iterate:   (ctx) => Promise<void>,   // one pass; mutates ctx.state via effects
  terminate: (ctx) => boolean,         // exit predicate (read-only)
  fingerprint?: (ctx) => string,       // no-progress signal (read-only)
  onExit?:   (ctx) => Promise<void>,   // runs once on natural termination
  gates?: unknown[],
}
```

### `RuntimeOptions`

| Option | Default | Purpose |
|---|---|---|
| `cwd` | `process.cwd()` | base dir for `.loopy/runs/<runId>/` |
| `runId` | `"default"` | run identity |
| `inputs` | `inputs.json` in cwd, else `{}` | values for `ctx.inputs` |
| `env` | `process.env` | values for `ctx.env` |
| `now` | `Date.now` | injectable clock |
| `maxBlockMs` | `1000` | sleeps ≤ this block in `run()`; longer ones **park + exit** |
| `mode` | `"nonInteractive"` | matched against a breakpoint's `auto_approve_in` |
| `autoApprove` | `false` | **human gates fail closed by default**; opt in to auto-approve |
| `effectTimeoutMs` | `300000` | per-effect timeout for http/shell |
| `delay` | real `setTimeout` | injectable sleep (for tests) |
| `effectRetries` | `spec.retry.max ?? 0` | retry count for transient effect failures (exponential backoff) |
| `effectRetryBackoffMs` | `spec.retry.backoff_ms ?? 1000` | base backoff between retries |
| `effectEnv` | inherit process env | when set, shell subprocesses use ONLY this env (scrubbed) |
| `approveCaps` | `false` | approve a pending cap-breakpoint on resume (reset its counter + continue) |
| `agentHarnesses` | `internal`, `claude-code` | `{ <name>: (req) => Promise<AgentResult> }` |
| `effects` | real http/shell | `{ http?, shell? }` overrides (for tests/mocks) |

### `ctx` (passed to `iterate`/`terminate`/`fingerprint`)

`state`, `inputs`, `env`, `iteration` (0-based), `meta`, plus effects:
`http(req)`, `shell(cmd | {command, args})` (an argv runs via execFile, no shell),
`agent({harness, prompt, allowedTools})`, `sleep(dur)`, `sleepUntil(predicate)`,
`breakpoint({ask, strategy?, autoApproveIn?})`, `jsonpath(obj, path)`.

`http(req)` returns the parsed JSON body by default (or `{ status, raw }` when the response
is not JSON). Pass `{ ..., envelope: true }` to get a `{ status, ok, headers, body }` object
instead — `body` is the parsed JSON (or raw text) — so the loop can read the HTTP status.

## Agent harnesses (provider-agnostic — no vendor lock)

`agent` steps name a `harness`. Built-in:

- **`internal`** — a no-op (deterministic; for tests/CI).
- **`llm`** — a single OpenAI-compatible chat completion. **Works with any OpenAI-compatible
  provider** (cloud or local). Configure by env (`resolveLlm`): `LOOPY_LLM_API_KEY`
  (+ `LOOPY_LLM_BASE_URL`, `LOOPY_LLM_MODEL`),
  or it auto-detects a provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` /
  `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY`). JSON replies are returned
  directly (so `save: { x: "$.field" }` works); text replies are at `$.result`.
- **Coding-agent CLIs — tool-agnostic, not Claude-only.** Each runs headless via `execFile`
  (no shell), in its verified non-interactive form. Because a loop is **unattended**, CLIs that
  would otherwise stop for an approval prompt run in auto-approve mode so a step can't hang —
  deliberate human gates belong in the spec as `breakpoint`/`gates`:
  - **`claude-code`** — `claude -p --output-format json` (envelope carries usage + `total_cost_usd`).
  - **`codex`** — `codex exec --skip-git-repo-check <prompt>`.
  - **`opencode`** — `opencode run <prompt>`.
  - **`antigravity`** — `agy -p <prompt> --yes`.
  - **`cursor-agent`** — `cursor-agent -p --force <prompt>`.
  - **`cli`** — the universal escape hatch: drive **any** agent CLI, with **your exact flags**, via
    `LOOPY_AGENT_CMD` (e.g. `"codex exec"`, `"opencode run"`, `"agy -p"`, `"aider --message"`,
    `"amp -x"`). The prompt is appended as one final argument (execFile — never shell-interpolated).
  Point a named harness at an alternate binary with `LOOPY_<NAME>_BIN` (e.g. `LOOPY_CODEX_BIN`).
  Non-`claude-code` CLIs return JSON (optionally ```json-fenced) as the result object, else plain
  text at `$.result` (`unwrapAgentText`). `BUILTIN_HARNESS_NAMES` lists them all.

Register your own via `createRuntime(config, { agentHarnesses: { myHarness: async (req) => ({...}) } })`.
The exported `resolveLlm()` / `chatComplete()` are reusable provider-agnostic helpers.

The `llm` harness also: configures **keyless** local servers from a bare `LOOPY_LLM_BASE_URL`
(any local OpenAI-compatible server), **strips markdown fences** so a ```json reply still parses for `save`,
bounds each request with a **timeout** (default 120s), and uses `max_completion_tokens` for OpenAI
reasoning models. Model-supplied `usage` is ignored — only the trusted provider usage is metered.

## Cost metering (the `usd` budget cap)

`caps.budget.usd` is enforced from real cost. The `llm` harness derives USD per call via
[`pricing.ts`](../packages/runtime/src/pricing.ts): a per-model table (`MODEL_PRICING`, USD per
1M input/output tokens), overridable with `LOOPY_LLM_PRICE_IN` / `LOOPY_LLM_PRICE_OUT`, and it
prefers a provider-reported `usage.cost` (e.g. OpenRouter) when present. The `claude-code` harness
reports `total_cost_usd`. If a model can't be priced, `doctor` warns rather than letting the $ cap
be a silent no-op (token + wallclock caps still apply). Exposed helpers: `priceUsd`,
`normalizeModel`, `isCostMeterable`, `MODEL_PRICING`.

Budget cap-breakpoints are **resumable**: approving a token/usd/wallclock cap rebases that meter so
the run opens a fresh window and continues (parity with `max_iterations` / `no_progress`).

### `RunResult`

```ts
{ status: "completed" | "waiting" | "paused" | "uncertain" | "stopped" | "failed",
  iteration, state, reason?, wakeAt?, next?, uncertain? }
```

`uncertain` is non-terminal. Its `uncertain` field identifies the original iteration, sequence,
kind, and deterministic effect identity. It can only continue through
`recoverUncertain({ action, actor?, reason, ... })`:

- `retry` re-executes the effect with an explicit at-least-once risk;
- `assume-done` supplies the externally verified `result` without re-execution;
- `abort` intentionally makes the run terminal `stopped`.

Every resolution records the action, actor, reason, and original effect identity.
The standalone CLI exits `2` for `uncertain` (`1` remains generic failure), so supervisors can
route it to intervention without interpreting it as success or blindly retrying it.

## Journal format

Under `.loopy/runs/<runId>/`:

- `events.jsonl` — append-one-line-per-event, each with a **chained sha256** checksum.
  Event types: `run_start` (carries `baseState`), `effect` (write-ahead `pending` then `done`),
  `effect_recovery`, `iteration_snapshot` (state + fingerprint), `parked` (`wakeAt`), `cap`,
  `stop_requested`, `stop_cleared`, `terminated`, `failed`.
- `state.json` — derived state cache (debuggable; the journal is the source of truth).
- `meta.json` — `{ status, iteration, tokens, usd, eventCount, lastChecksum, ... }`.
- `lock` — a PID lockfile held for the duration of a run (stale-PID reclaimable).

## Execution & resume semantics

- Each `iterate` pass runs to a `iteration_snapshot`; resume restores the last snapshot (or
  `baseState`) and continues at the next iteration.
- **Effects are write-ahead and replay-safe**: a `pending` record is written before the side
  effect and a `done` record (with result) after. On replay a completed effect returns its
  journaled result (no re-execution); a **divergent identity** fails loud. A
  **pending-without-done** (crash mid-effect) pauses as `uncertain` rather than silently retrying,
  assuming success, or becoming a generic terminal failure. Runtime <=0.1.0 journals poisoned by
  the old uncertain-effect failure are recognized and exposed through the same recovery flow.
- **Graceful external stop**: `requestStop({ actor, reason })` publishes an atomic marker without
  racing the active journal writer. The runner acknowledges it only before work or after a complete
  iteration snapshot, returns resumable `stopped`, and records the request. `resume()` records who
  cleared it and why. A forced kill inside an effect is not called graceful; it becomes `uncertain`.
- **Durable sleep**: `sleep(dur)` longer than `maxBlockMs` parks the run (status `waiting`,
  records `wakeAt`) and returns; a later `run()`/`resume` past `wakeAt` continues.
- **Caps**: `max_iterations`, `no_progress` fingerprint, and token/$/wallclock budget. Token/$
  budgets are metered **per agent call** (no overshoot within an iteration). `on_cap_exceeded`:
  `fail` → `failed`, `exit-clean` → `stopped`, `breakpoint` → `paused`.
- **Breakpoints** fail closed by default; an approved one is journaled, an unapproved one stays
  unresolved so a later run re-evaluates (resumable, not auto-denied).

## Durability guarantees & limitations

Guaranteed: bounded execution under caps; crash-resume from the journal; no re-execution of
completed effects; explicit resolution of the uncertain window; journal-safe graceful stop;
deterministic replay (given a deterministic `iterate`); locale-independent, corruption- and
truncation-evident journal.

The runtime does not promise exactly-once delivery to external systems. Choosing `retry` after an
uncertain effect explicitly accepts at-least-once risk; `assume-done` requires external proof and a
supplied result.

Transient effect failures are **retried** with exponential backoff per `retry: { max, backoff_ms }`
(or the `effectRetries` option); only an exhausted retry is terminal. The MCP `run_loop` runs
shell with a scrubbed, allowlisted env.

Semantics to know (intentional): `sleepUntil`'s predicate is evaluated against freshly-read
`inputs`/`env` only — effects issued earlier in the same iteration are journal-memoized, so the
predicate sees their frozen values across resumes (use it for time/external conditions). The
wallclock budget is measured from the first start and **counts parked/down time** (real elapsed,
not active CPU).

A cap-action `breakpoint` now **pauses and is resumable**: re-run with `approveCaps` (or
`node loop.mjs resume --approve`) to approve the gate, reset that cap's counter, and continue —
mirroring babysitter's approve-and-reset. The `shell` effect supports a no-shell argv form.

Standalone CLI recovery examples:

```bash
node loop.mjs stop --actor deploy-bot --reason "maintenance"
node loop.mjs resume --actor operator --reason "maintenance complete"
node loop.mjs recover --retry --actor operator --reason "external audit shows no side effect"
node loop.mjs recover --assume-done --result-json '{"deploymentId":"dep-123"}' \
  --actor operator --reason "deployment provider confirms completion"
node loop.mjs recover --abort --actor operator --reason "rolled back manually"
```

The journal is corruption-evident by default (chained sha256); set `LOOPY_JOURNAL_KEY` to make
it **tamper-evident** (keyed HMAC — the same key is then required to load/resume).

Tracked for later (see [SPEC.md](../SPEC.md)): richer from-script / from-trace spec inference
(LLM-side, via the `/loopy` skill).
