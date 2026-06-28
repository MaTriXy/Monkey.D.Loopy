import { describe, expect, it } from "vitest";
import { FIXTURES } from "../src/skill/fixtures.js";
import { aggregate, gradeSpec } from "../src/skill/grade.js";

// Deterministic per-PR gate for the skill-eval GRADER (live LLM authoring runs nightly).
describe("skill-eval grader", () => {
  it("every fixture's golden spec clears its bar", async () => {
    const grades = await Promise.all(FIXTURES.map((fx) => gradeSpec(fx, fx.golden)));
    for (const g of grades) {
      expect(g.pass, `${g.id}: ${g.notes.join("; ")} (score ${g.score} ${g.grade})`).toBe(true);
    }
    expect(aggregate(grades).pass).toBe(true);
  });

  it("fails a spec with the wrong pattern + a weak signal", async () => {
    const fx = FIXTURES.find((f) => f.id === "deploy-watch")!;
    const bad =
      'loopspec: "0.1"\nid: bad\npattern: react\nstate: { vars: { done: { type: boolean, init: false } } }\n' +
      'body:\n  - { id: w, kind: agent, harness: claude-code, prompt: "do", save: { done: "$.done" } }\n' +
      'terminate: { signal: self-assess, until: "${state.done == true}" }\ncaps: { max_iterations: 5 }\n';
    const g = await gradeSpec(fx, bad);
    expect(g.pass).toBe(false);
    expect(g.patternMatch).toBe(false);
    expect(g.signalTierOk).toBe(false);
  });
});
