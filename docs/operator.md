# Local operator contract

`@loopyc/operator` is optional. Standalone and vendored artifacts continue to run without it.

## Journal read model

`readRun(baseCwd, runId)` reads `.loopy/runs/<runId>/events.jsonl` as the canonical record and
returns API version `1` with:

- derived run status, state, iteration, usage, wake time, pending cap, stop, and uncertain effect;
- a human-readable timeline retaining the source event data;
- integrity and health classifications;
- exact local source paths for events, state cache, metadata, and lock.

Inspection is read-only. The state and metadata JSON files are caches/hints and never override a
contradictory journal. A valid final line without its append newline is treated as a torn tail. A
checksum mismatch, committed-count truncation, unresolved write-ahead effect, live lock, or newer
schema is visible and never labeled healthy. Corruption/truncation takes precedence when multiple
conditions are present.

`listRuns(baseCwd)` discovers run directories in deterministic code-unit order. The reference
corpus covers 100 runs and 10,000 events with a two-second startup gate.

The loopback API and mutation contract are introduced in the next operator slices; no background
service is installed during package installation.
