---
name: loopy
description: Author, verify, and compile a runnable agent loop with Monkey D Loopy. Use when the user wants to build a "loop" / recurring or repeating agent task as a runnable artifact — e.g. "make a loop that polls X until Y", "keep retrying until tests pass", "watch the deploy and fix it", "process each item until done". Turns a natural-language goal into a validated, verified, graded, compiled LoopSpec.
---

# Authoring a loop with Monkey D Loopy

You are the **judgment layer** over the deterministic `loopc` factory. Your job: turn the
user's goal into a `LoopSpec` that **passes validation, verifies as bounded + deterministic,
and scores well**, then compile it. Never hand-write loop control flow — produce a spec and
let the factory emit the runnable artifact.

CLI (from the repo): `pnpm exec tsx packages/cli/src/index.ts <cmd>` — shown as `loopc <cmd>` below.
If the `loopc-mcp` server is connected, the equivalent tools are `get_loop_schema`,
`list_blueprints`, `new_loop`, `validate_loop`, `verify_loop`, `compile_loop`, `run_loop`,
`inspect_run`.

## From an existing script or trace (optional step 0)

If the user has a script (bash / JS / TS) or a run trace / `.loopy` journal, start from a
FactPack instead of a blank page:

1. `loopc infer-scaffold <file>` (or the `infer_loop_scaffold` MCP tool) → a **draft** LoopSpec
   + flagged secrets + a loop-condition hint. It is **deterministic** — it extracts structure,
   it does not infer intent, and the draft is **not guaranteed valid**.
2. Complete the TODOs: map the loop-condition hint to a real `state` signal **and the step that
   writes it**; fill `url`/`prompt` placeholders; choose the strongest termination signal; move
   any flagged secrets to `inputs` (never inline them).
3. Then run the normal Workflow below (validate → verify → score → compile).

**MANDATORY when inferring:** show the user the final spec and a short diff of *intent vs the
source*, and get confirmation. `verify` proves the loop is **bounded**, not that it faithfully
reproduces the original — a fabricated-but-reachable terminator passes verify yet is wrong.
Human review is the only check for semantic fidelity.

## Workflow

1. **Read the schema first.** Run `loopc blueprints` and read the LoopSpec guide
   (`get_loop_schema`, or `docs/loopspec.md`). Do not guess field names.
2. **Pick the pattern.** Match the goal to a pattern and scaffold from the closest blueprint:
   `loopc new <id> --blueprint <name>` (react · plan-execute-reflect · evaluator-optimizer ·
   loop-until-dry · map-reduce · poll-until · cron).
3. **Draft the spec**, honoring the non-negotiables (the validator enforces these):
   - `terminate` is **required**. Choose the **strongest available exit signal**:
     `oracle` (tests/compiler/schema) > `state-predicate` (queue empty / status==green) >
     `llm-judge` (rubric) > `self-assess`. Prefer an objective signal.
   - The predicate must read a signal a step actually **writes** (or `iteration`), or it can
     never terminate.
   - Set **explicit `caps`** to the user's real cost tolerance (don't rely on the auto-injected
     defaults). For poll/loop-until-dry, add a `no_progress` fingerprint to catch thrash.
   - Capture what the loop needs to reason about into `state`, written via step `save` /
     `on_done`. Every binding referenced in an expression must be declared.
   - Delegate the actual work to `agent` steps (the harness owns the inner ReAct turn); use
     `shell`/`http` for tools, `sleep` for polling, `breakpoint`/`gates` for human approval.
4. **Validate:** `loopc validate <spec>` — fix every error before continuing.
5. **Verify:** `loopc verify <spec>` — it dry-runs with mocked effects (no side effects) and
   must report **bounded ✓ deterministic ✓ resume-stable ✓**. If it "did not reach completed
   under empty mocks", confirm a real exit signal exists (that's expected for poll-style loops).
6. **Score:** `loopc score <spec>` — aim high. Strengthen the termination signal, add
   `no_progress`/budget, and keep `observe.trace: journal` to raise the grade. (Over MCP
   there is no separate score tool — the scorecard is included in `verify_loop`'s output.)
7. **Compile:** `loopc compile <spec> --target all --out <dir>` (or `standalone` only). Heed
   any capability warnings on the babysitter target (e.g. soft budget enforcement, http→curl).
8. **Run / inspect** the standalone artifact: `node loop.mjs run` (or `step`/`resume`/`doctor`);
   the journal lives in `.loopy/runs/`. It is crash-resumable.

## From conversation to spec — elicit the four unknowns

A loop is pinned down by four things. Extract them from the user's words; only **ask** when a
load-bearing one is genuinely missing (batch ≤3 questions, in this priority order):

1. **Termination signal** — *how will we know it's done?* The single most important unknown.
   Push for the strongest objective signal (see the table). If the user only offers "when it
   looks good," that's `self-assess` — flag it and ask for an oracle (a test, a status field).
2. **Caps / budget** — *how long/expensive may it run?* Get iterations or a time/$/token ceiling.
   If they don't care, pick a sane bound and say so.
3. **State** — *what does each turn need to remember?* (counters, last status, accumulated results.)
4. **Pattern** — usually inferable from the desire; **confirm, don't ask**.

Also probe: required **inputs**, and **side-effect tolerance** — if any step is destructive or
irreversible, put a `breakpoint`/`gate` before it.

**When NOT to ask:** if the desire already implies an objective oracle and a natural bound
(e.g. "retry the build until tests pass, max 10 times"), just draft the spec, show it, and ask
for a veto. Default the rest; don't interrogate.

## Pattern → termination-signal table

| Desire shape | pattern | strongest signal |
|---|---|---|
| "do X until it's right / passes" | `react` or `evaluator-optimizer` | oracle (tests) > llm-judge (rubric) |
| "plan then execute step by step until done" | `plan-execute-reflect` | state-predicate / self-assess |
| "keep finding/fixing until nothing's left" | `loop-until-dry` | state-predicate (count==0) + `no_progress` |
| "watch/poll X until it reaches Y" | `poll-until` | state-predicate (status==Y) + `no_progress` |
| "do this to each item" | `map-reduce` | state-predicate (done flag) |
| "run this on a schedule" | `cron` | state-predicate (one-shot sent flag) |

## The reachability proof (verify cannot do this for you)

`verify` mocks every effect to `{}` and counts a cap-stop as "bounded" — so a green verify only
proves the loop **can't run forever**, not that it can ever *succeed*. After verify, do this
proof yourself and state it to the user:

1. Name the **step** that writes the var your `until` reads (its `save`/`on_done`).
2. Name a **real effect value** that would make `until` true (e.g. "when the status endpoint
   returns `{state:'green'}`, `state.status=='green'` holds").

If you can't name both, the exit is not genuinely reachable — fix the state/steps. If verify
says *"did not reach completed under empty mocks"*, that's normal for poll/oracle loops (they
need a real value); the reachability proof is what covers it.

## Reading effect results into state (`save`)

`save: { <stateVar>: "<json-path>" }` extracts from the step's result. The result shape
differs by step kind — get this right or the exit var silently stays unset:

- **agent**: the harness returns the **model's own output**. If the model returns JSON, address
  fields directly (`"$.score"`); if it returns text, it's at `"$.result"`. (The claude-code
  harness auto-unwraps its envelope, so don't write `"$.result.score"`.) Prompt the model to
  emit JSON when you need to `save` a field.
  - **Harness choice is provider- AND tool-agnostic — never assume a specific vendor.**
    `harness: llm` is the portable default: an OpenAI-compatible client against any provider
    (cloud or local), configured by env. For a full **coding agent** (edits files, runs tools)
    pick whichever CLI the user runs — the coding-agent harnesses (see the schema for the enum)
    are all first-class peers, or `cli` drives any tool via `LOOPY_AGENT_CMD`. `internal` is the
    deterministic no-op for tests. Don't default to any one tool or hardcode a vendor/key — match
    the user's tool and leave provider/tool selection to the runtime env.
- **http**: the parsed response **body** (`"$.state"`, `"$.items[0].id"`).
- **shell**: parsed stdout JSON (`"$.count"`), or `{ stdout, code }` when stdout isn't JSON.

## Fixing validation / verify diagnostics

| code | cause | fix |
|---|---|---|
| `no-terminate` | no `terminate` block | add `terminate: { signal, until }` |
| `unreachable-exit` | `until` reads a var no step writes (or a constant) | make a step `save`/`on_done` the var the predicate reads (or use `iteration`) |
| `bad-binding` | `save`/`on_done` targets an undeclared/wrong-type var | declare it in `state.vars` (numeric for `incr`, `list` for `append`) |
| `bad-ref` | expression references an undeclared `state`/`inputs` name | declare it, or fix the name |
| `weak-signal` (error) | `self-assess` with auto-injected caps | add an explicit `caps` block |
| `sleep-shape` | sleep has both/neither `for` and `until` | set exactly one |
| `cron-missing` | `schedule.mode: cron` without `cron` | add the cron expression |
| verify `not bounded` | the loop crashes or never stops under mocks | usually a bad ref/reduce; read the issue and fix |
| verify `did not reach completed` | (info) needs real effect values to exit | do the reachability proof — confirm a real result satisfies `until` |

## Worked examples (sentence → the load-bearing fields)

- **"retry the build until tests pass, up to 10x"** → `react`, signal `oracle`. State `passed:boolean`.
  A `shell` step runs the tests and `save`s `passed` from the exit/JSON; `terminate.until:
  "${state.passed == true}"`; `caps.max_iterations: 10`. Exit reachable: the test command's
  result sets `passed`.
- **"watch the deploy; if it's red, fix it; stop when green"** → `poll-until`, signal
  `state-predicate`. `http` check `save`s `status`; an `agent` step (guarded `when: red`) fixes;
  a `sleep` between checks; `until: "${state.status == 'green'}"`; `no_progress` on `status`;
  a `gate` after N failed fixes.
- **"grade the draft against a rubric and refine until it's an A"** → `evaluator-optimizer`,
  signal `llm-judge`. An `agent` improves; an `agent` evaluator returns JSON and `save`s
  `score`; `until: "${state.score >= 0.9}"`; cap iterations (judge loops can be unsatisfiable).
- **"summarize each file in this list"** → `map-reduce`. `reduce over: "${inputs.files}"`;
  body `agent` summarize + `on_done.append` into a `list`; a finalize step sets `done`.

## Raising the score (the math)

`score` = termination 30 + caps 25 + observability 15 + resumability 15 + determinism 15.
- **termination (30)**: by tier — oracle 1.0 · state-predicate 0.85 · llm-judge 0.55 · self-assess 0.35.
  Choosing an oracle over self-assess is +20 points.
- **caps (25)**: explicit caps 0.5 + `no_progress` 0.25 + `budget` 0.25. Set all three.
- **observability (15)**: `observe.trace: journal` 0.7 + `hooks`/`notify` 0.3.
- **resumability / determinism (15 each)**: earned by passing verify (keep effects pure).

Map each lost point to its fix; don't ship a C if a stronger signal or a fingerprint gets an A.

## Anti-patterns (warn against)

- A `terminate` that reads a var no step writes, or a constant — it never ends (validator catches it).
- `self-assess` ("until the model says done") when an objective oracle exists — weak + low score.
- A `no_progress.fingerprint` that's a constant or contains `iteration` — it never detects thrash.
- Writing `"$.result.x"` for an agent `save` — the harness already unwrapped `.result`; use `"$.x"`.
- Relying on auto-injected caps instead of setting cost limits the user actually wants.
- Destructive steps with no `gate`/`breakpoint` in front of them.

## Rules of thumb

- Reach for the **least-powerful loop** that meets the need; escalate explicitly.
- An objective oracle in `terminate` beats a judged rubric beats self-assessment.
- If you can't make the exit reachable, the loop is wrong — rethink the state/steps.
- Show the user the spec, the verify result + reachability proof, and the score before compiling.
