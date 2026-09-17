# @loopyc/mcp

`loopc-mcp` — the whole [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy) factory
exposed to agents as MCP tools.

Register the server and any MCP-capable agent can scaffold, validate, dry-run-verify, score,
compile, and inspect bounded agent loops — the same pipeline as the `loopc` CLI, tool by tool.

```json
{ "mcpServers": { "loopy": { "command": "npx", "args": ["--yes", "@loopyc/mcp@latest"] } } }
```

```bash
codex mcp add loopy -- npx --yes @loopyc/mcp@latest
claude mcp add --scope user loopy -- npx --yes @loopyc/mcp@latest
```

The server uses stdio. A global `npm i -g @loopyc/mcp` install and `loopc-mcp` command work too.

Tool reference: [docs/mcp.md](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/docs/mcp.md).


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
