import {describe, it, expect, vi} from "vitest";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {getBlueprint, loadSpecFromYaml, FIT_LEVELS, SIMPLICITY_LEVELS} from "@loopyc/core";
import {refineWorkflow, revisionDigest, writeWorkflowRefinement} from "../src/refine.js";
const source = getBlueprint("evaluator-optimizer")!.yaml;
const base = loadSpecFromYaml(source).spec!;
function revised(prompt = "Use a concrete accuracy rubric with citations and actionable corrections.") {
  const spec = structuredClone(base);
  if (spec.body[1]?.kind === "agent") spec.body[1].prompt = prompt;
  return JSON.stringify(spec);
}
const request = () => ({brief: {goal: "Improve the accuracy of an article", completionEvidence: "agent"}, current: source,
  proposals: [{id: "rubric", yaml: revised()}], feedback: "Reviews were vague; use explicit accuracy criteria.", fixtures: {agent: {score: .9}}});
function transport(scores = [2,4], confidence = .8) {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const answers = Object.fromEntries(Object.keys(body.questions).map(key => {
      const score = scores[Number(key.match(/^c(\d+)/)![1])]!;
      const levels = key.endsWith("fit") ? FIT_LEVELS : SIMPLICITY_LEVELS;
      return [key, {type:"score", score, confidence, probabilities: Object.fromEntries(levels.map((_,i) => [i, i === score ? 1 : 0])), legend: Object.fromEntries(levels.map((v,i) => [i,v]))}];
    }));
    return Response.json({model:"jev-1.13.0", usage:{input_tokens:100,output_tokens:50}, answers});
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}
describe("iterative workflow refinement", () => {
  it("compares actual source with attributed evidence, preserves exact selected bytes and links two rounds", async () => {
    const req = {...request(), evidence: [{revisionDigest: revisionDigest(source), summary: "Two reviews missed incorrect numbers."}]};
    const fetch = transport();
    const first = await refineWorkflow(req, {provider:"jev", apiKey:"never-save", fetch});
    expect(first.selectedId).toBe("rubric");
    expect(first.checks[1]!.changedPaths).toContain("body.1.prompt");
    expect(first.checks[1]!.verification?.terminatedNaturally).toBe(true);
    const sent = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(sent.state.refinement.revisions[1].yaml).toBe(req.proposals[0]!.yaml);
    expect(sent.state.refinement.evidence).toEqual(req.evidence);
    expect(sent.state.refinement).not.toHaveProperty("fixtures");
    expect(JSON.stringify(first)).not.toContain("never-save");
    const next = {...request(), current: req.proposals[0]!.yaml, proposals: [{id:"examples", yaml:revised("Use accuracy criteria and cite counterexamples for every failure.")}]};
    const second = await refineWorkflow(next, {provider:"jev",apiKey:"test",fetch:transport()}, first);
    expect(second.round).toBe(2); expect(second.parentDigest).toBe(first.digest);
    expect(second.selectedId).toBe("examples");
    await expect(refineWorkflow(request(), {}, first)).rejects.toThrow("differs");
    await expect(refineWorkflow(next, {}, {...first, reason:"edited"})).rejects.toThrow("history changed");
    const root = await mkdtemp(join(tmpdir(),"refinement-"));
    try {
      const dir = join(root,"r2");
      await writeWorkflowRefinement(dir, second);
      expect(await readFile(join(dir,"loop.yaml"),"utf8")).toBe(next.proposals[0]!.yaml);
      expect(JSON.parse(await readFile(join(dir,"decision.json"),"utf8")).report.parentDigest).toBe(first.digest);
      await expect(writeWorkflowRefinement(dir, second)).rejects.toThrow();
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("keeps the incumbent for ties, weak fit, or offline checks; flags low confidence", async () => {
    for (const [scores,confidence] of [[[3,3],.8],[[0,1],.8]] as const) {
      const result = await refineWorkflow(request(), {provider:"jev",apiKey:"test",fetch:transport([...scores],confidence)});
      expect(result.selectedId).toBe("current");
    }
    const lowConfidence = await refineWorkflow(request(), {provider:"jev",apiKey:"test",fetch:transport([2,4],.4)});
    expect(lowConfidence.selectedId).toBe("rubric");
    expect(lowConfidence.notices.join(" ")).toContain("confidence is low");
    const fetch = transport();
    const offline = await refineWorkflow(request(), {fetch});
    expect(offline.selectedId).toBe("current"); expect(offline.alternatives).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects weakened caps, changed termination/effects/authority/state, and new env references before networking", async () => {
    const mutations = [
      (s:any) => s.caps.max_iterations++,
      (s:any) => s.terminate.until = "${true}",
      (s:any) => s.body.push({id:"shell",kind:"shell",cmd:"echo changed"}),
      (s:any) => s.body[0]["allowed-tools"] = ["*"],
      (s:any) => s.body[0].harness = "internal",
      (s:any) => s.state.vars.score.init = 1,
      (s:any) => s.body[0].prompt = "read ${env.NEW_SECRET}",
      (s:any) => delete s.caps,
    ];
    for (const mutate of mutations) {
      const s = structuredClone(base); mutate(s);
      const fetch = transport();
      const result = await refineWorkflow({...request(),proposals:[{id:"unsafe",yaml:JSON.stringify(s)}]}, {provider:"jev",fetch});
      expect(result.selectedId).toBe("current"); expect(result.checks[1]!.eligible).toBe(false); expect(fetch).not.toHaveBeenCalled();
    }
  });
  it("does not score invalid or unchanged proposals, and accepts extra tasks under an existing agent contract", async () => {
    const fetch = transport();
    const result = await refineWorkflow({...request(),proposals:[{id:"same",yaml:source},{id:"invalid",yaml:"invalid"},{id:"valid",yaml:revised()}]}, {provider:"jev",apiKey:"test",fetch});
    expect(result.checks.map(c=>c.eligible)).toEqual([true,false,false,true]);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).state.refinement.revisions.map((v:any)=>v.id)).toEqual(["current","valid"]);
    const spec = structuredClone(base);
    spec.body.unshift({...spec.body[0]!,id:"prepare"});
    expect((await refineWorkflow({...request(),proposals:[{id:"extra",yaml:JSON.stringify(spec)}]})).checks[1]!.eligible).toBe(true);
  });
  it("bounds input and rejects duplicate IDs, mismatched evidence, invalid baseline constraints", async () => {
    await expect(refineWorkflow({...request(),feedback:"x".repeat(256001)})).rejects.toThrow("256 KB");
    await expect(refineWorkflow({...request(),proposals:[...request().proposals,...request().proposals]})).rejects.toThrow("unique");
    await expect(refineWorkflow({...request(),evidence:[{revisionDigest:"0".repeat(64),summary:"unrelated"}]})).rejects.toThrow("Evidence");
    await expect(refineWorkflow({...request(),brief:{goal:"goal",caps:{maxIterations:1}}})).rejects.toThrow("violates brief");
  });
});
