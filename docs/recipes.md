# Verified recipes

A blueprint teaches one loop structure. A recipe packages one recognizable product goal around a
canonical LoopSpec: operational inputs, schedule intent, evidence sources, expected outputs,
safety rationale, minimum quality score, a runnable guide, and adversarial fixtures.

Recipe packages use this shape:

```text
recipes/<name>/recipe.json
recipes/<name>/<name>.loop.yaml
recipes/<name>/README.md
recipes/<name>/fixtures/
```

`recipe.json` uses contract version `"1"` and contains:

- `name`, `title`, and `summary`;
- an exact description of the LoopSpec `inputs`;
- `schedule.mode`, optional cadence, and the scheduling rationale;
- one or more evidence sources with `external`, `structural`, or `agent` grounding;
- expected artifact paths and formats, each product path explicitly allowlisted by LoopSpec
  `artifacts.include` (runtime journals remain internal evidence rather than synced products);
- a safety rationale, secret-handling rule, and whether destructive actions require approval;
- `minimum_score` from 90–100 (the catalog quality floor);
- distinct success, no-op, cap, malformed-evidence, and prompt-injection fixtures.

The pure `@loopyc/core` APIs `parseRecipeSource()` and `createRecipeCatalog()` validate supplied
file contents. They reject path traversal, invalid LoopSpecs, metadata/spec input or schedule drift,
product artifact allowlist drift, missing notification policy, missing/aliased fixtures, and duplicate names. The release embeds the checked catalog in core so
the published CLI and MCP server do not depend on a repository checkout; `pnpm recipes:check`
rejects drift between the canonical packages above and the generated catalog.

## Use a recipe

```bash
loopc recipes
loopc new my-health-check --recipe repo-health-doctor
loopc validate my-health-check.loop.yaml
loopc verify my-health-check.loop.yaml
loopc score my-health-check.loop.yaml
```

The MCP equivalents are `list_recipes` and `new_loop` with a `recipe` argument. Instantiation keeps
the canonical behavior but changes the loop id and adds `provenance.recipe`; every compile target
copies that metadata into `loop.lock`. Runtime execution still uses an ordinary LoopSpec and remains
independent from the catalog.

Before a real run, fill the required input(s) described by `loopc recipes` and the selected recipe's
README. External checks must emit `pending`, `actionable`, `complete`, or `no-op` plus redacted
`evidence`. Agent output never decides completion.
