# Recipe catalog

Each directory is a complete verified recipe package. See [the recipe contract](../docs/recipes.md).

Recipes are product use cases; structural examples remain in the built-in blueprint catalog.

| Recipe | Purpose | Default schedule |
| --- | --- | --- |
| `dependency-guardian` | Review dependency risk without auto-merging | watch |
| `docs-drift-sweep` | Find and repair documentation drift | manual |
| `market-signal-monitor` | Produce a linked market-signal brief | daily cron |
| `production-error-sweep` | Triage production error summaries without ingesting secrets | forever |
| `release-follow-up` | Follow a release until its external checks settle | forever |
| `repo-health-doctor` | Diagnose repository health from a deterministic check | manual |

Every package includes five adversarial/runtime fixtures. `pnpm eval` loads this catalog,
checks the contract, verifies and scores every LoopSpec, compiles every target, and runs
the fixtures through the real journaled runtime.
