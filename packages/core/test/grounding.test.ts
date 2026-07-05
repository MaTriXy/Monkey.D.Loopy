import { describe, expect, it } from "vitest";
import { processRaw, terminationGrounding, type Step } from "../src/index.js";
import { listBlueprints, loadSpecFromYaml } from "../src/index.js";

/** Build the grounding input from a raw spec via the real pipeline. */
function ground(raw: unknown) {
  const r = processRaw(raw);
  expect(r.spec, JSON.stringify(r.validation?.errors ?? r.parseErrors)).toBeDefined();
  return terminationGrounding({ body: r.spec!.body as Step[], terminate: { until: r.spec!.terminate.until } });
}

const base = {
  loopspec: "0.1",
  id: "g",
  pattern: "react",
  state: { vars: { status: { type: "string", init: "" }, done: { type: "boolean", init: false } } },
  terminate: { signal: "state-predicate", until: "${state.status == 'ok'}" },
  caps: { max_iterations: 5 },
};

describe("termination grounding classification", () => {
  it("external: the exit var is saved by an http step", () => {
    const g = ground({
      ...base,
      body: [{ id: "c", kind: "http", request: { method: "GET", url: "https://x" }, save: { status: "$.state" } }],
    });
    expect(g.class).toBe("external");
    expect(g.externalFed).toEqual(["status"]);
  });

  it("agent: the exit var is saved only by an agent step", () => {
    const g = ground({
      ...base,
      body: [{ id: "a", kind: "agent", harness: "cli", prompt: "p", save: { status: "$.status" } }],
    });
    expect(g.class).toBe("agent");
    expect(g.agentFed).toEqual(["status"]);
  });

  it("mixed: agent and shell both feed the exit var", () => {
    const g = ground({
      ...base,
      body: [
        { id: "a", kind: "agent", harness: "cli", prompt: "p", save: { status: "$.status" } },
        { id: "s", kind: "shell", cmd: ":", save: { status: "$.stdout" } },
      ],
    });
    expect(g.class).toBe("mixed");
  });

  it("structural: an unconditional on_done set carries no evidence but no agent taint", () => {
    const g = ground({
      ...base,
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      body: [{ id: "a", kind: "agent", harness: "cli", prompt: "p", on_done: { set: { done: true } } }],
    });
    expect(g.class).toBe("structural");
  });

  it("taint flows through guards: a done flag gated on an agent-saved score is agent-fed", () => {
    const g = ground({
      ...base,
      state: { vars: { score: { type: "int", init: 0 }, done: { type: "boolean", init: false } } },
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      body: [
        { id: "grade", kind: "agent", harness: "llm", prompt: "score it", save: { score: "$.score" } },
        { id: "flag", kind: "shell", cmd: ":", when: "${state.score >= 90}", on_done: { set: { done: true } } },
      ],
    });
    expect(g.class).toBe("agent");
    expect(g.agentFed).toEqual(["done"]);
  });

  it("taint flows through guards: the same flag gated on a shell-saved code is external-fed", () => {
    const g = ground({
      ...base,
      state: { vars: { code: { type: "int", init: 1 }, done: { type: "boolean", init: false } } },
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      body: [
        { id: "t", kind: "shell", cmd: "npm test", save: { code: "$.code" } },
        { id: "flag", kind: "shell", cmd: ":", when: "${state.code == 0}", on_done: { set: { done: true } } },
      ],
    });
    expect(g.class).toBe("external");
  });

  it("iteration-only predicates are structural", () => {
    const g = ground({
      ...base,
      terminate: { signal: "state-predicate", until: "${iteration >= 3}" },
      body: [{ id: "w", kind: "shell", cmd: ":" }],
    });
    expect(g.class).toBe("structural");
    expect(g.usesIteration).toBe(true);
  });
});

describe("grounding honesty diagnostics", () => {
  it("warns ungrounded-exit when a state-predicate is fed only by agent output", () => {
    const r = processRaw({
      ...base,
      body: [{ id: "a", kind: "agent", harness: "cli", prompt: "p", save: { status: "$.status" } }],
    });
    expect(r.validation!.ok).toBe(true); // honesty guidance, never a hard gate
    expect(r.validation!.warnings.some((w) => w.code === "ungrounded-exit")).toBe(true);
  });

  it("does not warn when the exit is externally grounded", () => {
    const r = processRaw({
      ...base,
      body: [{ id: "s", kind: "shell", cmd: ":", save: { status: "$.stdout" } }],
    });
    expect(r.validation!.warnings.some((w) => w.code === "ungrounded-exit")).toBe(false);
  });

  it("does not warn on an honestly-declared self-assess exit (the label already prices it)", () => {
    const r = processRaw({
      ...base,
      terminate: { signal: "self-assess", until: "${state.status == 'ok'}" },
      caps: { max_iterations: 5, budget: { tokens: 1000, usd: 1, wallclock: "1h" } },
      body: [{ id: "a", kind: "agent", harness: "cli", prompt: "p", save: { status: "$.status" } }],
    });
    expect(r.validation!.warnings.some((w) => w.code === "ungrounded-exit")).toBe(false);
  });

  it("no shipped blueprint trips ungrounded-exit (they declare their weakness honestly)", () => {
    for (const bp of listBlueprints()) {
      const r = loadSpecFromYaml(bp.yaml);
      expect(
        r.validation!.warnings.some((w) => w.code === "ungrounded-exit"),
        `blueprint ${bp.name}`
      ).toBe(false);
    }
  });
});
