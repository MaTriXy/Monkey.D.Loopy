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
