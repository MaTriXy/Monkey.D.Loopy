# Monkey D Loopy

**A factory for runnable, crash-resumable agent loops.**

Describe a loop once in a declarative **LoopSpec**; compile it to something that actually runs —
journaling every step, resuming after a crash, and stopping when it should. You bring the agent
and the model; Loopy handles the hard parts.

https://github.com/user-attachments/assets/58e23cc9-7d6f-47cd-9314-d1855b6eec13

> **The load-bearing rule:** the compiler will not emit an unbounded loop. Every loop must
> declare a termination signal and carries mandatory caps — iterations, a no-progress
> fingerprint, and a token/$/wallclock budget. The validator rejects anything that could run
> forever.

## Why

Hand-rolled agent loops fail in predictable ways: no termination criteria, context blow-up,
unbounded cost, no resumability, no observability, goal drift, weak self-judging. A *factory*
prevents these **structurally**. You describe the loop; Loopy emits something that runs
standalone *or* plugs into your harness, journals every step, resumes after a crash, and stops
when it should — so the failure modes are designed out instead of debugged later.

## What's inside

- **A declarative LoopSpec.** Express the loop — state, steps, termination, caps — as data.
  Never hand-write loop control flow again; produce a spec and let the factory emit the artifact.
- **A bounded-loop guarantee.** Termination is *required* and caps are *mandatory*; the two-tier
  validator refuses unbounded or unreachable loops before anything runs.
- **Verify before you run.** A codegen-free interpreter dry-runs the loop with mocked effects
  (no side effects) and proves it's **bounded · deterministic · resume-stable**, then a 0–100
  scorecard grades termination strength, caps, observability, and resumability.
- **A durable runtime.** Event-sourced journal with a chained checksum, deterministic replay,
  write-ahead **idempotent effects**, **durable sleep** (park the run and resume past the wake
  time), human **breakpoints**, and **real USD cost metering** against the budget cap. Crash →
  resume from the journal, at-most-once for completed effects.
- **Provider- *and* tool-agnostic.** Run `agent` steps on **any** LLM provider and **any** coding
  agent — no vendor lock, no default. (See [No vendor lock](#no-vendor-lock).)
- **Multiple compile targets.** One spec → a standalone Node project, a durable supervised
  process, a coding-agent execution guide, or a workflow. (See [Compile targets](#compile-targets).)
- **Start from what you have.** Point the inferencer at an existing bash/JS/TS script or a
  `.loopy` run journal to get a draft spec to refine.
- **Authoring help built in.** The [`/loopy`](.claude/skills/loopy/SKILL.md) skill turns a
  natural-language goal into a validated, verified, graded spec; the `loopc-mcp` server exposes
  the whole factory to agents as MCP tools.
- **Zero-install artifacts.** `compile --vendor` bundles the runtime so a compiled loop runs with
  plain `node` — nothing to install.

## Quickstart

```bash
pnpm install                                       # Node ≥ 22, pnpm
loopc() { pnpm exec tsx packages/cli/src/index.ts "$@"; }   # convenience alias

loopc blueprints                                   # list starting points (one per pattern)
loopc new my-watch --blueprint poll-until          # scaffold a LoopSpec
loopc validate examples/deploy-watch.yaml          # rejects unbounded / unreachable loops
loopc verify   examples/deploy-watch.yaml          # dry-run: bounded + deterministic, no side effects
loopc score    examples/deploy-watch.yaml          # graded 0–100 scorecard
loopc compile  examples/deploy-watch.yaml --target all --out ./out/deploy-watch

cd out/deploy-watch/standalone && npm install
node loop.mjs run        # run · step · resume · doctor   (journals to .loopy/, crash-resumable)
```

## A LoopSpec at a glance

```yaml
loopspec: "0.1"
id: deploy-watch
pattern: poll-until
inputs: { status_url: { type: string, required: true } }
state:
  vars: { status: { type: "enum[pending,green,red]", init: pending }, attempt: { type: int, init: 0 } }
body:
  - { id: check,  kind: http,  request: { method: GET, url: "${inputs.status_url}" }, save: { status: "$.state" } }
  - { id: triage, when: "${state.status == 'red'}", kind: agent, harness: cli,  # any coding agent via LOOPY_AGENT_CMD
      prompt: "Deploy failed (attempt ${state.attempt}). Diagnose and push a minimal fix.", on_done: { incr: attempt } }
  - { id: wait,   when: "${state.status == 'pending'}", kind: sleep, for: 5m }
terminate: { signal: state-predicate, until: "${state.status == 'green'}" }   # required
caps: { max_iterations: 288, no_progress: { fingerprint: "${state.status}", max_repeats: 12 },
        budget: { tokens: 200000, usd: 5.0, wallclock: "24h" }, on_cap_exceeded: breakpoint }  # mandatory
schedule: { mode: forever }
```

## Compile targets

One spec, `compile --target all`, four runnable forms:

| Target | What it emits |
|---|---|
| **standalone** | A self-contained Node project running on `@loopy/runtime` — the durable engine (journal, replay, caps, sleep, breakpoints). Add `--vendor` for a zero-install bundle. |
| **supervised process** | A durable long-running process for a process-supervisor runtime. |
| **coding-agent guide** | A prose execution guide any coding agent follows step by step. |
| **workflow** | An importable workflow JSON for a visual automation tool. |

## No vendor lock

Agent steps are **provider- and tool-agnostic** — choose at runtime, nothing is hardcoded.

- **Any LLM provider.** The built-in `llm` harness is an OpenAI-compatible client that talks to
  any compatible provider — cloud or fully local. It auto-detects whatever provider key you have,
  or point it with `LOOPY_LLM_*`. Cost is metered per call against the `usd` budget cap.
- **Any coding agent.** For a full file-editing, tool-running harness, drive **any** coding-agent
  CLI with your exact flags via `LOOPY_AGENT_CMD`. No harness is the default — pick the tool you
  run; nothing is hardcoded.

## Packages

| Package | Role |
|---|---|
| [`@loopy/core`](packages/core) | Pure, zero-I/O brain: the LoopSpec IR, expression engine, two-tier validator, planner + target adapters, blueprint catalog. |
| [`@loopy/runtime`](packages/runtime) | Durable execution engine the standalone artifact runs on (journal, replay, caps, sleep, breakpoints, cost metering). |
| [`@loopy/verify`](packages/verify) | Dry-run verification (bounded + deterministic + resume-stable) + scorecard, via a codegen-free interpreter. |
| [`@loopy/cli`](packages/cli) | `loopc` — `new · validate · verify · score · compile · run · inspect · schedule · reprint · targets · infer-scaffold · blueprints`. |
| [`@loopy/mcp`](packages/mcp) | `loopc-mcp` — the factory as MCP tools for agents. |
| [`@loopy/evals`](packages/evals) | Eval harness graded by the real code: property-based pipeline, capability honesty, validator corpus. `pnpm eval`. |
| [`@loopy/infer`](packages/infer) | Deterministic FactPack extraction from scripts (JS/TS AST, bash) + `.loopy` journals → a draft LoopSpec for the skill to complete. |

## Zero-install artifacts (`compile --vendor`)

A normal `standalone` artifact `import`s `@loopy/runtime`, so it needs `npm install`. For a
**truly self-contained** loop, compile the standalone target with `--vendor`:

```bash
loopc compile examples/deploy-watch.yaml --target standalone --vendor --out ./out/deploy-watch
cd out/deploy-watch/standalone
node loop.mjs run        # no npm install, empty node_modules — just runs
```

`--vendor` bundles `@loopy/runtime` (with esbuild) into a single local `runtime.bundle.mjs`,
points `loop.mjs` at it, and drops the dependency from the emitted `package.json`. The artifact
runs with **plain `node` on any machine with Node ≥ 22** — no install, nothing from this monorepo.

## Docs

- [LoopSpec reference](docs/loopspec.md) — the IR, step kinds, expression language, validation rules.
- [`loopc` CLI](docs/cli.md) — every command and flag.
- [`@loopy/runtime`](docs/runtime.md) — runtime API, journal format, resume semantics, guarantees.
- [`loopc-mcp`](docs/mcp.md) — MCP tools and how to register the server.
- [SPEC.md](SPEC.md) — full design and tracked decisions.
- The [`/loopy`](.claude/skills/loopy/SKILL.md) skill — the authoring judgment layer over `loopc`.

## Develop

Dev runs from source via `tsx` (no build needed):

```bash
pnpm -r typecheck     # tsc across packages
pnpm -r test          # vitest (unit · golden codegen · security · runtime · verify · mcp · evals)
pnpm eval             # property-based + capability + negative evals (graded by the real code)
pnpm eval:skill       # NL→spec authoring quality (live with any provider key, else golden)
pnpm build            # tsup → dist/ for every package (ESM + .d.ts; bins get a node shebang)
```

Each package publishes its compiled `dist` (via `publishConfig`), so installed consumers run the
`loopc` / `loopc-mcp` bins and the generated artifacts with **plain `node`** — no `tsx` required.
CI runs typecheck + tests + `pnpm eval` + build on every PR; the live skill-eval runs nightly.
