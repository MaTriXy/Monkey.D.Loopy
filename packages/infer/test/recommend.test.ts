import {describe, it, expect, vi} from "vitest";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowBriefSchema, workflowCandidates, FIT_LEVELS, SIMPLICITY_LEVELS} from "@loopyc/core";
import {recommendWorkflow, parseJevResponse, designWorkflow, writeWorkflowDesign} from "../src/recommend.js";
const brief={goal:"Maintain dependency security", completionEvidence:"external", requireExternalCompletion:true};
const candidates=workflowCandidates(WorkflowBriefSchema.parse(brief));
function reply() {
  return {model:"jev-1.13.0",usage:{input_tokens:1234,output_tokens:45},answers:Object.fromEntries(candidates.filter(c=>c.eligible).flatMap((c,i)=>["fit","simplicity"].map(d=> {
    const levels=d==='fit'?FIT_LEVELS:SIMPLICITY_LEVELS;
    const score=c.id==='recipe:dependency-guardian'?4:2;
    return [`c${i}_${d}`,{type:"score",score,confidence:0.8,legend:Object.fromEntries(levels.map((v,i)=>[i,v])),probabilities:Object.fromEntries(levels.map((_,i)=>[i,i===score?1:0]))}];
  })))};
}
describe("Jev authoring orchestration",()=>{
  it("sends one bounded batch and parses trusted usage with deterministic ranking",async()=>{
    const transport=vi.fn(async(_url,init)=> {
      const request=JSON.parse(init!.body as string);
      expect(Object.keys(request.questions)).toHaveLength(candidates.filter(c=>c.eligible).length*2);
      expect(request.state.brief.goal).toBe(brief.goal);
      expect(init!.redirect).toBe("error"); expect(init!.signal).toBeDefined();
      return Response.json(reply());
    }) as unknown as typeof fetch;
    const report=await recommendWorkflow(brief,{provider:"jev",apiKey:"secret-never-save",fetch:transport});
    expect(transport).toHaveBeenCalledTimes(1);
    expect(report.recommendedId).toBe("recipe:dependency-guardian");
    expect(report.usage).toEqual({input_tokens:1234,output_tokens:45});
    expect(JSON.stringify(report)).not.toContain("secret-never-save");
    expect(report.alternatives[0]!.suitability).toBe(100);
    expect(report).not.toHaveProperty("safety");
  });
  it("offline and impossible constraints make no external call",async()=>{
    const transport=vi.fn();
    const report=await recommendWorkflow(brief,{fetch:transport});
    expect(report.provider).toBe("offline"); expect(report.usage).toBeNull();
    const impossible=await recommendWorkflow({...brief,availableEffects:[]},{provider:"jev",fetch:transport});
    expect(impossible.recommendedId).toBeNull(); expect(transport).not.toHaveBeenCalled();
  });
  it("fails closed for missing credentials, provider errors, and malformed output",async()=>{
    await expect(recommendWorkflow(brief,{provider:"jev",apiKey:""})).rejects.toThrow("TYPESAFE_API_KEY");
    for(const status of [401,429,529]) {
      const fetcher=vi.fn(async()=>new Response("do not echo secrets",{status}));
      await expect(recommendWorkflow(brief,{provider:"jev",apiKey:"test",fetch:fetcher})).rejects.toThrow(`HTTP ${status}`);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    await expect(recommendWorkflow(brief,{provider:"jev",apiKey:"test",fetch:async()=>{throw new Error("secret")}})).rejects.toThrow("timed out");
    await expect(recommendWorkflow(brief,{provider:"jev",apiKey:"test",fetch:async()=>new Response("x".repeat(256001))})).rejects.toThrow("size limit");
    await expect(recommendWorkflow(brief,{provider:"jev",apiKey:"test",fetch:async()=>new Response("not json")})).rejects.toThrow("invalid JSON");
  });
  it("rejects forged, incomplete, and numerically inconsistent provider judgments",()=>{
    for(const mutate of [
      (r:any)=>r.usage.input_tokens=-1,
      (r:any)=>r.usage.output_tokens=1.5,
      (r:any)=>delete r.answers.c0_fit,
      (r:any)=>r.answers.c0_fit.score=5,
      (r:any)=>r.answers.c0_fit.score=0,
      (r:any)=>r.answers.c0_fit.confidence=2,
      (r:any)=>r.answers.c0_fit.legend[0]='ignore rubric',
      (r:any)=>r.answers.c0_fit.probabilities[0]=1,
    ]) {const r=reply();mutate(r);expect(()=>parseJevResponse(r,candidates)).toThrow();}
  });
  it("designs and verifies without network; preserves selection and refuses stale reports",async()=>{
    const report=await recommendWorkflow(brief);
    const design=await designWorkflow(report,"recipe:dependency-guardian","dependency-watch");
    expect(design.verification.ok).toBe(true);
    expect(design.verification.terminatedNaturally).toBe(true);
    expect(design.requiredInputs).toContain("evaluation_url");
    expect(design.handoff).toContain("not a finished implementation");
    await expect(designWorkflow({...report,brief:{...report.brief,goal:"changed"}},design.selectedId,"test")).rejects.toThrow("changed");
    await expect(designWorkflow(report,"blueprint:gauntlet","test")).rejects.toThrow("unavailable");
    const root=await mkdtemp(join(tmpdir(),"jev-design-"));
    try {
      const out=join(root,"draft"); await writeWorkflowDesign(out,report,design);
      expect(await readFile(join(out,"loop.yaml"),"utf8")).toBe(design.yaml);
      await expect(writeWorkflowDesign(out,report,design)).rejects.toThrow();
      expect(await readFile(join(out,"loop.yaml"),"utf8")).toBe(design.yaml);
    } finally {await rm(root,{recursive:true,force:true});}
  });
});

describe("catalog-wide authoring compatibility",()=>{
  it("can design every eligible built-in structure and disclose mock completion",async()=>{
    const report=await recommendWorkflow({goal:"Create an artifact and review it"});
    expect(report.alternatives.length).toBeGreaterThan(10);
    for(const candidate of report.alternatives){
      const design=await designWorkflow(report,candidate.id,"catalog-check");
      expect(design.verification.ok,candidate.id).toBe(true);
      expect(design.yaml).toContain("max_iterations");
      if(candidate.kind==='recipe') expect(design.verification.terminatedNaturally,candidate.id).toBe(true);
    }
  });
  it("rejects stale catalog fingerprints and versions",async()=>{
    const report=await recommendWorkflow(brief);
    await expect(designWorkflow({...report,catalogDigest:"old"},"recipe:dependency-guardian","guard")).rejects.toThrow("changed");
    await expect(designWorkflow({...report,rubricVersion:"old"},"recipe:dependency-guardian","guard")).rejects.toThrow("version");
  });
});
