# @loopyc/core

The pure, zero-I/O brain of [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy) — a
factory for runnable, crash-resumable agent loops.

This package holds the **LoopSpec IR** (one YAML document describing a bounded agent loop), the
safe expression engine, the **two-tier validator** (hard gates that refuse unbounded or
un-runnable loops; soft rules that downgrade the score), **termination grounding** analysis
(who actually feeds the exit predicate — external evidence or the agent's own report), the
planner with its compile-target adapters, and the blueprint catalog.

```ts
import { loadSpecFromYaml, terminationGrounding } from "@loopyc/core";

const r = loadSpecFromYaml(yamlSource);
if (r.validation?.ok) console.log(terminationGrounding(r.spec!).class); // "external" | "agent" | ...
```

Most users want the CLI instead: `npm i -g @loopyc/cli` → `loopc`.
See the [LoopSpec reference](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/docs/loopspec.md).
