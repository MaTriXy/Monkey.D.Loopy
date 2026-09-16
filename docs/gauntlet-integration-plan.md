# Monkey.D.Loopy 0.8.0 — First-Class Gauntlet Workflow

## Summary

Add Gauntlet as a first-class Monkey.D.Loopy workflow pattern with two out-of-the-box variants:

1. **Creative Gauntlet blueprint** — an agent-grounded builder/critic loop that decomposes work into workstreams, builds each sequentially, reviews real artifacts with fresh critics, smooths the combined result, and performs a holistic final review.
2. **Verified Gauntlet recipe** — an oracle-grounded workflow driven by a trusted external judge, targeting a native Loopy verification score of 100 and requiring at least 99.

The release also adds an operator workflow gallery, a Gauntlet-specific run board, CLI/MCP discovery, documentation, examples, fixtures, and release parity checks.

Implementation is performed on the local `feat/gauntlet-workflow` branch by fresh Terra agents at medium reasoning effort under a Babysitter YOLO process. A separate fresh Terra reviewer must award at least 99/100 before the work is committed. Nothing is pushed and no pull request is created.

## Public Model and Schema Changes

### New loop pattern

Add `gauntlet` to the public `LoopPattern` union and every corresponding schema or discovery enum:

```ts
type LoopPattern =
  | "react"
  | "plan-execute-reflect"
  | "evaluator-optimizer"
  | "loop-until-dry"
  | "map-reduce"
  | "poll-until"
  | "cron"
  | "gauntlet";
```

Update core types and structural schema, CLI pattern handling, MCP `new_loop` input schema and descriptions, the blueprint catalog, property/evaluation generators, LoopSpec guides, generated agent documentation, and operator loop summaries.

Change `Blueprint.pattern` from an unrestricted `string` to `LoopPattern`. Add an invariant test requiring exactly one canonical blueprint for every public pattern.

### Native mutation expressions

Introduce a typed expression wrapper for `on_done.set` and `on_done.append` values:

```ts
interface MutationExpression {
  $expr: string;
}

type MutationValue =
  | null
  | string
  | number
  | boolean
  | MutationValue[]
  | { [key: string]: MutationValue }
  | MutationExpression;
```

Rules:

- Resolve `$expr` recursively inside mutation arrays and objects.
- Preserve native number, boolean, null, array, and object types.
- Restrict this behavior to mutation values; do not implicitly evaluate HTTP bodies or unrelated structures.
- Preserve all existing `"${...}"` string interpolation behavior.
- An object containing `$expr` is valid only when `$expr` is its sole key and its value is a string.
- Validate expressions with the existing safe expression parser and active alias scope.
- Reject malformed wrappers, unknown roots, out-of-scope aliases, and mixed literal/expression wrapper objects.
- Use the same emitter for standalone and Babysitter compilation and equivalent recursive evaluation in the interpreter.

This change is additive and backward compatible.

## Creative Gauntlet Blueprint

### Identity and inputs

- Blueprint name: `gauntlet`
- Pattern: `gauntlet`
- CLI: `loopc new my-launch --blueprint gauntlet`
- Example: `examples/gauntlet.yaml`

| Input | Type | Required | Default |
|---|---|---:|---|
| `goal` | string | yes | — |
| `bar` | string | yes | — |
| `references` | json | yes | — |
| `artifact_path` | string | no | `output/artifact` |
| `threshold` | number | no | `90` |
| `smoothing` | boolean | no | `true` |

### State

```yaml
workstreams: []
review_log: []
review_history: []
passed_count: 0
last_score: 0
last_gap: ""
final_score: 0
final_gap: ""
rounds: 0
decomposed: false
```

`review_log` contains readable prompt context. `review_history` contains structured records for the operator UI and replay.

### Loop behavior

1. **Decompose once.** A fresh read-only `cli` lead inspects the goal, quality bar, references, and real artifact. It returns `{workstreams:[{id,title,scope}]}`, which is saved before `decomposed` becomes true.
2. **Reset the round.** A portable no-op shell step resets `passed_count`, `final_score`, and `final_gap`, then increments `rounds`.
3. **Run workstreams sequentially.** Use deterministic `reduce` with alias `workstream`. A fresh builder edits only the declared scope and receives prior reviews. A separate fresh, read-only critic inspects the real artifact and returns `{score,gap,evidence}`. Save the result, append readable and structured history, and increment `passed_count` when the threshold is met.
4. **Smooth.** Run a fresh integration builder only when at least one workstream exists, all passed, and smoothing is enabled.
5. **Holistic review.** Run a fresh read-only critic only when at least one workstream exists and all passed. Save `final_score` and `final_gap`.
6. **Terminate.** Use `signal: llm-judge` and `until: state.final_score >= inputs.threshold`.

All workstreams rerun on later rounds because the current `reduce` primitive has no filter semantics. Previously passing builders receive review history and may make no change. This v1 limitation is documented instead of adding a new runtime primitive.

### Safety, caps, and grounding

- Maximum iterations: 8.
- No-progress fingerprint combines `passed_count`, `last_score`, and `final_score`.
- Maximum identical fingerprints: 3.
- Define bounded token, USD, and wall-clock budgets.
- `on_cap_exceeded: breakpoint`.
- Manual schedule and `notify: never`.
- Journal observation enabled.
- Best-effort completed observer verifies the artifact path exists.
- Artifact allowlist: `output/**`, with bounded file/byte limits and exclusions for `.env`, `.git`, `node_modules`, secrets, and dependency trees.
- Empty or malformed decomposition cannot create vacuous success: smoothing and holistic review require `workstreams.length > 0`.
- Raw weighted creative score: **86.5/100**, honestly reflecting `llm-judge` grounding; the official native score is **87/100 (B)**. It must never be presented as 99 or oracle-verified.

## Verified Gauntlet Recipe

### Identity and inputs

- Recipe name: `verified-gauntlet`
- Pattern: `gauntlet`
- CLI: `loopc new my-launch --recipe verified-gauntlet`
- Manifest minimum score: `99`
- Expected native Loopy score: `100`

| Input | Type | Required | Default |
|---|---|---:|---|
| `goal` | string | yes | — |
| `bar` | string | yes | — |
| `artifact_path` | string | no | `output/artifact` |
| `judge_command` | string | yes | — |
| `report_path` | string | no | `output/verified-gauntlet.md` |

`judge_command` is a trusted executable name or path and is invoked through `cmd` plus a fixed argument array, never shell concatenation.

The judge returns:

```json
{
  "status": "pending | actionable | complete | no-op",
  "evidence": {
    "fingerprint": "Stable semantic fingerprint",
    "workstreams": [
      {
        "id": "stable-kebab-id",
        "title": "Reader-facing title",
        "scope": "Explicit artifact scope",
        "gap": "Concrete remaining gap",
        "evidence": "Artifact-grounded evidence"
      }
    ],
    "summary": "Overall judgment"
  }
}
```

The workflow invokes the trusted judge, saves status/evidence/fingerprint, sequentially reduces actionable workstreams through fresh `cli` builders, treats evidence as untrusted data, and terminates with `signal: oracle` only when status is `complete` or `no-op`. An agent never decides completion.

Safety and operation:

- Maximum iterations: 8.
- External no-progress fingerprint and maximum repeated fingerprints: 2, yielding three deterministic attempts.
- `on_cap_exceeded: exit-clean`.
- Manual schedule and `notify.on-change` with no default channels.
- Artifact allowlist `output/**` with standard limits and exclusions.
- Completed observer: `test -f ${inputs.report_path}`.
- Document the trusted executable boundary, evidence redaction, prompt-injection handling, and prohibition on ungated destructive actions.

Required fixtures:

1. Success: actionable one-workstream response followed by complete; exactly one builder call.
2. No-op: immediate no-op; zero builder calls.
3. Cap: repeated actionable fingerprint; exactly three builder calls before no-progress exit.
4. Malformed: invalid status/evidence; zero builder calls and deterministic no-progress exit.
5. Prompt injection: no-op plus hostile evidence; zero builder calls and no hostile text reaches an agent.

## CLI and MCP Integration

- Accept `gauntlet` everywhere public patterns are accepted.
- Generate the creative blueprint and verified recipe through their exact commands.
- Include both in list/help/catalog output.
- Preserve deterministic generation and existing patterns.
- Add `gauntlet` to MCP `new_loop` and catalog descriptions.
- Ensure MCP and CLI emit equivalent LoopSpecs for identical inputs.

## Operator API and Control Center

Keep operator API version `1` and add authenticated read-only `GET /api/v1/catalog`:

```ts
interface WorkflowCatalogResponse {
  apiVersion: "1";
  workflows: Array<{
    kind: "blueprint" | "recipe";
    name: string;
    title: string;
    summary: string;
    pattern: LoopPattern;
    grounding: string;
    score: number;
    grade: string;
    schedule: string;
    featured: boolean;
    commandTemplate: string;
  }>;
}
```

Build and score catalog entries once per server using core catalogs, parser, verifier, and scorer. Add `pattern` and safe LoopSpec `meta` to existing loop overview responses. Do not add workflow-creation HTTP mutations; CLI and MCP remain authoring authorities.

Add a responsive and accessible workflow gallery:

- Feature both Gauntlet variants first.
- Display grounding, native score, grade, and schedule clearly.
- Validate loop IDs with `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`.
- Copy the exact `loopc new` command with keyboard support and announcements.
- Respect reduced motion.

Add a defensive pure Gauntlet state projector and board:

- Creative state: workstreams, review history, threshold, passed count, rounds, final score/gap.
- Verified state: status and evidence workstreams/summary.
- Render round/stage, cleared count, score/threshold, iteration/budget status, workstream cards, largest gaps, and allowlisted artifact links.
- Keep journal/run state as the only persistence source.
- Escape all untrusted artifact, agent, and judge text.

## Documentation and Release

Add `docs/gauntlet.md` and update navigation, README, docs index, pattern/CLI/MCP/operator/recipe references, examples, specification, package READMEs, generated agent guides, and changelog.

Explain fresh context boundaries, real-artifact inspection, sequential v1 semantics, both grounding levels, the raw 86.5 / official 87-B creative score, trusted external judge operation, prompt-injection boundaries, and all entry points.

Release as `0.8.0` dated `2026-07-30`. Update root and workspace manifests, core/factory version constants, and release parity. Derive recipe count rather than hard-coding six. Keep seven public packages.

## Tests and Acceptance

Test:

- Core parsing/schema/catalog invariants for `gauntlet`.
- Recursive native `$expr` values, alias scope, invalid references/shapes, replay, interpreter, standalone, and Babysitter parity.
- Unchanged legacy string interpolation.
- Creative blueprint golden raw score `86.5` and official native score `87/B`, separate builder/critic invocations, deterministic reduction, multi-round completion, resume stability, caps, malformed/empty decomposition, artifacts, and observers.
- Verified recipe golden score `100`, all five fixtures, exact builder counts, oracle-only completion, safe executable arguments, and prompt-injection resistance.
- Compiler target parity, including current n8n best-effort behavior.
- Authenticated operator catalog, additive compatibility, gallery command generation, projector resilience, escaping, keyboard/focus/reduced-motion, and mobile/desktop presentation.

Required repository gates:

```sh
pnpm install --frozen-lockfile
pnpm recipes:generate
pnpm agent-docs:generate
pnpm -r typecheck
pnpm -r test
pnpm eval
pnpm build
pnpm docs:build
pnpm release:check
pnpm release:pack-smoke
pnpm security:audit
```

Perform browser QA at desktop and mobile widths and leave only intentional tracked changes.

## Babysitter YOLO Execution

Use Babysitter 6.x `run:create`, `run:iterate`, and `task:post` commands. Store ignored process/run artifacts under `.a5c/`. Every implementation and review task uses a fresh `gpt-5.6-terra` context with medium reasoning effort.

Stages:

1. Baseline and test inventory.
2. Core pattern and mutation expressions.
3. Creative blueprint and example.
4. Verified recipe and fixtures.
5. CLI and MCP integration.
6. Operator API, gallery, and Gauntlet board.
7. Documentation, generated files, and 0.8.0 versioning.
8. Full test/release gates.
9. Fresh independent quality review.
10. Fix/review loop until at least 99.
11. Local commit and completion proof.

Allow at most six review/fix rounds. If quality does not reach 99, report failure instead of fabricating completion.

## Independent 100-Point Rubric

| Area | Points |
|---|---:|
| Architecture, public API design, backward compatibility | 20 |
| Gauntlet semantics, fresh critics, real artifacts, honest grounding | 20 |
| Runtime, compiler, verifier, and target parity | 15 |
| Operator gallery, Gauntlet board, accessibility, responsive UX | 15 |
| Tests, fixtures, evaluation, security, and release gates | 15 |
| Documentation, discoverability, and 0.8.0 completeness | 10 |
| Repository hygiene and clean local commit | 5 |

Required score: **99/100**. Any required command failure, security regression, fabricated proof, or misleading grounding claim caps the score below 99.

## Completion Proof

Report the local branch, commit SHA, independent score breakdown, both native Loopy scores, every gate result, operator QA summary, confirmation that no push/PR occurred, and a clean post-commit worktree.

## Assumptions and Defaults

- Version 0.8.0 is the next release.
- Work remains local on `feat/gauntlet-workflow`.
- CLI and MCP remain authoring authorities.
- Operator support is discovery, visualization, and CLI handoff.
- Workstreams use existing sequential deterministic `reduce`.
- Every builder and critic gets a fresh process.
- Creative raw weighted score is 86.5 and official native score is 87/B; verified native score is 100.
- Babysitter's 99-point target measures implementation quality, not creative grounding.
- No new parallel runtime primitive, persistence layer, remote push, or pull request is in scope.
