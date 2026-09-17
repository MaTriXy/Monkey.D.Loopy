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

## Workflow recommendations with Jev

Use `loopc recommend "goal" --provider jev --out decision.json` to compare catalog workflows,
then `loopc design decision.json --select recipe:dependency-guardian --id dependency-watch --out ./dependency-watch`
to create a validated scaffold and authoring handoff. Set `TYPESAFE_API_KEY` for Jev, or choose
`--provider offline` for a local lexical baseline. Selection is explicit; suitability and workflow
safety are separate. MCP exposes `recommend_workflow` and `design_workflow`.

See the [workflow designer guide](../../docs/workflow-designer.md) for briefs, constraints, privacy, limits, and examples.
