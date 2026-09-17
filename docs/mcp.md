# `loopc-mcp` — MCP server reference

`loopc-mcp` exposes the Monkey D Loopy factory over the [Model Context
Protocol](https://modelcontextprotocol.io) so any MCP-capable agent can author, verify,
compile, run, and inspect loops conversationally. Source:
[`packages/mcp`](https://github.com/MaTriXy/Monkey.D.Loopy/tree/main/packages/mcp).

## Register from npm

No repository clone or global install is required. Let the client launch the published package
through `npx`:

```json
{
  "mcpServers": {
    "loopy": {
      "command": "npx",
      "args": ["--yes", "@loopyc/mcp@latest"]
    }
  }
}
```

Codex CLI:

```bash
codex mcp add loopy -- npx --yes @loopyc/mcp@latest
```

Claude Code:

```bash
claude mcp add --scope user loopy -- npx --yes @loopyc/mcp@latest
```

If you prefer a global install:

```json
{ "mcpServers": { "loopy": { "command": "loopc-mcp" } } }
```

```bash
npm i -g @loopyc/mcp
```

## Register from a source checkout

After `pnpm build`, point the client at the plain-Node entry:

```json
{ "mcpServers": { "loopy": { "command": "node", "args": ["/ABS/PATH/Monkey.D.Loopy/packages/mcp/dist/index.js"] } } }
```

**From source (dev, no build)** — via the `tsx` loader:

```json
{
  "mcpServers": {
    "loopc": {
      "command": "node",
      "args": ["--import", "tsx", "packages/mcp/src/index.ts"],
      "cwd": "/ABS/PATH/MonkyDLoopy"
    }
  }
}
```

The server speaks JSON-RPC over **stdio**. `createServer()` is transport-agnostic, so it is
also embeddable in-process via the SDK's `InMemoryTransport` (see
[`packages/mcp/test`](https://github.com/MaTriXy/Monkey.D.Loopy/tree/main/packages/mcp/test)).

## Tools

| Tool | Args | Returns |
|---|---|---|
| `get_loop_schema` | — | The LoopSpec authoring guide. **Read this first.** |
| `list_blueprints` | — | The built-in blueprints (one per pattern). |
| `new_loop` | `id`, `blueprint?`, `recipe?`, `pattern?` (including `gauntlet`) | A scaffolded LoopSpec YAML. |
| `validate_loop` | `yaml` | Validator diagnostics; `isError` when invalid. |
| `verify_loop` | `yaml` | Dry-run report (bounded/deterministic/resume-stable) + scorecard. No side effects. |
| `compile_loop` | `yaml`, `target?` (`standalone`, `babysitter`, `claude-code`, `claude-native`, `n8n`, or `all`), `out?` | Writes files when `out` is given; otherwise returns the planned files inline. |
| `run_loop` | `yaml`, `inputs?`, `cwd?` | **Executes the loop with REAL effects** in a journaled run dir; returns the `RunResult`. Use only when side effects are intended. |
| `inspect_run` | `dir`, `tail?` | A run's status, latest state, and last journal events. |
| `infer_loop_scaffold` | `source`, `filename?` | A **draft** LoopSpec extracted from a script (JS/TS or bash) or a `.loopy` journal — complete the TODOs, then validate/verify. No LLM, no side effects. |

## Suggested agent flow

```
get_loop_schema → new_loop → (edit) → validate_loop → verify_loop → compile_loop
                                                         ↘ run_loop → inspect_run
```

`verify_loop` is the safe gate: it proves the loop is bounded and deterministic **without any
side effects** before `run_loop` ever touches the real world.

## Notes

- `validate_loop`/`verify_loop` refuse unbounded or unreachable loops (the factory's core
  guarantee).
- `compile_loop` surfaces capability warnings per target (e.g. the babysitter target soft-
  enforces budgets and lowers `http` to a `curl` shell task). For `target: "claude-native"`,
  the planned files include a Claude Code project skill under `.claude/skills/<loop>/SKILL.md`;
  use `target: "all"` when you want that skill to be emitted next to the standalone artifact it
  can delegate to for runtime-enforced guarantees.
- `run_loop` is the sharp edge — it runs real `shell`/`http`/`agent` steps. Prefer
  `verify_loop` for validation; reach for `run_loop` only to actually execute.

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
