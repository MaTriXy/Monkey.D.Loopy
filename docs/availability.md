# Feature availability and release readiness

**0.9.0** introduces Jev workflow design and iterative refinement. Use matching CLI/MCP packages
and check the installed CLI help and the connected server's tool list before choosing tools.

| Capability | Available version / surface |
|---|---|
| LoopSpec authoring, recipes, validate/verify/score, compile, runtime and operator | Existing 0.8.0 functionality, retained in 0.9.0 |
| Jev/offline recommendations and verified scaffold design | 0.9.0 CLI and MCP |
| Iterative Jev refinement and parent-linked revision reports | 0.9.0 CLI and MCP |
| Jev controls in the Control Center UI | Not implemented; use CLI or MCP |
| Automatic improvement of real workflow output | Not promised; compare representative results before adopting a draft |

## Install 0.9.0

With Node.js 22 or newer:

```sh
npm install -g @loopyc/cli@0.9.0
loopc --version
loopc --help
```

For MCP, register `npx --yes @loopyc/mcp@0.9.0` using the [MCP reference](./mcp.md). Reconnect the
host after upgrading and confirm it lists `recommend_workflow`, `design_workflow`, and
`refine_workflow`. Do not silently substitute unrelated tools if an older installation lacks them.
Jev is optional; offline authoring requires no API key.

## Use a source checkout

Check out the `v0.9.0` tag for the release source. From the repository root, using the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js --help
```

In these guides, `loopc` means the installed CLI or that checkout's built CLI. Run source examples
with `node --import tsx packages/cli/src/index.ts <command>` from the repository root. Arguments to
`pnpm --filter @loopyc/cli ...` instead resolve relative to the package directory.

## Prepare publication

Documentation and package publication are separate operations. The Pages workflow builds docs
from `main` on matching pushes; merging into `dev` alone does not publish the site. A version tag
triggers the npm release workflow, which builds and gates all seven public packages before
publishing them with provenance in dependency order.

For future releases:

1. Review and merge changes; synchronize package/factory versions and availability documentation.
2. Run `pnpm agent-docs:generate`, `pnpm agent-docs:check`, `pnpm typecheck`, `pnpm test`,
   `pnpm eval`, `pnpm build`, `pnpm docs:build`, `pnpm release:check`, and `pnpm onboarding:smoke`.
3. Promote the verified release to `main`, tag the release commit, and publish through the workflows.
4. Verify all npm versions, GitHub release notes, CLI help, MCP tools, Pages, `llms.txt`, and
   `llms-full.txt` against the tagged artifacts.
5. Prepare the announcement video after the documentation and release work is complete. Show real
   available behavior and distinguish authoring scores from measured output quality.

The announcement video remains a separate, deferred production task.
