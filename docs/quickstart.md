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

1. Writes an editable `hello-loopy.loop.yaml`.
2. Validates termination, caps, and expression reachability.
3. Dry-run verifies boundedness, determinism, and resume stability, then prints the scorecard.
4. Executes one safe local shell step and reaches the declared termination predicate.
5. Reads the resulting event-sourced journal.
6. Compiles a vendored standalone artifact that runs with plain Node—no package install required.

The default result is:

```text
loopy-quickstart/
├── hello-loopy.loop.yaml
├── run/.loopy/runs/default/       # durable journal and run metadata
└── artifact/standalone/
    ├── loop.mjs
    ├── runtime.bundle.mjs          # vendored runtime
    ├── loop.lock
    └── loop.source.yaml
```

Open the spec and journal before moving on. They are the two core contracts: the spec says what is
allowed to happen, and the journal records what actually happened.

## Why the starter scores 91, not 100

The starter is deliberately honest about what its tiny local demonstration proves:

| Dimension | Points | Reason |
|---|---:|---|
| Termination safety | 25.5/30 | A deterministic state predicate stops it, but no independent external system acts as an oracle. |
| Caps | 25/25 | Iteration, no-progress, token, cost, and wall-clock bounds are explicit. |
| Observability | 10.5/15 | The durable journal is enabled; no notification or lifecycle hook is configured for the local demo. |
| Resumability | 15/15 | Restart-per-iteration verification reaches the same result. |
| Determinism | 15/15 | Independent mocked runs converge on the same state and status. |

Those raw points total **91/100**. A production loop can earn 100 only when its exit predicate is
fed by authoritative external evidence and it has both durable tracing and a configured observer
(a lifecycle hook or notification). Do not relabel a predicate as an oracle just to change the
number; Loopy traces the evidence feeding termination and caps unsupported claims.

## Regression-tested onboarding contract

The repository runs this same journey against packed npm tarballs in CI. The gate requires:

| Contract | Evidence |
|---|---|
| No source checkout | CLI and MCP are installed only from packed public packages. |
| One safe entry command | `loopc quickstart` reaches a completed run without a model or external API. |
| Real proof boundaries | Validation, verification, scoring, execution, and inspection all succeed. |
| Durable evidence | The clean workspace contains the journal event stream. |
| Portable result | The standalone artifact contains a vendored runtime and needs no install. |

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
