# @loopy/mcp

`loopc-mcp` — the whole [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy) factory
exposed to agents as MCP tools.

Register the server and any MCP-capable agent can scaffold, validate, dry-run-verify, score,
compile, and inspect bounded agent loops — the same pipeline as the `loopc` CLI, tool by tool.

```bash
npm i -g @loopy/mcp
loopc-mcp   # stdio MCP server
```

```json
{ "mcpServers": { "loopy": { "command": "loopc-mcp" } } }
```

Tool reference: [docs/mcp.md](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/docs/mcp.md).
