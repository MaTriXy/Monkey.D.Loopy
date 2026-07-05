# @loopy/verify

Verify-before-you-run for [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy) loops.

A codegen-free interpreter dry-runs a LoopSpec through the real `@loopy/runtime` with **mocked
effects** — no network, no shell, no model calls — and proves it is **bounded**,
**deterministic** (two fresh runs converge), and **resume-stable** (a process restart between
every iteration changes nothing). Then a 0–100 **scorecard** grades termination safety
(including grounding — whether real evidence or the agent's own report decides when the loop
stops), caps, observability, resumability, and determinism.

```ts
import { verifyLoop, scoreLoop } from "@loopy/verify";

const report = await verifyLoop(spec, capsInjected);
const card = scoreLoop(spec, report); // { total: 96, grade: "A", dimensions: [...] }
```

Most users want the CLI instead: `npm i -g @loopy/cli` → `loopc verify · loopc score`.
