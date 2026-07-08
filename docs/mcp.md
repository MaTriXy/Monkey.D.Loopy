# `loopc-mcp` — MCP server reference

`loopc-mcp` exposes the Monkey D Loopy factory over the [Model Context
Protocol](https://modelcontextprotocol.io) so any MCP-capable agent can author, verify,
compile, run, and inspect loops conversationally. Source:
[`packages/mcp`](../packages/mcp).

## Register it

**Compiled (recommended)** — after `pnpm build`, the bin is plain-node runnable. Add it to your
MCP client's `mcpServers` config:

```json
{ "mcpServers": { "loopc": { "command": "node", "args": ["/ABS/PATH/MonkyDLoopy/packages/mcp/dist/index.js"] } } }
```

Once published/installed, just point at the `loopc-mcp` bin:

```json
{ "mcpServers": { "loopc": { "command": "loopc-mcp" } } }
```

(If your MCP client has a CLI registration command, that works too — e.g.
`<your-mcp-client> mcp add loopc -- node /ABS/PATH/MonkyDLoopy/packages/mcp/dist/index.js`.)

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
[`packages/mcp/test`](../packages/mcp/test)).

## Tools

| Tool | Args | Returns |
|---|---|---|
| `get_loop_schema` | — | The LoopSpec authoring guide. **Read this first.** |
| `list_blueprints` | — | The built-in blueprints (one per pattern). |
| `new_loop` | `id`, `blueprint?`, `pattern?` | A scaffolded LoopSpec YAML. |
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
  enforces budgets and lowers `http` to a `curl` shell task).
- `run_loop` is the sharp edge — it runs real `shell`/`http`/`agent` steps. Prefer
  `verify_loop` for validation; reach for `run_loop` only to actually execute.
