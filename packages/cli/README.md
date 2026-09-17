# @loopyc/cli

`loopc` — the [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy) command-line factory
for runnable, crash-resumable agent loops.

```bash
npm i -g @loopyc/cli

loopc quickstart                     # honest 100: prove + run + observe + inspect + vendor
loopc blueprints                    # starting points, one per loop pattern
loopc recipes                       # verified product workflows
loopc new repo-check --recipe repo-health-doctor
loopc new my-watch --blueprint poll-until
loopc validate my-watch.loop.yaml   # refuses unbounded / unreachable loops
loopc verify   my-watch.loop.yaml   # dry-run proof: bounded · deterministic · resume-stable
loopc score    my-watch.loop.yaml   # 0-100 scorecard (termination grounding included)
loopc compile  my-watch.loop.yaml --target all --out ./out
loopc run      my-watch.loop.yaml --inputs ./inputs.json --out ./run
```

When the verified path depends on effect output, pass deterministic data-only mocks with
`loopc verify spec.yaml --fixtures fixtures.json` and `loopc score spec.yaml --fixtures
fixtures.json`. No shell, HTTP, or model effect executes during verification.

No-install first run: `npx --yes @loopyc/cli@latest quickstart`.

The load-bearing rule: **the compiler will not emit an unbounded loop.** Termination is
required, caps are mandatory, and the dry-run proves both before anything real executes.
Compile targets: `standalone` (add `--vendor` for a zero-install bundle), `babysitter`,
`claude-code`, `claude-native`, and `n8n`.

For Claude Code-native loops, `loopc compile --target claude-native` emits
`.claude/skills/<loop>/SKILL.md` plus the embedded LoopSpec reference. Copy the generated
`.claude/` directory into a project and invoke the loop as `/<loop> run`; compile with
`--target all` when you want the skill to delegate to a sibling standalone artifact for hard
runtime guarantees.

Full command reference: [docs/cli.md](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/docs/cli.md).

## Workflow recommendations with Jev

Use `loopc recommend "goal" --provider jev --out decision.json` to compare catalog workflows,
then `loopc design decision.json --select recipe:dependency-guardian --id dependency-watch --out ./dependency-watch`
to create a validated scaffold and authoring handoff. Set `TYPESAFE_API_KEY` for Jev, or choose
`--provider offline` for a local lexical baseline. Selection is explicit; suitability and workflow
safety are separate. MCP exposes `recommend_workflow` and `design_workflow`.

See the [workflow designer guide](../../docs/workflow-designer.md) for briefs, constraints, privacy, limits, and examples.
