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
