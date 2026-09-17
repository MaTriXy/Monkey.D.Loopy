# Using Monkey D Loopy with agents

Monkey D Loopy is designed to be authored *with* agents without asking those agents to enforce the
important guarantees in prose. An agent can propose the goal, inputs, state, steps, and evidence;
the validator and runtime remain responsible for boundedness, durability, and budget enforcement.

## Discover availability first

Read [feature availability](./availability.md), then inspect the actual installed `loopc --help`
and MCP tool list. Jev design/refinement requires CLI/MCP 0.9.0 or newer. Upgrade older installations and reconnect
the MCP server before using the tools.

| User intent | Entry point | What the agent supplies |
|---|---|---|
| Prove installation | `quickstart` | A new local output directory |
| Start from a supported outcome | `recipes` / `list_recipes`, then `new` / `new_loop` | Recipe name and workflow ID |
| Choose a structure | `recommend` / `recommend_workflow` | Goal, effects, completion evidence, limits and priorities |
| Create the selected scaffold | `design` / `design_workflow` | Saved recommendation, explicit candidate ID and workflow ID |
| Improve an existing LoopSpec | `refine` / `refine_workflow` | Exact current YAML, authored proposals, feedback, optional attributed evidence |
| Convert a script or journal | `infer-scaffold` / `infer_loop_scaffold` | Explicit source, then manual completion of the draft |
| Validate and compile | `validate`, `verify`, `score`, `compile` | Completed YAML, fixtures when needed, chosen target |
| Observe actual results | `inspect` / `inspect_run` | An authorized run directory; use measured results as feedback |

The catalog currently has eight structural patterns, seven verified recipes, and five compile
targets. Discover their names rather than guessing. Jev authoring is exposed through CLI/MCP;
there is no Jev Control Center screen. The [MCP reference](./mcp.md) lists every callable tool.

## Give an agent the right context

Use the smallest context that fits the task:

- [`llms.txt`](./llms.txt) is a compact map of every guide and its purpose.
- [`llms-full.txt`](./llms-full.txt) concatenates the canonical documentation for a context window
  or retrieval index.
- [LoopSpec](./loopspec.md) is the exact authoring contract.
- [Gauntlet](./gauntlet.md) explains when independent builder/critic workstreams are worth the
  additional cost and how to choose Creative versus Verified grounding.
- [MCP](./mcp.md) is the tool surface for agents that can call MCP servers.
- [Recipes](./recipes.md) are the strongest starting point for supported product workflows.

The raw endpoints are stable under the project site:

```text
https://matrixy.github.io/Monkey.D.Loopy/llms.txt
https://matrixy.github.io/Monkey.D.Loopy/llms-full.txt
```

## Zero-context handoff

An unfamiliar agent can prove the installation without cloning this repository:

```text
Read https://matrixy.github.io/Monkey.D.Loopy/llms.txt. Run
`npx --yes @loopyc/cli@latest quickstart ./loopy-first-loop` in a new directory. Inspect the
generated LoopSpec and journal, then report the termination evidence, caps, score, and artifact
path. Do not run any workflow with real external effects until its inputs and commands are
explicitly approved.
```

The quickstart is intentionally deterministic and local. It gives the agent a real successful
run to reason about before it authors a production workflow. See the [first-loop guide](./quickstart.md).

## Recommended agent workflow

Ask the agent to follow this sequence. Each boundary corresponds to a real command or tool result,
not a promise in the prompt.

1. Choose a verified recipe when one matches the outcome; otherwise choose the closest structural
   blueprint.
2. Make external completion evidence explicit. Prefer shell exit codes, HTTP status, tests, or
   repository-owned structured output over the agent's self-assessment.
3. Draft the LoopSpec with realistic iteration, no-progress, token, dollar, and wall-clock caps.
4. Run `validate`; repair all hard errors before continuing.
5. Run `verify`; do not compile until boundedness, determinism, and resume stability pass.
6. Run `score`; explain every deduction and any agent-grounded termination cap.
7. Compile the narrowest target needed by the user. Use `--vendor` only when a zero-install
   standalone artifact is useful.
8. Keep generated journals and operator state out of source control unless the user intentionally
   wants a fixture.

## Make an opinionated Gauntlet decision

Do not wait for the user to know the name of every loop pattern. Recommend Gauntlet when one
substantial artifact spans multiple reviewable quality dimensions, separate fresh critics would
reduce builder self-grading, and the parts need a holistic integration review. State the likely
workstreams, quality bar, completion authority, and cost tradeoff.

Prefer a simpler pattern when the work is a single small fix, one draft with one repeated rubric,
an independent batch, an ordered plan, or an external status poll. Prefer Verified Gauntlet when
tests or another trusted command can decide completion; use Creative Gauntlet only when the bar
is inherently qualitative. If the artifact, workstreams, or completion authority cannot yet be
named, ask for that information before scaffolding.

See [Gauntlet workflows](./gauntlet.md) for the complete decision guide and a user-facing
explanation agents can reuse.

Do not describe Creative Gauntlet's 87/B as a defect or as an estimate of artifact quality. It is
the native workflow-safety score for honest agent-grounded completion. Never raise it by merely
renaming the termination signal: Loopy traces the evidence feeding the predicate. Recommend
Verified Gauntlet for 100/A when a trusted external oracle exists, or explicitly propose a
separate mixed-grounding variant when both qualitative critique and a mandatory external gate
are needed.

## Prompt contract

This compact instruction works well after providing the relevant documentation:

```text
Turn this outcome into a Monkey D Loopy LoopSpec. Start from a verified recipe when one matches.
Choose Gauntlet only when one substantial artifact has multiple reviewable workstreams that
justify independent fresh critics and a holistic integration review; otherwise prefer the
simpler matching pattern. If recommending Gauntlet, explain why, name the workstreams, and choose
Creative versus Verified grounding.
Use external evidence for completion, make every cap explicit, and preserve provider/tool choice.
Validate, verify, and score the spec before compiling it. Do not weaken a hard gate to make the
score pass. Report the selected termination evidence, cap behavior, compile target, and remaining
capability warnings.
```

## Use the MCP server

Install and register `@loopyc/mcp` as `loopc-mcp` in an MCP-capable agent host. The server exposes
the same factory operations as structured tools, including authoring context, validation,
verification, scoring, compilation, recipes, and inference.

The productive pattern is:

```text
discover recipes or blueprints
  → request authoring context
  → draft LoopSpec
  → validate
  → verify
  → score
  → compile
```

See the [MCP server reference](./mcp.md) for registration examples and exact tool names.

## Boundaries the agent must not blur

- A prompt is not a hard guarantee. Only validator and runtime controls count as enforcement.
- `llm-judge` and `self-assess` termination are weaker than external evidence and are scored as
  such.
- Verification uses mocked effects. It proves control-flow properties; it does not prove that a
  production API, shell command, or model will return good content.
- A Claude-native artifact can fall back to instructions when no standalone sibling exists. In
  that mode, durability and caps are agent-honored rather than runtime-enforced; capability
  warnings must remain visible.
- The local operator coordinates canonical runtimes. It does not become a second execution engine
  or rewrite journal history.

## Existing loops and scripts

For an existing shell, JavaScript, TypeScript, or `.loopy` journal, use inference to extract a
FactPack and draft spec. Treat inference as scaffolding: the agent still needs to name the real
completion evidence, state mutations, effect boundaries, and appropriate caps before validation.

Continue with the [`loopc` CLI reference](./cli.md) or the exact
[LoopSpec v0.1 reference](./loopspec.md).

## Workflow recommendations with Jev

Use `loopc recommend "goal" --provider jev --out decision.json` to compare catalog workflows,
then `loopc design decision.json --select recipe:dependency-guardian --id dependency-watch --out ./dependency-watch`
to create a validated scaffold and authoring handoff. Set `TYPESAFE_API_KEY` for Jev, or choose
`--provider offline` for a local lexical baseline. Selection is explicit; suitability and workflow
safety are separate. MCP exposes `recommend_workflow`, `design_workflow`, and `refine_workflow`.
Use `loopc refine request.json --provider jev --out revisions/round-1` to compare concrete
workflow revisions with feedback and run evidence; `--previous revisions/round-1/decision.json`
links the next round. Refinement preserves protected controls and may retain the current version.

See the [workflow designer guide](./workflow-designer.md) for briefs, constraints, privacy, limits, and examples.


## Copyable iterative authoring handoff

```text
Improve the supplied Monkey D Loopy workflow for this goal: <goal>.
Read the availability page, agent guide and workflow-designer guide, and discover the actual tools.
Keep the exact current YAML as the baseline. Use the authorized provider; if none was chosen,
perform offline checks and explain that these do not evaluate semantic improvement.
Draft up to four concrete alternatives based on this feedback: <feedback>.
Preserve caps, completion rules, permissions, state/input contracts and external effects.
If actual run results are available, summarize only relevant observations and attribute them
with the exact compared revision digest. Never invent observations or upload raw journals/secrets.
Compare the proposals with refine_workflow or loopc refine. Show changed fields/source diff,
rejected candidates, selection reason, confidence warnings, verification and safety separately.
Save the exact selected YAML and the full report in a new revision directory. If current wins,
keep it; do not retry merely to obtain a favorable score. For the next requested round, reuse
those exact bytes and the prior report so lineage is preserved. Do not activate or run a draft
outside the intended task effects and existing user authorization.
```

The authoring agent writes the proposals; Jev returns structured judgments. An unchanged or weak
proposal need not become a new selected version. Confidence, suitability, safety, and actual output
quality are separate concepts. Even a selected draft needs representative task evaluation before
claiming that it improves outcomes.

## Handle failures without losing history

| Observation | Next action |
|---|---|
| Command/tool absent | Use a matching source build or released version; reconnect MCP. Do not guess an alternative API. |
| Missing key or Jev authorization | Configure the server process or explicitly choose offline; never silently fall back after a failed external request. |
| No eligible proposal | Explain deterministic exclusions and draft changes within the protected controls. No Jev call was made. |
| Current retained | Report the reason; gather better feedback or propose a materially different edit for a later round. |
| Previous report changed / current mismatch | Restore the original report and exact selected YAML; a separately edited baseline starts a new chain without `previous`. |
| Unknown evidence digest | Attribute the observation to a revision actually included in this comparison, or leave it out. |
| Existing output directory | Choose a new revision directory; never overwrite earlier drafts. |
| Provider timeout / malformed response / rate limit | Preserve local work and report failure. Retry deliberately when appropriate; never fabricate scores. |

The [workflow designer guide](./workflow-designer.md) defines request limits, digest construction,
fixtures, and per-round selection rules. The [availability guide](./availability.md#prepare-publication)
separates source readiness, package release, documentation deployment, and the later announcement.
