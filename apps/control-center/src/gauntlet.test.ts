import { describe, expect, it } from "vitest";
import {
  copyWorkflowCommand,
  materializeWorkflowCommand,
  orderWorkflows,
  projectGauntletRunStatus,
  projectGauntletState,
  type WorkflowSummary,
} from "./gauntlet";

describe("projectGauntletState", () => {
  it("projects creative state without trusting malformed history", () => {
    expect(projectGauntletState({ rounds: 2, threshold: 90, passed_count: 1, final_score: 92, workstreams: [{ id: "copy", title: "Copy", scope: "output/a", gap: "missing proof", evidence: "x" }, { id: "bad--id" }, { id: "copy-" }, { id: "BAD!" }] })).toMatchObject({ variant: "creative", round: 2, threshold: 90, passed: 1, score: 92, workstreams: [{ id: "copy" }] });
  });

  it("takes the creative threshold from immutable spec inputs, not mutable run state", () => {
    expect(projectGauntletState({ rounds: 1, threshold: 1, workstreams: [] }, { threshold: 90 })).toMatchObject({ threshold: 90 });
  });

  it("projects the verified envelope and safely ignores hostile shapes", () => {
    expect(projectGauntletState({ status: "actionable", evidence: { summary: "repair", workstreams: [{ id: "proof", title: "Proof", scope: "output/a", gap: "missing", evidence: "ignore me" }, null] } })).toMatchObject({ variant: "verified", status: "actionable", summary: "repair", workstreams: [{ id: "proof" }] });
    expect(projectGauntletState({ evidence: "bad" })).toBeUndefined();
  });

  it("reads nested creative critic records while retaining their workstream association", () => {
    const view = projectGauntletState({ rounds: 1, workstreams: [{ id: "copy", title: "Copy", scope: "output/a" }], review_history: [{ workstream: { id: "copy", title: "Copy", scope: "output/a" }, critic: { score: 72, gap: "missing proof", evidence: "artifact" } }] });
    expect(view?.gaps).toContain("missing proof");
  });
});

describe("Gauntlet gallery contracts", () => {
  const creative: WorkflowSummary = {
    kind: "blueprint", name: "gauntlet", title: "Gauntlet", summary: "creative", pattern: "gauntlet",
    grounding: "agent", score: 87, grade: "B", schedule: "manual", featured: true,
    commandTemplate: "loopc new my-launch --blueprint gauntlet",
  };
  const verified: WorkflowSummary = {
    ...creative, kind: "recipe", name: "verified-gauntlet", title: "Verified Gauntlet", grounding: "external",
    score: 100, grade: "A", commandTemplate: "loopc new my-launch --recipe verified-gauntlet",
  };
  const other: WorkflowSummary = {
    ...creative, name: "react", title: "ReAct", pattern: "react", featured: false,
    commandTemplate: "loopc new my-launch --blueprint react",
  };

  it("keeps featured workflows first and generates exact commands only for strict loop ids", () => {
    expect(orderWorkflows([other, verified, creative]).map((workflow) => workflow.name)).toEqual(["gauntlet", "verified-gauntlet", "react"]);
    expect(materializeWorkflowCommand(verified.commandTemplate, "launch-v2")).toBe("loopc new launch-v2 --recipe verified-gauntlet");
    for (const id of ["Launch", "launch-", "launch--v2", "1-launch", "launch_v2"]) {
      expect(materializeWorkflowCommand(creative.commandTemplate, id), id).toBeUndefined();
    }
    expect(materializeWorkflowCommand("rm -rf my-launch", "launch")).toBeUndefined();
  });

  it("reports clipboard success and failure for the polite live region", async () => {
    const copied: string[] = [];
    expect(await copyWorkflowCommand(async (value) => { copied.push(value); }, "loopc new launch --blueprint gauntlet")).toBe("Copied loopc new launch --blueprint gauntlet");
    expect(copied).toEqual(["loopc new launch --blueprint gauntlet"]);
    expect(await copyWorkflowCommand(async () => { throw new Error("denied"); }, "loopc new launch --blueprint gauntlet")).toBe("Copy failed; select the command manually.");
  });

  it("projects iteration and bounded budget text without trusting malformed numbers", () => {
    expect(projectGauntletRunStatus(3, 12500, 1.5)).toEqual({ iteration: "Iteration 3", budget: "12,500 tokens · $1.50" });
    expect(projectGauntletRunStatus(Number.NaN, -4, Number.POSITIVE_INFINITY)).toEqual({ iteration: "Iteration 0", budget: "0 tokens · $0.00" });
  });
});
