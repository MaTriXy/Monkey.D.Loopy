# @loopyc/infer

Start from what you have: deterministic **FactPack extraction** for
[Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy).

Point it at an existing bash or JS/TS script (AST-based, no model calls) or a `.loopy` run
journal, and it extracts the loop-shaped facts — commands, conditions, sleeps, retries, state —
into a draft LoopSpec scaffold to refine with `loopc` or the `/loopy` authoring skill.

```bash
loopc infer-scaffold ./my-poll-script.sh     # via @loopyc/cli
```

See the [project README](https://github.com/MaTriXy/Monkey.D.Loopy#readme) for the full factory.

## Jev authoring and iterative refinement (source preview)

These source-preview capabilities are not in published 0.8.0. See
[availability and source setup](https://matrixy.github.io/Monkey.D.Loopy/availability) and confirm
that the installed CLI/MCP tool list includes the feature before using it.

| CLI | MCP | Purpose |
|---|---|---|
| `recommend` | `recommend_workflow` | Rank eligible catalog structures for a brief |
| `design` | `design_workflow` | Create a validated, mock-verified scaffold from an explicit selection |
| `refine` | `refine_workflow` | Compare current YAML and authored revisions with feedback/evidence; preserve history |

Jev requires `TYPESAFE_API_KEY` in the process environment and explicit provider selection
(`allowExternal: true` in MCP). Env files are not loaded automatically. Refinement sends supplied
eligible YAML, feedback and evidence to TypeSafe; keep secrets out. Offline performs local checks
and retains current, without claiming semantic improvement. These authoring calls never activate
a workflow or execute its real effects.

Read the [workflow designer](https://matrixy.github.io/Monkey.D.Loopy/workflow-designer),
[agent guide](https://matrixy.github.io/Monkey.D.Loopy/agent-guide), and
[complete agent context](https://matrixy.github.io/Monkey.D.Loopy/llms-full.txt) for exact contracts,
setup, repeated rounds and limitations.

The source-preview library exports `recommendWorkflow`, `designWorkflow`, `refineWorkflow`,
`revisionDigest`, and the non-overwriting writers `writeWorkflowDesign` / `writeWorkflowRefinement`.
A minimal refinement caller can load the documented request JSON:

```js
import {refineWorkflow, writeWorkflowRefinement} from '@loopyc/infer';
import {readFile} from 'node:fs/promises';
const request = JSON.parse(await readFile('refinement.json', 'utf8'));
const report = await refineWorkflow(request, {provider: 'offline'});
await writeWorkflowRefinement('revisions/round-1', report);
```

Pass a prior `RefinementReport` as the third argument to `refineWorkflow` for another round and
set `request.current` to that report's exact selected YAML. `revisionDigest(yaml)` attributes
an evidence summary to a compared revision. `provider: 'jev'` reads `TYPESAFE_API_KEY` from the
process environment unless an API key is explicitly supplied in options; do not persist that option.
