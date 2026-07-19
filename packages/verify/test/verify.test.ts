import { describe, expect, it } from "vitest";
import { getBlueprint, listBlueprints, loadSpecFromYaml } from "@loopyc/core";
import { formatScore, scoreLoop, verifyLoop } from "../src/verify.js";

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
  it("awards 100 only to an externally grounded oracle with an executable completion observer", async () => {
    const parsed = loadSpecFromYaml(`loopspec: "0.1"
id: perfect
pattern: react
state: { vars: { done: { type: boolean, init: false } } }
body:
  - id: check
    kind: shell
    cmd: "./trusted-check"
    save: { done: "$.done" }
terminate: { signal: oracle, until: "\${state.done == true}" }
caps:
  max_iterations: 3
  no_progress: { fingerprint: "\${state.done}", max_repeats: 2 }
  budget: { tokens: 1000, usd: 0.1, wallclock: 5m }
observe:
  trace: journal
  hooks:
    completed: { kind: shell, cmd: "./record-completion" }
`);
    expect(parsed.validation!.ok).toBe(true);
    const report = await verifyLoop(parsed.spec!, false, { fixtures: { shell: { done: true } } });
    const card = scoreLoop(parsed.spec!, report);
    expect(report.terminatedNaturally).toBe(true);
    expect(card.total).toBe(100);
    expect(card.dimensions.find((dimension) => dimension.name === "termination safety")?.note).toContain("grounding: external");
    expect(card.dimensions.find((dimension) => dimension.name === "observability")?.note).toContain("completed hook");
  });

  it("does not award observer points for inert observe.notify metadata", async () => {
    const parsed = loadSpecFromYaml(getBlueprint("poll-until")!.yaml.replace("  trace: journal", "  trace: journal\n  notify: { terminal: true }"));
    const card = scoreLoop(parsed.spec!, await verifyLoop(parsed.spec!, false));
    expect(card.dimensions.find((dimension) => dimension.name === "observability")?.score).toBe(0.7);
  });

  it("preserves fractional dimension points so the breakdown matches the total", () => {
    const output = formatScore({
      total: 91,
      grade: "A",
      dimensions: [
        { name: "termination safety", score: 0.85, weight: 30, note: "state predicate" },
        { name: "observability", score: 0.7, weight: 15, note: "journal" },
      ],
    });

    expect(output).toContain("25.5/30");
    expect(output).toContain("10.5/15");
    expect(output).not.toContain("26/30");
    expect(output).not.toContain("11/15");
  });

  it("grades five weighted dimensions", async () => {
    const r = loadSpecFromYaml(getBlueprint("poll-until")!.yaml);
    const report = await verifyLoop(r.spec!, r.capsInjected ?? false);
    const card = scoreLoop(r.spec!, report);
    expect(card.total).toBeGreaterThan(0);
    expect(card.total).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(card.grade);
    expect(card.dimensions.length).toBe(5);
  });

  it("downgrades a state-predicate label fed only by agent output to the agent ceiling", async () => {
    const dishonest = `loopspec: "0.1"
id: dishonest
pattern: react
state: { vars: { status: { type: string, init: "" } } }
body:
  - id: a
    kind: agent
    harness: cli
    prompt: "do the thing and report status"
    save: { status: "$.status" }
terminate: { signal: state-predicate, until: "\${state.status == 'ok'}" }
caps: { max_iterations: 5, budget: { tokens: 1000, usd: 1, wallclock: "1h" } }
`;
    // identical loop, but a shell check feeds the exit var instead of the agent's own report
    const honest = dishonest
      .replace("id: dishonest", "id: honest")
      .replace(/- id: a[\s\S]*?save: \{ status: "\$\.status" \}/, '- id: a\n    kind: shell\n    cmd: "./check.sh"\n    save: { status: "$.stdout" }');

    const d = loadSpecFromYaml(dishonest);
    const h = loadSpecFromYaml(honest);
    const dCard = scoreLoop(d.spec!, await verifyLoop(d.spec!, false));
    const hCard = scoreLoop(h.spec!, await verifyLoop(h.spec!, false));
    const dim = (c: typeof dCard) => c.dimensions.find((x) => x.name === "termination safety")!;
    expect(dim(dCard).score).toBe(0.4); // agent-fed ceiling
    expect(dim(hCard).score).toBe(0.85); // externally grounded keeps the declared strength
    expect(dCard.total).toBeLessThan(hCard.total);
    expect(dim(dCard).note).toContain("grounding: agent");
    expect(dim(hCard).note).toContain("grounding: external");
  });

  it("does not punish an honestly-declared llm-judge below its label", async () => {
    const judged = `loopspec: "0.1"
id: judged
pattern: evaluator-optimizer
state: { vars: { score: { type: int, init: 0 } } }
body:
  - id: grade
    kind: agent
    harness: llm
    prompt: "grade it"
    save: { score: "$.score" }
terminate: { signal: llm-judge, until: "\${state.score >= 90}" }
caps: { max_iterations: 5, budget: { tokens: 1000, usd: 1, wallclock: "1h" } }
`;
    const r = loadSpecFromYaml(judged);
    const card = scoreLoop(r.spec!, await verifyLoop(r.spec!, false));
    expect(card.dimensions.find((x) => x.name === "termination safety")!.score).toBe(0.55);
  });

  it("rewards explicit caps over auto-injected", async () => {
    const explicit = loadSpecFromYaml(getBlueprint("poll-until")!.yaml);
    const explicitReport = await verifyLoop(explicit.spec!, explicit.capsInjected ?? false);
    const explicitCard = scoreLoop(explicit.spec!, explicitReport);
    const capsDim = explicitCard.dimensions.find((d) => d.name === "caps")!;
    expect(capsDim.score).toBeGreaterThan(0.5); // explicit + no_progress + budget
  });
});
