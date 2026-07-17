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

## Install and inspect

```bash
loopyd install ./out/my-loop/standalone
loopyd up --background
loopyd status
loopyd list
loopyd ui
loopyd down
```

Install resolves the artifact path, reads `loop.lock` and `loop.source.yaml`, hashes the spec, and
atomically updates registry schema `1`; it never writes into the artifact. Registry directories use
mode `0700` and token/registry/config/PID files use `0600`. The config remembers the bound port so
`ui`, `status`, and shutdown commands stay coherent after a custom-port start. A newer registry is exposed as an explicit
version-skew error and an older one requires an explicit migration.

The API is versioned under `/api/v1`, binds only to loopback, and requires its 256-bit local token
for HTML, events, and JSON reads. The tokenized UI bootstrap is exchanged for an HttpOnly,
SameSite=Strict cookie and redirected to a clean URL. Cross-origin requests, unsupported methods,
path traversal, and bodies over 64 KiB are rejected; CORS is never opened implicitly.

The React/Vite control center is bundled into `@loopyc/operator`. It shows installed loop cards,
score, grounding, termination/caps, scheduler authority, run integrity, cost, state, and a reverse
timeline with the journal source path. Server-sent events trigger refreshes and five-second polling
is the fallback. Desktop, single-column tablet, horizontally scrollable loop navigation, container-
responsive run details, keyboard focus, reduced motion, and narrow phone layouts are represented in
the stylesheet.

`loopyd up --background` is supported on macOS and Linux; Windows is foreground-only and receives
an explicit command. No service starts during npm installation. Mutating run controls and scheduler
handoff are introduced in Phase 3.
