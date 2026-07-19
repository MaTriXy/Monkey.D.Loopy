# Your first bounded loop

This path starts from an empty directory and ends with an executed, inspected, portable loop. The
generated loop does not call a model or application API; `npx` only downloads the CLI from npm.
Node.js 22 or newer is the only prerequisite.

## One-command proof

```bash
npx --yes @loopyc/cli@latest quickstart
```

Use a custom output directory when you want to keep more than one walkthrough:

```bash
npx --yes @loopyc/cli@latest quickstart ./my-first-loop
```

`quickstart` deliberately refuses a non-empty destination. It will not overwrite an existing
project.

## What the command proves

The command performs the real product sequence:

1. Writes an editable `hello-loopy.loop.yaml` and data-only `verify-fixtures.json`.
2. Validates termination, caps, and expression reachability.
3. Dry-run verifies boundedness, determinism, and resume stability, then prints the scorecard.
4. Executes one safe local shell step, reaches an externally grounded oracle predicate, and runs
   a completion observer.
5. Reads the resulting event-sourced journal, including the observer outcome.
6. Compiles a vendored standalone artifact that runs with plain Node—no package install required.

The default result is:

```text
loopy-quickstart/
├── hello-loopy.loop.yaml
├── verify-fixtures.json            # deterministic dry-run effect result
├── run/.loopy/runs/default/       # durable journal and run metadata
└── artifact/standalone/
    ├── loop.mjs
    ├── runtime.bundle.mjs          # vendored runtime
    ├── loop.lock
    └── loop.source.yaml
```

Open the spec and journal before moving on. They are the two core contracts: the spec says what is
allowed to happen, and the journal records what actually happened.

## Why the starter scores 100

The starter earns every point from behavior that is both implemented and regression-tested:

| Dimension | Points | Reason |
|---|---:|---|
| Termination safety | 30/30 | A shell-produced structured fact feeds an `oracle` predicate; the verifier classifies that evidence chain as external. |
| Caps | 25/25 | Iteration, no-progress, token, cost, and wall-clock bounds are explicit. |
| Observability | 15/15 | The durable journal is enabled and an executable `completed` hook records its started/done or started/failed outcome. |
| Resumability | 15/15 | Restart-per-iteration verification reaches the same result. |
| Determinism | 15/15 | Independent mocked runs converge on the same state and status. |

The fixture file returns the same structured result from the dry-run shell mock, so verification
remains deterministic and side-effect-free. The real run executes the local command. This does
not pretend that a local command is a remote production authority; it proves the mechanism:
termination is based on effect evidence rather than an unconditional mutation or agent self-report.

The observer is best-effort by design. Its outcome is durable in the journal, but an observer
failure cannot rewrite an already successful loop as failed. Do not relabel a predicate as an
oracle or add inert metadata merely to change the number: Loopy traces termination writers and
only awards observer credit to an executable completion hook or active notification contract.

## Regression-tested onboarding contract

The repository runs this same journey against packed npm tarballs in CI. The gate requires:

| Contract | Evidence |
|---|---|
| No source checkout | CLI and MCP are installed only from packed public packages. |
| One safe entry command | `loopc quickstart` reaches an honest 100/100 completed run without a model or external API. |
| Real proof boundaries | Validation, verification, scoring, execution, and inspection all succeed. |
| Durable evidence | The clean workspace contains effect, termination, and observer journal events. |
| Portable result | The standalone artifact contains a vendored runtime, needs no install, and is executed in the packed-package gate. |

This keeps the first-run promise executable: documentation changes cannot silently drift away from
the package users actually install.

## Move from the demo to real work

Install the CLI once, then choose a verified outcome recipe when one fits:

```bash
npm i -g @loopyc/cli
loopc recipes
loopc new repo-check --recipe repo-health-doctor
loopc validate repo-check.loop.yaml
loopc verify repo-check.loop.yaml
loopc score repo-check.loop.yaml
```

Recipes may require inputs or trusted commands. Read the generated `inputs:` block before running
one. Pass runtime values in a JSON file rather than hard-coding secrets:

```bash
loopc run repo-check.loop.yaml --inputs ./inputs.json --out ./run/repo-check
loopc inspect ./run/repo-check
```

## Give the journey to an agent

Paste this instruction into a coding agent:

```text
Read https://matrixy.github.io/Monkey.D.Loopy/llms.txt and then use the first-loop guide.
Run the safe quickstart in a new directory, inspect the generated LoopSpec and journal, and report
the termination evidence, caps, score, and artifact path. Do not run a recipe with real effects
until I approve its inputs and commands.
```

For structured tools instead of shell commands, continue with the [MCP setup](./mcp.md). For the
full authoring contract, read [Using Loopy with agents](./agent-guide.md).
