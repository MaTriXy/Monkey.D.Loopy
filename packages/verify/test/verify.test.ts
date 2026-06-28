import { describe, expect, it } from "vitest";
import { getBlueprint, listBlueprints, loadSpecFromYaml } from "@loopy/core";
import { scoreLoop, verifyLoop } from "../src/verify.js";

describe("verify (dry-run guarantees)", () => {
  it("every blueprint is bounded, deterministic, and resume-stable", async () => {
    for (const bp of listBlueprints()) {
      const r = loadSpecFromYaml(bp.yaml);
      expect(r.validation!.ok, bp.name).toBe(true);
      const report = await verifyLoop(r.spec!, r.capsInjected ?? false);
      expect(report.bounded, `${bp.name} bounded`).toBe(true);
      expect(report.deterministic, `${bp.name} deterministic`).toBe(true);
      expect(report.resumeStable, `${bp.name} resume-stable`).toBe(true);
      expect(report.ok, `${bp.name} ok`).toBe(true);
    }
  });

  it("map-reduce terminates naturally under empty mocks", async () => {
    const r = loadSpecFromYaml(getBlueprint("map-reduce")!.yaml);
    const report = await verifyLoop(r.spec!, r.capsInjected ?? false);
    expect(report.terminatedNaturally).toBe(true);
  });

  it("deploy-watch is bounded by caps, not natural termination, under empty mocks", async () => {
    const r = loadSpecFromYaml(getBlueprint("poll-until")!.yaml);
    const report = await verifyLoop(r.spec!, r.capsInjected ?? false);
    expect(report.ok).toBe(true);
    expect(report.terminatedNaturally).toBe(false);
  });
});

describe("verify catches a loop that would crash when compiled", () => {
  // reduce over a non-iterable: the interpreter (and the emitted `for...of`) both throw,
  // so verify must report it as NOT bounded — not silently pass.
  const crashing = `loopspec: "0.1"
id: crash
pattern: map-reduce
inputs: { n: { type: int, required: true } }
state: { vars: { done: { type: boolean, init: false } } }
body:
  - id: r
    kind: reduce
    over: "\${inputs.n}"
    as: item
    body:
      - id: w
        kind: shell
        cmd: "echo \${item}"
  - id: fin
    kind: shell
    cmd: ":"
    on_done: { set: { done: true } }
terminate: { signal: state-predicate, until: "\${state.done == true}" }
caps: { max_iterations: 5, on_cap_exceeded: exit-clean }
`;

  it("reports ok=false when the loop crashes (non-cap failure)", async () => {
    const r = loadSpecFromYaml(crashing);
    expect(r.validation!.ok).toBe(true); // structurally valid; the crash is a runtime fact
    const report = await verifyLoop(r.spec!, r.capsInjected ?? false);
    expect(report.bounded).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe("scorecard", () => {
  it("grades five weighted dimensions", async () => {
    const r = loadSpecFromYaml(getBlueprint("poll-until")!.yaml);
    const report = await verifyLoop(r.spec!, r.capsInjected ?? false);
    const card = scoreLoop(r.spec!, report);
    expect(card.total).toBeGreaterThan(0);
    expect(card.total).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(card.grade);
    expect(card.dimensions.length).toBe(5);
  });

  it("rewards explicit caps over auto-injected", async () => {
    const explicit = loadSpecFromYaml(getBlueprint("poll-until")!.yaml);
    const explicitReport = await verifyLoop(explicit.spec!, explicit.capsInjected ?? false);
    const explicitCard = scoreLoop(explicit.spec!, explicitReport);
    const capsDim = explicitCard.dimensions.find((d) => d.name === "caps")!;
    expect(capsDim.score).toBeGreaterThan(0.5); // explicit + no_progress + budget
  });
});
