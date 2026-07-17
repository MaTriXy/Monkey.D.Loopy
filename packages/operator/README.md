# @loopyc/operator

The local-first Monkey D Loopy operator. The initial surface is a zero-mutation read model over
existing runtime journals; the loopback API, control center, scheduler, and guarded controls build
on the same derived state.

```ts
import { readRun, listRuns } from "@loopyc/operator";

const run = readRun("/path/to/standalone-artifact", "default");
console.log(run.status, run.integrity, run.source.events);
```

`events.jsonl` remains the source of truth. Inspection verifies the checksum chain, derives state
from committed events, never acquires the runtime lock, and never rewrites old journals. Torn tails,
corruption, truncation, uncertain effects, live locks, and newer schemas are visible and cannot be
reported as healthy.

```bash
loopyd install ./out/my-loop/standalone   # import only; artifact remains independent
loopyd handoff my-loop operator --reason "host timer disabled"
loopyd step my-loop --run-id check-1
loopyd pause my-loop --run-id check-1 --reason "maintenance"
loopyd resume my-loop --run-id check-1 --reason "maintenance complete"
loopyd up --background                    # macOS/Linux detached local process
loopyd status
loopyd ui                                 # print the token bootstrap URL
loopyd down                               # graceful local shutdown
```

Windows supports `loopyd up` in the foreground; the CLI fails with an explicit diagnostic for
background mode. The service binds only to loopback, authenticates every route, exchanges the
tokenized bootstrap URL for an HttpOnly same-site cookie, rejects foreign origins and oversized
requests, and installs no background service during npm installation.

The operator scheduler stores one explicit authority and one active claim per loop. Cross-process
locks, atomic state, stale-claim recovery, durable cron/wake timestamps, a latest-only missed-run
policy, and append-only actor/surface/spec-hash audit events keep control attributable. All run
actions delegate to `@loopyc/runtime`; artifacts remain independently runnable and removable.
