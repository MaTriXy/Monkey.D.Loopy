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
- expected artifact paths and formats (conventions until the Phase 4 artifact contract ships);
- a safety rationale, secret-handling rule, and whether destructive actions require approval;
- `minimum_score` from 90–100 (the catalog quality floor);
- distinct success, no-op, cap, malformed-evidence, and prompt-injection fixtures.

The pure `@loopyc/core` APIs `parseRecipeSource()` and `createRecipeCatalog()` validate supplied
file contents. They reject path traversal, invalid LoopSpecs, metadata/spec input or schedule drift,
missing/aliased fixtures, and duplicate names. Filesystem discovery and CLI materialization stay in
the I/O layer; execution still uses the recipe's ordinary LoopSpec.
