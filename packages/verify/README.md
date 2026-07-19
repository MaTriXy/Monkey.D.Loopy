# @loopyc/verify

Verify-before-you-run for [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy) loops.

A codegen-free interpreter dry-runs a LoopSpec through the real `@loopyc/runtime` with **mocked
effects** — no network, no shell, no model calls — and proves it is **bounded**,
**deterministic** (two fresh runs converge), and **resume-stable** (a process restart between
every iteration changes nothing). Then a 0–100 **scorecard** grades termination safety
(including grounding — whether real evidence or the agent's own report decides when the loop
stops), caps, observability, resumability, and determinism.

```ts
import { verifyLoop, scoreLoop, type VerifyOptions } from "@loopyc/verify";

const options: VerifyOptions = {
  fixtures: { shell: { done: true }, http: { status: "green" } },
};
const report = await verifyLoop(spec, capsInjected, options);
const card = scoreLoop(spec, report); // { total: 100, grade: "A", dimensions: [...] }
```

Fixtures are cloned data returned by the dry-run mocks. They make realistic exit paths
reproducible without enabling network, shell, or model calls. Observer points require executable
evidence—an `observe.hooks.completed` action or an active top-level notification—not inert metadata.

Most users want the CLI instead: `npm i -g @loopyc/cli` →
`loopc verify spec.yaml --fixtures fixtures.json` · `loopc score spec.yaml --fixtures fixtures.json`.
