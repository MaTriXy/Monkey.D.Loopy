# Feature availability and release readiness

This documentation includes source-preview features. The repository package version remains
**0.8.0**; a checkout reporting that version does not mean every feature below exists in the
published 0.8.0 artifacts. Check the installed CLI help and the connected MCP server's tool list.

| Capability | Availability in this documentation |
|---|---|
| LoopSpec authoring, recipes, validate/verify/score, compile, runtime and operator | Existing 0.8.0 functionality |
| Jev/offline recommendations and verified scaffold design | Source preview; not part of the published 0.8.0 release |
| Iterative Jev refinement and parent-linked revision reports | Source preview; not part of the published 0.8.0 release |
| Jev controls in the Control Center UI | Not implemented; use CLI or MCP |
| Automatic improvement of real workflow output | Not promised; compare representative results before adopting a draft |

## Use the source preview

Use a checkout containing the Jev feature (currently [PR #16](https://github.com/MaTriXy/Monkey.D.Loopy/pull/16)).
From the repository root, with Node.js 22 or newer and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js --help
```

In this guide, `loopc` means that checkout's CLI or a future published release whose help includes
`recommend`, `design`, and `refine`. Run source examples with
`node --import tsx packages/cli/src/index.ts <command>` from the repository root. Arguments to
`pnpm --filter @loopyc/cli ...` instead resolve relative to the package directory.

Register the built MCP entry as described in the [MCP reference](./mcp.md). Confirm that the host
lists `recommend_workflow`, `design_workflow`, and `refine_workflow`; reconnect after updating the
server. Do not silently substitute unrelated tools if the installed package lacks these features.

## Prepare publication

Documentation and package publication are separate operations. The repository's Pages workflow
builds documentation from `main` on matching pushes; merging into `dev` alone does not publish the
site. Package publication follows the release workflow. Before announcing availability:

1. Review and merge the feature through the project's normal branch process.
2. Choose the release version and synchronize packages through the existing release process.
   Update this availability table to the actual released version, not an anticipated version.
3. Run `pnpm agent-docs:generate`, `pnpm agent-docs:check`, `pnpm typecheck`, `pnpm test`,
   `pnpm eval`, `pnpm build`, `pnpm docs:build`, `pnpm release:check`, and `pnpm onboarding:smoke`.
4. Publish through the existing workflows, then verify the installed CLI help, MCP tools,
   documentation pages, `llms.txt`, and `llms-full.txt` against the released artifacts.
5. Prepare the feature announcement video after documentation and release readiness work is
   complete. Demonstrate real available behavior and distinguish authoring scores from measured
   output quality. Video production is deferred; no video has been created by this docs update.

No package version bump, merge, package publication, or Pages deployment is implied by preparing
these documents.
