<h1 align="center">
  <img src="docs/public/images/monkey-d-loopy-logo-512.png" alt="Monkey D Loopy logo" width="512" />
</h1>

**A factory for runnable, crash-resumable agent loops.**

[Documentation](https://matrixy.github.io/Monkey.D.Loopy/) ·
[First loop](https://matrixy.github.io/Monkey.D.Loopy/quickstart) ·
[Agent guide](https://matrixy.github.io/Monkey.D.Loopy/agent-guide) ·
[`llms.txt`](https://matrixy.github.io/Monkey.D.Loopy/llms.txt) ·
[GitHub](https://github.com/MaTriXy/Monkey.D.Loopy)

Describe a loop once in a declarative **LoopSpec**; compile it to something that actually runs —
journaling every step, resuming after a crash, and stopping when it should. You bring the agent
and the model; Loopy handles the hard parts.

https://github.com/user-attachments/assets/ad1b2379-f545-4257-9abc-b2f727b11526

> **The load-bearing rule:** the compiler will not emit an unbounded loop. Every loop must
> declare a termination signal and carries mandatory caps — iterations, a no-progress
> fingerprint, and a token/$/wallclock budget. The validator rejects anything that could run
> forever.

## Why

Hand-rolled agent loops fail in predictable ways: no termination criteria, context blow-up,
unbounded cost, no resumability, no observability, goal drift, weak self-judging. A *factory*
prevents most of these **structurally** — and the one it can't design out (a model grading its
own work) it **measures and prices**: the validator traces who actually feeds every exit
predicate, and the scorecard caps any loop whose "done" signal is only the agent's own report.
You describe the loop; Loopy emits something that runs standalone *or* plugs into your harness,
journals every step, resumes after a crash, and stops when it should — so the failure modes are
designed out or made visible instead of debugged later.

## What's inside

- **A declarative LoopSpec.** Express the loop — state, steps, termination, caps — as data.
  Never hand-write loop control flow again; produce a spec and let the factory emit the artifact.
- **A bounded-loop guarantee.** Termination is *required* and caps are *mandatory*; the two-tier
  validator refuses unbounded or unreachable loops before anything runs.
- **Verify before you run.** A codegen-free interpreter dry-runs the loop with mocked effects
  (no side effects) and proves it's **bounded · deterministic · resume-stable**, then a 0–100
  scorecard grades termination strength, caps, observability, and resumability — including
  **termination grounding**: whether real evidence (a shell exit code, an http status) decides
  when the loop stops, or just the agent's own claim. (See [Prove it before you run it](#prove-it-before-you-run-it).)
- **A durable runtime.** Event-sourced journal with a chained checksum, deterministic replay,
  write-ahead **idempotent effects**, **durable sleep** (park the run and resume past the wake
  time), human **breakpoints**, and **real USD cost metering** against the budget cap. Crash →
  resume from the journal, at-most-once for completed effects.
- **Provider- *and* tool-agnostic.** Run `agent` steps on **any** LLM provider and **any** coding
  agent — no vendor lock, no default. (See [No vendor lock](#no-vendor-lock).)
- **Multiple compile targets.** One spec → a standalone Node project, a durable supervised
  process, a coding-agent execution guide, a Claude Code-native slash skill, or a workflow.
  (See [Compile targets](#compile-targets).)
- **Start from what you have.** Point the inferencer at an existing bash/JS/TS script or a
  `.loopy` run journal to get a draft spec to refine.
- **Start from an outcome.** Six verified recipes cover repository health, dependency policy,
  documentation drift, production errors, release follow-up, and market signals. Each ships
  with external-grounding guidance, safety boundaries, and adversarial runtime fixtures.
- **Authoring help built in.** The [`/loopy`](.claude/skills/loopy/SKILL.md) skill turns a
  natural-language goal into a validated, verified, graded spec; the `loopc-mcp` server exposes
  the whole factory to agents as MCP tools.
- **Zero-install artifacts.** `compile --vendor` bundles the runtime so a compiled loop runs with
  plain `node` — nothing to install.
- **Optional local operations.** `@loopyc/operator` adds a secured loopback control center,
  explicit single-authority scheduling, guarded runtime controls, bounded artifact indexing, and
  idempotent generic webhooks. Guarded evolution evaluates isolated LoopSpec candidates against
  deterministic regression gates, then requires a reasoned human activation with byte-exact
  rollback. Journals and standalone/vendored artifacts remain independent.

## Quickstart

```bash
npx --yes @loopyc/cli@latest quickstart            # Node ≥ 22
```

That one safe command validates and scores an honest **100/100** starter LoopSpec, runs it to
completion, records its completion observer, inspects its durable journal, and emits a zero-install
standalone artifact under `./loopy-quickstart/`. Deterministic verification fixtures model the same
structured shell evidence without executing side effects during proof. It needs no model, API key,
or external service and refuses to overwrite a non-empty directory.

When you are ready to author real work:

```bash
npm i -g @loopyc/cli

loopc blueprints                                   # list starting points (one per pattern)
loopc new my-watch --blueprint poll-until          # scaffold a LoopSpec
loopc validate my-watch.loop.yaml                  # rejects unbounded / unreachable loops
loopc verify   my-watch.loop.yaml                  # dry-run: bounded + deterministic, no side effects
loopc score    my-watch.loop.yaml                  # graded 0–100 scorecard
loopc compile  my-watch.loop.yaml --target all --out ./out/my-watch
```

The poller requires a `status_url` input before execution; inspect the generated `inputs:` block
and pass an `inputs.json` file to `loopc run`. See the
[first-loop guide](https://matrixy.github.io/Monkey.D.Loopy/quickstart) for the complete clean-room
journey.

Claude Code users also get a native project skill from `--target all`: copy
`out/my-watch/claude-native/.claude/` into the project where the loop should be available, then
invoke it as `/my-watch run` from Claude Code.

The local operator is deliberately optional and installs separately:

```bash
npm i -g @loopyc/operator
loopyd --help
```

It imports compiled artifacts for local scheduling and inspection; installing it does not start a
service or make standalone/vendored artifacts depend on the operator.

(Working from a clone instead? See [Develop](#develop) — everything runs from source via `tsx`.)

Prefer an opinionated product workflow over a structural blueprint? This path is ready in under
five minutes and preserves recipe provenance in every generated `loop.lock`:

```bash
loopc recipes
loopc new repo-check --recipe repo-health-doctor
loopc verify repo-check.loop.yaml
loopc compile repo-check.loop.yaml --target standalone --out ./out/repo-check
```

Set the generated `check_command` input to a repository-owned command that emits structured,
redacted status/evidence JSON. See the [verified recipe guide](docs/recipes.md) and each recipe's
README for its exact evidence and safety contract.

## Prove it before you run it

The differentiator in one command. `loopc verify` executes your loop through the real runtime
with **mocked effects** — no network, no shell, no model calls — restarting the process between
every iteration to prove resume actually works. Then `loopc score` grades what the dry-run
proved:

```
✓ verify PASSED
  bounded: ✓  deterministic: ✓  resume-stable: ✓

Scorecard: 100/100  (A)
  ██████████ termination safety   30/30  — signal: oracle · grounding: external
  ██████████ caps                 25/25  — explicit, no_progress, budget
  ██████████ observability        15/15  — trace: journal · observer: completed hook
  ██████████ resumability         15/15  — stable
  ██████████ determinism          15/15  — deterministic
```

**Grounding is checked, not trusted.** The factory traces which steps write the state your
exit predicate reads. `grounding: external` means an http/shell fact decides when the loop
stops; `grounding: agent` means the model grades its own work — and the score is capped
accordingly, no matter what the signal label claims. Relabeling a judge as a `state-predicate`
makes the score go *down*, not up.

When a dry-run needs representative effect data, pass a data-only JSON fixture file with
`--fixtures`. Verification returns those values from mocked shell/http/agent effects; it never
executes the real effect. The quickstart emits its fixture alongside the spec so its 100-point
claim is reproducible and inspectable.

## Examples

One runnable spec per pattern in [`examples/`](examples/README.md) — fix-tests-until-green,
API migration, doc-link sweep, deploy watch, issue triage, nightly digest, judged release
notes. Each passes validate + verify, with its score and grounding in the
[gallery table](examples/README.md).

For complete product workflows, browse the [verified recipe catalog](recipes/README.md).

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

One spec, `compile --target all`, five runnable forms:

| Target | What it emits |
|---|---|
| **`standalone`** | A self-contained Node project running on `@loopyc/runtime` — the durable engine (journal, replay, caps, sleep, breakpoints). Add `--vendor` for a zero-install bundle. |
| **`babysitter`** | A durable long-running process for the Babysitter process-supervisor runtime. |
| **`claude-code`** | A prose execution guide a coding agent follows step by step. |
| **`claude-native`** | A Claude Code project skill under `.claude/skills/<loop>/SKILL.md`, invokable as `/<loop>`, with a hybrid handoff to standalone when available. |
| **`n8n`** | An importable n8n workflow JSON for visual automation. |

## Claude Code-native skills

The `claude-native` target emits a Claude Code project skill:

```text
.claude/skills/<loop>/SKILL.md
.claude/skills/<loop>/reference/loopspec.json
.claude/skills/<loop>/scripts/run-standalone.mjs
```

Install it by copying the generated `.claude/` directory into the target repository. Claude Code
discovers project skills from `.claude/skills/<skill-name>/SKILL.md`, and the skill directory
becomes the slash command name, so a `deploy-watch` loop runs as:

```text
/deploy-watch run '{"status_url":"https://example.com/status"}'
/deploy-watch step
/deploy-watch inspect
```

This target is intentionally hybrid. When a sibling `standalone` artifact exists, the skill
hands off to `node loop.mjs` so the Loopy runtime enforces journals, replay, caps, durable sleep,
breakpoints, and budget behavior. Without standalone, Claude can still execute from the embedded
LoopSpec contract, but those guarantees are Claude-honored rather than runtime-enforced; the
compiler prints that boundary as capability warnings.

## Why not a workflow engine?

Temporal, Inngest, and Restate give you durable execution; LangGraph gives you agent graphs.
Loopy overlaps with neither's core bet:

- **Bounded by construction, not by discipline.** Engines will happily run a workflow forever;
  that's a feature. Loopy's compiler *refuses to emit* a loop without a termination signal and
  caps, and `verify` proves boundedness before the first real side effect. No framework we know
  of makes unboundedness unrepresentable.
- **A compiled artifact, not hosted infra.** The output is a self-contained Node project (or a
  prose guide, or a workflow JSON) that journals to a local `.loopy/` directory and runs with
  plain `node`. No cluster, no service, no account — you can `scp` a compiled loop to a box.
- **Agent-native semantics.** Termination-signal trust tiers (oracle > state-predicate >
  llm-judge > self-assess), grounding analysis, token/USD budget caps metered against real
  usage, and no-progress fingerprints are loop-safety concepts for *agents*, not generic retry
  policies.
- **Declarative data, not framework code.** A LoopSpec is one YAML document — diffable,
  lintable, generatable by an LLM, and portable across five compile targets. There is no SDK
  your loop logic has to marry.

If you need fan-out across a fleet, multi-service orchestration, or exactly-once across
distributed workers, use a workflow engine — that's their home turf. If you need one agent
loop that provably stops, survives crashes, and can't blow your budget, that's this.

## No vendor lock

Agent steps are **provider- and tool-agnostic** — choose at runtime, nothing is hardcoded.

- **Any LLM provider.** The built-in `llm` harness is an OpenAI-compatible client that talks to
  any compatible provider — cloud or fully local. It auto-detects whatever provider key you have,
  or point it with `LOOPY_LLM_*`. Cost is metered per call against the `usd` budget cap.
- **Any coding agent.** For a full file-editing, tool-running harness, drive **any** coding-agent
  CLI with your exact flags via `LOOPY_AGENT_CMD`. No harness is the default — pick the tool you
  run; nothing is hardcoded. Named harnesses include Claude Code, Codex, OpenCode, Antigravity,
  Cursor Agent, and `pi`; pi's JSON event stream contributes trusted token and cost usage.
- **Explicit agent limits.** Configure built-in harnesses with `LOOPY_AGENT_TIMEOUT_MS` and
  `LOOPY_AGENT_MAX_BUFFER`. `doctor` reports the effective values, and a tripped limit names the
  exact control instead of looking like a generic tool failure.

## Packages

| Package | Role |
|---|---|
| [`@loopyc/core`](packages/core) | Pure, zero-I/O brain: the LoopSpec IR, expression engine, two-tier validator, planner + target adapters, blueprint catalog. |
| [`@loopyc/runtime`](packages/runtime) | Durable execution engine the standalone artifact runs on (journal, replay, caps, sleep, breakpoints, cost metering). |
| [`@loopyc/verify`](packages/verify) | Dry-run verification (bounded + deterministic + resume-stable) + scorecard, via a codegen-free interpreter. |
| [`@loopyc/cli`](packages/cli) | `loopc` — `new · validate · verify · score · compile · run · inspect · schedule · reprint · targets · infer-scaffold · blueprints`. |
| [`@loopyc/mcp`](packages/mcp) | `loopc-mcp` — the factory as MCP tools for agents. |
| [`@loopyc/evals`](packages/evals) | Eval harness graded by the real code: property-based pipeline, capability honesty, validator corpus. `pnpm eval`. |
| [`@loopyc/infer`](packages/infer) | Deterministic FactPack extraction from scripts (JS/TS AST, bash) + `.loopy` journals → a draft LoopSpec for the skill to complete. |

## Zero-install artifacts (`compile --vendor`)

A normal `standalone` artifact `import`s `@loopyc/runtime`, so it needs `npm install`. For a
**truly self-contained** loop, compile the standalone target with `--vendor`:

```bash
loopc compile examples/deploy-watch.yaml --target standalone --vendor --out ./out/deploy-watch
cd out/deploy-watch/standalone
node loop.mjs run        # no npm install, empty node_modules — just runs
```

`--vendor` bundles `@loopyc/runtime` (with esbuild) into a single local `runtime.bundle.mjs`,
points `loop.mjs` at it, and drops the dependency from the emitted `package.json`. The artifact
runs with **plain `node` on any machine with Node ≥ 22** — no install, nothing from this monorepo.

## Docs

- [Documentation website](https://matrixy.github.io/Monkey.D.Loopy/) — guides, references, and
  operator-platform material in a searchable reading experience.
- [Using Loopy with agents](docs/agent-guide.md) — the recommended agent workflow, MCP setup,
  context endpoints, and the guarantees an agent must preserve.
- [`llms.txt`](https://matrixy.github.io/Monkey.D.Loopy/llms.txt) and
  [`llms-full.txt`](https://matrixy.github.io/Monkey.D.Loopy/llms-full.txt) — compact and complete
  agent-readable documentation indexes.
- [LoopSpec reference](docs/loopspec.md) — the IR, step kinds, expression language, validation rules.
- [`loopc` CLI](docs/cli.md) — every command and flag.
- [`@loopyc/runtime`](docs/runtime.md) — runtime API, journal format, resume semantics, guarantees.
- [`loopc-mcp`](docs/mcp.md) — MCP tools and how to register the server.
- [Local operator](docs/operator.md) — secured dashboard, scheduler handoff, run controls, and audit.
- [Artifacts and notifications](docs/artifacts-and-notifications.md) — safe output contracts and
  generic webhook delivery semantics.
- [Guarded evolution](docs/guarded-evolution.md) — isolated candidates, deterministic regression
  gates, explicit waivers, human activation, and byte-exact rollback.
- [Operator platform roadmap](docs/operator-platform-roadmap.md) — verified recipes, local control
  center, artifacts, notifications, and guarded evolution.
- [Verified recipe contract](docs/recipes.md) — product-use-case packages over canonical LoopSpec.
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
pnpm docs:build       # verify agent docs and build the GitHub Pages site
pnpm release:check    # synchronized versions + CLI/help/targets/docs parity
pnpm release:pack-smoke # clean consumer installs tarballs and exercises every target
```

Each package publishes its compiled `dist` (via `publishConfig`), so installed consumers run the
`loopc` / `loopc-mcp` bins and the generated artifacts with **plain `node`** — no `tsx` required.
CI runs typecheck + tests + `pnpm eval` + build on every PR; the live skill-eval runs nightly.
Release `0.7.1` also gates on repository-to-tarball parity, a clean-room onboarding smoke, and a zero-vulnerability audit.
