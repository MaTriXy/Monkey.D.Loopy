# Monkey D Loopy — Specification (v0.1)

> A factory for runnable, crash-resumable agent **loops**. Define a loop once in a
> declarative `LoopSpec`; compile it to a runnable artifact with termination and cost
> guarantees baked in.

---

## 1. Why this exists

Coding agents and harnesses re-invent loops constantly — with ad-hoc pretext,
inconsistent formatting, and no shared understanding of the actual process/flow.
Hand-rolled agent loops fail in predictable ways:

- **No termination criteria** → they never stop, thrash on bad context, or drift off goal.
- **Context blow-up** → history grows every iteration until the window degrades.
- **Unbounded cost** → by turn _N_ you pay for _N_ copies of accumulated context.
- **No resumability** → a crash destroys all progress.
- **No observability** → failures are undiagnosable.
- **Weak verification** → the model judges its own success and declares victory while wrong.

A *factory* solves these **structurally**, by construction. The product's center of
gravity is the **LoopSpec** — a declarative format that captures the iteration body,
termination predicate, state, tools/agents, scheduling, and observability — so
neither a human nor an agent has to reinvent a loop each time.

The **load-bearing invariant:** _the compiler refuses to emit an unbounded loop._
Every loop must declare a termination predicate and carries mandatory caps.

## 2. Architecture

TypeScript pnpm monorepo with a strict dependency direction (pure core → I/O at the edges).

```
packages/core      @loopy/core    pure, ZERO-I/O brain — IR, validator, planner
packages/runtime   @loopy/runtime durable engine — journal, replay, caps, iterate, breakpoints, sleep
packages/verify    @loopy/verify  codegen-free interpreter + dry-run verify + scorecard
packages/cli       loopc          byte-writer / driver: new | validate | verify | score | run | inspect | compile | schedule | reprint | targets | infer-scaffold | blueprints
packages/mcp       loopc-mcp      agent surface: get_loop_schema, list_blueprints, new_loop, validate/verify/compile/run/inspect, infer_loop_scaffold
packages/infer     @loopy/infer   deterministic FactPack extraction (scripts + journals) → draft LoopSpec
packages/evals     @loopy/evals   eval harness graded by the real code
.claude/skills/loopy  the authoring judgment layer over loopc (NL → spec)
```

**Data flow:** `source (NL | blueprint | YAML)` → normalizer → **LoopSpec IR** →
two-tier validator (hard gates) → pure planner → target adapter → `PlannedFile[]` →
CLI materializes a complete project → verify (M2) → scorecard (M2) → run.

**Engine decision (locked):** `@loopy/runtime` is the **canonical** engine — one small
published package distilled from babysitter's proven model. The **babysitter adapter
ships in the MVP** as a first-class second target (not deferred). The adapter seam and
capability matrix are real from day one.

**Boundary:** Loopy generates and enforces the **OUTER** loop. The **inner ReAct turn
is never owned by Loopy** — `agent` steps delegate to a harness (the runtime ships a
provider-agnostic `llm` harness as the portable default, plus `internal` and pluggable
coding-agent CLIs); tool work uses the `shell` / `http` step kinds.

## 3. The LoopSpec IR (v0.1)

One typed YAML IR (zod-validated; also serialized to TOON for LLM authoring). Every
input normalizes to this shape before any code is emitted. See
[`packages/core/src/types.ts`](packages/core/src/types.ts) for the canonical types and
[`LOOPSPEC_GUIDE`](packages/core/src/toon.ts) for the LLM-facing reference.

```yaml
loopspec: "0.1"
id: deploy-watch
pattern: poll-until        # react | plan-execute-reflect | evaluator-optimizer | loop-until-dry | map-reduce | poll-until | cron
target: { runtime: standalone, emit: [cli, skill, doctor] }

inputs:
  status_url: { type: string, required: true }

state:                     # typed + journal-backed; you never manage storage
  store: journal
  vars:
    status:  { type: "enum[pending,green,red]", init: pending }
    attempt: { type: int, init: 0 }

body:                      # the iteration; each step is an EFFECT with a closed kind
  - { id: check,  kind: http,  request: { method: GET, url: "${inputs.status_url}" }, save: { status: "$.state" } }
  - { id: triage, when: "${state.status == 'red'}", kind: agent, harness: llm,
      prompt: "Deploy failed (attempt ${state.attempt}). Diagnose and push a minimal fix.", on_done: { incr: attempt } }
  - { id: wait,   when: "${state.status == 'pending'}", kind: sleep, for: 5m }

terminate:                 # REQUIRED — build refused without it. signal: oracle > state-predicate > llm-judge > self-assess
  signal: state-predicate
  until: "${state.status == 'green'}"
  on_exit: { kind: shell, cmd: "echo deploy ${state.status}" }

caps:                      # MANDATORY — auto-injected with per-pattern defaults if omitted
  max_iterations: 288
  no_progress: { fingerprint: "${state.status}", max_repeats: 12 }   # anti-thrash; count alone is insufficient
  budget: { tokens: 200000, usd: 5.0, wallclock: "24h" }
  on_cap_exceeded: breakpoint

schedule: { mode: forever }   # manual | cron("…") | watch | forever
gates: [ { after: triage, when: "${state.attempt >= 3}", ask: "3 failed attempts. Approve another?", auto_approve_in: [yolo, ci] } ]
observe: { trace: journal }
```

### Step kinds (closed set — no raw code)
`agent` · `shell` · `http` · `breakpoint` · `sleep` · `reduce`

`agent`, `shell`, and `http` steps may `save` json-path extractions into state (agent
`save` reads the harness's structured result envelope). `on_done` supports
`incr` / `set` / `append` — `append` into a `list` state var is what lets `reduce`
actually fold per-item results. All spec-supplied names (ids, state vars, inputs,
reduce aliases) must be safe identifiers because they are lowered into generated code.

### Expression language
A tiny **safe** subset (no function calls, no arbitrary identifiers): member access
(`state.x`, `inputs.y`, `env.Z`, `meta.m`, `iteration`, `item`), comparisons,
`&&`/`||`/`!` (and `and`/`or`/`not`), arithmetic, `in`, parentheses, literals. It is
parsed to an AST that is reused by the validator (reference/safety checks) and the
runtime (evaluation), and lowered to JS for the artifact. See
[`packages/core/src/expr.ts`](packages/core/src/expr.ts).

## 4. Validation policy (two tiers)

Implemented in [`packages/core/src/validate.ts`](packages/core/src/validate.ts).

**HARD gates (compile-blocking):**
1. `terminate` present, with a `signal` and a parseable `until`.
2. **Exit reachability** — `until` must reference a signal some step can change
   (a written state var, or `iteration`); otherwise the loop can never terminate.
3. `self-assess` termination requires **explicit** caps (not just auto-injected defaults).
4. Every `state`/`inputs` reference is declared; every `save`/`on_done` target is declared (no faked outputs).
5. Exactly one of `sleep.for` / `sleep.until`.
6. Expressions are in the safe subset; types are well-formed; cron mode has a cron expr; gate `after` references a real step.

**SOFT rules (warn + downgrade scorecard, non-blocking):** weak signal
(`llm-judge`/`self-assess`), auto-injected caps, missing `no_progress` fingerprint on
poll/loop-until-dry, missing budget, `trace: none`.

## 5. Targets + capability matrix

Defined in [`packages/core/src/plan/types.ts`](packages/core/src/plan/types.ts). When a
spec uses a feature a target only **soft-enforces** or doesn't support, the compiler
emits an honest warning rather than silently degrading.

| Capability | standalone | babysitter |
|---|---|---|
| journal / replay / breakpoints / durable-sleep | enforced | enforced |
| max-iterations / no-progress | enforced | enforced (in-loop guard) |
| token / usd / wallclock budget | **enforced** | **soft** (babysitter does not meter usage) |
| schedule: forever / watch | enforced | enforced |
| schedule: cron | soft (host cron fires it) | soft |
| http (native) | enforced | **unsupported** → lowered to a `shell` curl task |

> If you need hard cost caps, use the `standalone` target.

Two further compile targets are **guide/scaffold** surfaces rather than runtimes: a
coding-agent execution guide (prose + flow an agent follows) and a workflow export. Both
are soft for journal/caps/state — you wire enforcement in the host — and are heavily
caveated in their generated output.

## 6. The `@loopy/runtime` contract (built in M1)

The standalone artifact imports `createRuntime` and calls into it. Implemented in
[`packages/runtime`](packages/runtime):

```ts
createRuntime({ spec, initialState, iterate, terminate, fingerprint?, onExit?, gates }) → {
  main(argv)   // dispatch: run | step | resume | doctor
  run()        // loop until terminate() or a cap; journal every step; resumable
  step()       // advance exactly one iteration → { status: executed|waiting|completed|failed, next }
  doctor()     // preflight: journal dir writable, budget set, max_iterations, signal, node version
}
```

The runtime owns: the append-one-file-per-event journal (sha256), deterministic replay,
invocation-key idempotency `hash(loopId, stepId, iteration)`, hard cap enforcement
(iterations + no-progress fingerprint + token/$/wallclock), durable breakpoints + sleep.
The `ctx` passed to `iterate`/`terminate` exposes `state`, `inputs`, `env`, `iteration`,
`meta` and the effect methods `http`, `agent`, `shell`, `sleep`, `sleepUntil`,
`breakpoint`, plus `jsonpath`.

### 7a. M1 runtime — hardened, with tracked limitations

An adversarial review of the runtime (26 confirmed findings) drove these fixes: **write-ahead,
identity-checked effects** (a divergent replay or a crash mid-effect fails LOUD rather than
silently re-running or returning a stale result); **torn-tail tolerance + truncation
detection** in the journal; **locale-independent checksums**; **defensive state persistence**
(non-serializable state → a `failed` event, not an uncaught crash); **`onExit` park/throw is
handled**; a **cross-process run lock**; **per-effect timeouts**; **budget metered per agent
call** (no overshoot within an iteration); and **human breakpoints fail CLOSED by default**
(auto-approve is opt-in via `autoApprove`/`autoApproveIn`) and are resumable on approval.

Deliberately deferred (documented, tracked for M2+):
- Cap action `breakpoint` is a sticky `paused` on standalone (the babysitter target's
  approve-and-reset semantics aren't mirrored yet).
- Effect errors are terminal — no retry/backoff policy yet.
- `sleepUntil`'s predicate sees journal-memoized effect values across resumes (it can only
  react to freshly-read inputs/env); wallclock budget counts parked/down time.
- `http`/`shell` keep their current result shapes (for cross-target parity), so HTTP status
  isn't surfaced on JSON responses; a `ctx.shell({command, args})` argv form is future work.

## 7. Milestones

- **M0 — IR + planner foundation (this commit).** `@loopy/core` (LoopSpec schema +
  TOON, two-tier validator, pure planner → `PlannedFile[]` for both targets) + `loopc`
  (`new` / `validate` / `compile` / `blueprints`) + a 7-pattern blueprint catalog + golden
  tests. `loopc validate` refuses any spec missing termination/caps. No execution yet.
  Hardened by an adversarial review pass: identifier gates close code-injection via
  ids/state-var-names/reduce-aliases; the http→curl lowering is POSIX-quoted; the two
  targets agree on `&&`/`||` semantics, 0-based `iteration`, cap reasons, and body
  interpolation. (Tracked for M1: the standalone runtime's `ctx.jsonpath` must implement
  the same minimal subset as the babysitter `__jsonpath` helper, or share one impl.)
- **M1 — Durable runtime + standalone artifact (the spine).** `@loopy/runtime`:
  event-sourced journal (chained sha256) + derived state cache, deterministic replay with
  **idempotent effects** (a killed run resumes without re-running completed effects),
  durable sleep (park + resume), breakpoints, and hard cap enforcement (max_iterations,
  no-progress fingerprint, token/$/wallclock budget). Effects: `http`, `shell`, `agent`
  (harnesses: `internal`, `claude-code`), `sleep`/`sleepUntil`, `breakpoint`. Verified by
  10 runtime tests + an end-to-end run of a compiled artifact (3 iterations, journaled,
  idempotent on re-run). _Still open: drive a generated artifact under a real babysitter;
  cost-accounting source for $ budgets; a published/linked `@loopy/runtime` so
  `npm install` resolves it (today the artifact resolves it via the workspace)._
- **M2 — Validation + authoring loop (verify + scorecard).** `loopc verify` dry-runs the
  loop through the real runtime with mocked effects (via a spec interpreter that reuses
  core's expression engine and is cross-checked to match the generated code), proving it is
  **bounded under caps** and **deterministic on replay** without side effects; `--fix` writes
  explicit caps. `loopc score` grades five weighted dimensions (termination safety, caps,
  observability, resumability, determinism) → a 0–100 letter grade. The **`/loopy` skill**
  ([.claude/skills/loopy](.claude/skills/loopy/SKILL.md)) is the NL→spec authoring judgment
  layer over `loopc`, and **`loopc-mcp`** (`@loopy/mcp`) exposes the whole factory as MCP tools
  (`get_loop_schema`, `list_blueprints`, `new_loop`, `validate_loop`, `verify_loop`,
  `compile_loop`, `run_loop`, `inspect_run`) — validated by an in-process test and a stdio smoke.
- **M3.1 — Packaging.** `pnpm build` (tsup) emits ESM `dist` + `.d.ts` for every package;
  bins get a plain-node shebang. Each package publishes its compiled `dist` via
  `publishConfig` (dev still runs from `src` via tsx). Verified end-to-end by packing all
  packages and, from a throwaway consumer, running the `loopc`/`loopc-mcp` bins **and a
  generated artifact** with plain `node` (no tsx). Also migrated `@loopy/mcp` off the
  deprecated `server.tool` is still pending (tracked).
- **M3.2 — Babysitter target proven.** The adapter was reconciled to the **real
  `@a5c-ai/babysitter-sdk` (0.0.x)** API: effects go through `defineTask()` + `ctx.task(def, args)`
  (shell `{shell:{command}}`, agent `{agent:{name,prompt},execution:{harness}}`), `ctx.breakpoint`
  branches on `.approved`, `ctx.sleepUntil` takes `ctx.now().getTime() + ms`, and `save` reads the
  task's returned value directly. The babysitter target now emits an installable project
  (`package.json` with the SDK dep). **Verified end-to-end**: a generated process ran under the
  real SDK CLI (`run:create --non-interactive` → `run:iterate` + `task:post` two-loop) to
  `completed`, returning the correct state (`{n:3}`).
- **M3.3 — Runtime deferrals (resilience).** **Effect retry/backoff**: transient
  http/shell/agent failures retry with exponential backoff (`retry: { max, backoff_ms }` on the
  spec, or the `effectRetries` runtime option); only an exhausted retry is terminal. **run_loop
  env-scrub**: the MCP run_loop runs shell with a minimal allowlisted env, not the server's
  secrets. **Semantics documented**: `sleepUntil` predicate freeze across resumes; wallclock
  counts parked/down time. _Still tracked (M3.4): cap-breakpoint resume parity (needs a human-
  approval resume channel) and a `shell({command, args})` argv form._
- **M3.4 — More compile targets.** Two new adapters via the existing seam + capability
  matrix: **claude-code** emits a markdown *prose execution guide* (`<id>.loop.md`) + Mermaid
  flow for an agent to follow (enforcement is agent-honored — flagged soft/unsupported);
  **n8n** emits a best-effort, importable workflow JSON scaffold (steps → nodes, IF loop-back),
  heavily caveated since n8n's item-passing model doesn't map to our journal/caps/state. Both
  registered in \`SUPPORTED_TARGETS\` (so \`--target all\` emits all four) with honest warnings.
- **M3.5 — Runtime parity & safety.** **cap-breakpoint resume parity**: a cap-action
  \`breakpoint\` now pauses and is resumable — \`approveCaps\` / \`resume --approve\` approves the
  gate, resets that cap's counter, and continues (babysitter-style approve-and-reset; tracked
  via \`cap_cleared\` journal events). **shell argv form**: \`shell\` steps accept \`args\`, lowered
  to \`ctx.shell({command, args})\` → \`execFile\` (no shell) on standalone, safely-quoted on
  babysitter — removes the shell-injection footgun for untrusted data.
- **M3.6 — Factory ergonomics.** \`compile\` now embeds \`loop.source.yaml\` in each artifact;
  **\`loopc reprint <dir>\`** recompiles it under the current factory (same target from
  \`loop.lock\`, in place by default). **\`loopc targets\`** prints the per-target capability
  matrix. **\`loopc new --from-shell "<cmd>" --until "<expr>"\`** scaffolds a loop around a
  command (a lightweight from-script normalizer).
- **M3.7 — Journal tamper-evidence.** Opt-in keyed HMAC chain via \`LOOPY_JOURNAL_KEY\` (the
  same key is required to load/resume); without a key, the default sha256 chain stays
  corruption-evident. A co-located key would be theater, so the key is intentionally external.
- **M9.1 — second adversarial audit (M8/M9 surface).** A focused find→verify audit of the
  ~2,700 new lines surfaced 14 verified bugs (4 rejected) — exactly the class a workspace-green
  suite misses. All fixed with regression tests (201→225):
  - `--vendor` esbuild entry used a CJS `require` resolve against the runtime's import-only
    published exports → ERR_PACKAGE_PATH_NOT_EXPORTED in any packed CLI (the smoke test passed
    spuriously in-workspace). Now `import.meta.resolve` (+ a `default` exports condition); `reprint`
    preserves vendor via `loop.lock` instead of silently de-vendoring.
  - `interpretLoop` (the `loopc run` / `verify` / MCP-run path) never lowered `spec.gates`, so
    human-approval gates that pause the compiled artifact ran straight through. Now lowered
    identically (fail-closed), with a fidelity test.
  - cron→systemd/launchd silently fell back to every-15-min for any day/week cron (192× cadence
    drift) — now faithful translations or a loud warning; cronFromDuration day>31 fixed; the
    GitHub Actions trigger persists `.loopy` (actions/cache) so a scheduled loop advances.
  - cost-meter integrity: the claude-code harness let model-emitted `usage` poison the meter;
    blank `LOOPY_LLM_PRICE_IN/OUT` priced every call at $0; doctor over/under-warned — all fixed.
  - validator cron grammar accepts lists with ranges/steps and range-checks fields; envelope
    headers are normalized to one shape across targets; SSE falls back to JSON when a provider
    ignores `stream:true`; keyless endpoints omit the empty Bearer.
- **M9 — completion backlog (5 deferred features).** Each implemented by a dedicated
  subagent, verified + committed separately (74→201 tests):
  - **HTTP-status envelope** — opt-in `envelope: true` on an http step / on_exit returns
    `{ status, ok, headers, body }` so a loop can branch/terminate on a status (e.g. a 503 from a
    JSON API). Non-breaking (default body-direct unchanged; `envelope` folded into the replay
    identity); wired across runtime/interpreter/standalone/babysitter with a fidelity test.
  - **`loopc run` / `loopc inspect`** — the CLI can now run a loop (validate→createRuntime→run,
    journaling under `--out`) and inspect a run dir, closing the gap with the MCP surface.
  - **Scheduler installer** — recurring `schedule.mode` now emits a `schedule/` dir (crontab,
    systemd service+timer, launchd plist, GitHub Actions) and `loopc schedule install` prints the
    platform-appropriate snippet. Install-only (host fires it) — answers the scheduler-ownership
    decision.
  - **Zero-install artifacts** — `loopc compile --vendor` bundles `@loopy/runtime` (esbuild) into
    a single `runtime.bundle.mjs` and drops the dependency, so the standalone artifact runs with
    plain `node` and empty `node_modules` (proven by a spawn smoke test). Answers the vendor
    decision.
  - **Smaller wins** — opt-in streaming completions; OpenRouter attribution headers +
    `LOOPY_LLM_HEADERS` hook; `llm-judge` gated like `self-assess`; a non-blocking
    `cap-only-termination` warning (transitive-liveness, never misfires on a blueprint);
    breakpoint `strategy` surfaced in the journal/pause instead of silently dropped.
- **M8 — adversarial hardening pass.** A multi-agent audit (find → adversarially verify)
  surfaced 29 confirmed bugs + a ranked completion backlog; all 29 are fixed at the source with
  regression tests (74→169 tests). Highlights:
  - **Security:** an http string `body` bypassed the expression ref-allowlist (`body:
    "${process.env.SECRET}"` compiled to code that POSTed the process env) — now ref-checked like
    url/headers; MCP `run_loop` bound the expr-context `env` to the full `process.env` despite
    scrubbing the shell env, so `${env.SECRET}` exfiltrated server secrets — now both use one
    scrubbed env + an explicit `env` passthrough.
  - **Cost guarantee made real:** the `usd` budget cap was inert for the `llm` harness (only
    tokens were metered). New `pricing.ts` (per-model table + `LOOPY_LLM_PRICE_IN/OUT` overrides,
    provider `usage.cost` preferred) derives `usd`; `doctor` warns when a $ cap is unmeterable;
    model-supplied `usage` can no longer poison the meter. Closes the open "cost accounting
    source" decision.
  - **Budget cap-breakpoint resume:** approving a token/usd/wallclock cap never rebased the
    meter, so every approval re-paused forever — added tokens/usd/wallclock base offsets.
  - **Gate enforcement:** `gates:` was validated but never enforced (the runtime ignored
    `config.gates`; babysitter dropped them) — now lowered to inline `ctx.breakpoint()` in
    standalone + babysitter.
  - **n8n fidelity:** agent/breakpoint/reduce emitted `noOp` and http dropped headers/body — now
    real nodes (httpRequest with headers+body, OpenAI-compat agent, Wait, SplitInBatches with a
    wired body) and a real lowered IF condition.
  - **llm harness:** keyless local endpoints, markdown-fence stripping, a request timeout, and
    `max_completion_tokens` for reasoning models; claude-code now passes `--allowedTools`.
  - **Validation/durability/infer:** `item` outside a reduce, reduce-alias reserved words,
    on_exit completeness, duration overflow, init/default type + cron-syntax checks; per-iteration
    truncation checkpoint, divergent-replay guards for sleep/breakpoint, lock re-acquire on reuse,
    correct runId in meta; bash keyword boundaries, `https.*` detection, a precise secret matcher,
    torn-tail journal tolerance, and correct journal effect-kind mapping.
- **M7 — provider-agnostic LLM (no vendor lock).** Removed the `@anthropic-ai/sdk` dependency
  and the `ANTHROPIC_API_KEY` lock entirely. The runtime now ships a single OpenAI-compatible
  chat client (`chatComplete`) + `resolveLlm` (precedence: explicit `LOOPY_LLM_API_KEY`/
  `_BASE_URL`/`_MODEL` → any auto-detected provider key → null) covering any OpenAI-compatible
  provider via one `/chat/completions` shape. A new built-in **`llm`** agent harness makes
  generated loops' `agent` steps run against *any* provider out of the box (the `internal` no-op
  and pluggable coding-agent CLIs remain — none is a default). The skill-eval author was rewritten
  onto the same client (pure `fetch`, no SDK), and `nightly.yml` uses generic `LOOPY_LLM_*`
  secrets/vars. No single provider is privileged or required. (124 tests.)
- **M6 — from-script / from-trace inference.** New **`@loopy/infer`**: a deterministic
  FactPack extractor (JS/TS via the TypeScript compiler AST; bash heuristics; `.loopy` journal
  round-trip) → candidate pattern + steps + a loop-condition hint + flagged secrets → a **draft**
  LoopSpec. Exposed as `loopc infer-scaffold <file>` and the `infer_loop_scaffold` MCP tool (no
  LLM, no side effects). The `/loopy` skill gained a from-source *step 0* that completes the
  draft through the unchanged validate→verify→score gates, with a **mandatory human spec-diff**
  (verify proves bounded, not semantically faithful). The model-driven *inference of intent*
  stays in the skill; the extractor is the deterministic, testable substrate.
- **M5 — `/loopy` depth + skill-eval.** Deepened the skill into a judgment layer (the
  conversational protocol for eliciting termination signal / caps / state / pattern; the
  reachability proof verify can't do; a pattern→signal table; worked NL→spec examples;
  scorecard math; anti-patterns). Added a **skill-eval** in \`@loopy/evals\`: 8 NL fixtures →
  authored spec → graded by the real \`validate/verify/score\` + pattern-match + signal-tier
  thresholds. The grader is gated per-PR (golden specs); **live LLM authoring runs nightly**
  (\`pnpm eval:skill\` + nightly.yml; provider-agnostic since M7 — any \`LOOPY_LLM_*\`/provider key)
  so model flakiness/cost never blocks a PR.
- **M4 — Coverage + eval harness (trust substrate).** Fixed the agent save-envelope trap at
  the source (claude-code harness unwraps \`.result\`); made the CLI importable+tested; added the
  interpreter≡generated-code **fidelity** test (the load-bearing M2 claim); broadened expr,
  validator-negative, runtime, and MCP-security coverage (74→114 tests). New **\`@loopy/evals\`**
  (\`pnpm eval\`): a property-based pipeline (40 fuzzed valid specs → validate→verify→compile→
  \`node --check\`→round-trip→determinism), capability-matrix honesty, and a validator negative
  corpus — all graded by the real code. CI (\`.github/workflows/ci.yml\`) gates typecheck + tests
  + evals + build on every PR.
- **Remaining (LLM-side / N/A).** Richer from-script/from-trace *inference* belongs to the
  \`/loopy\` authoring skill (it needs a model, not deterministic codegen). reprint-with-context
  carry-forward is N/A by design (the LoopSpec is canonical; artifacts are not hand-edited).
  Offloading codegen to an external coding agent is N/A — our codegen is deterministic. The
  deterministic factory backlog is essentially complete.

## 8. Open product decisions (carried forward)

1. **Two engines or one canonical?** `@loopy/runtime` is canonical; babysitter is a
   first-class richer target. Confirm positioning in docs.
2. **Vendor vs depend.** RESOLVED in M9: BOTH are offered. Default standalone depends on
   `@loopy/runtime` (small install); `loopc compile --vendor` bundles the runtime into the
   artifact (esbuild → `runtime.bundle.mjs`) for a true zero-install loop. The skew tradeoff is
   the user's per-compile choice.
3. **Weak-signal policy.** Current stance: `self-assess` hard-requires explicit caps;
   `llm-judge`/`self-assess` warn + downgrade. Confirm.
4. **Default cap values.** Per-pattern defaults are set conservatively
   ([`normalize.ts`](packages/core/src/normalize.ts)); tune to real risk tolerance.
5. **Cost accounting source.** RESOLVED in M8: a per-model pricing table
   ([`pricing.ts`](packages/runtime/src/pricing.ts)) with `LOOPY_LLM_PRICE_IN/OUT` overrides and
   a preference for provider-reported `usage.cost`. `doctor` warns when a $ cap is unmeterable.
6. **Scheduling/lifetime ownership.** RESOLVED in M9: stay artifact-only but emit
   ready-to-install triggers. A recurring `schedule.mode` produces a `schedule/` dir (crontab,
   systemd, launchd, GitHub Actions); `loopc schedule install` prints the platform snippet. The
   host fires it (no daemon ships).
7. **Licensing/attribution with `a5c-ai/babysitter`** for the distilled runtime + adapter.
