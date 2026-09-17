import {describe,it,expect,vi} from "vitest";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {getBlueprint,loadSpecFromYaml} from "@loopyc/core";
import {run} from "../src/index.js";

describe("recommend/design CLI",()=>{
  it("completes a saved offline decision and explicit scaffold selection without overwrites",async()=>{
    const root=mkdtempSync(join(tmpdir(),"recommend-cli-"));
    const log=vi.spyOn(console,"log").mockImplementation(()=>{});
    try {
      const report=join(root,"decision.json"), out=join(root,"workflow");
      expect(await run(["recommend","dependency security policy","--provider","offline","--out",report,"--json"])).toBe(0);
      expect(JSON.parse(readFileSync(report,"utf8")).provider).toBe("offline");
      expect(await run(["design",report,"--select","recipe:dependency-guardian","--id","guard","--out",out])).toBe(0);
      expect(readFileSync(join(out,"loop.yaml"),"utf8")).toContain("id: guard");
      expect(await run(["verify",join(out,"loop.yaml"),"--fixtures",join(out,"fixtures.json")])).toBe(0);
      expect(await run(["compile",join(out,"loop.yaml"),"--target","standalone","--out",join(root,"compiled")])).toBe(0);
      await expect(run(["recommend","different","--out",report])).rejects.toThrow();
      await expect(run(["design",report,"--id","guard","--out",out])).rejects.toThrow("--select");
      await expect(run(["design",report,"--select","recipe:dependency-guardian","--id","guard","--out",out])).rejects.toThrow();
    } finally {log.mockRestore();rmSync(root,{recursive:true,force:true});}
  });
  it("returns a review-needed status when the offline catalog has no useful goal match",async()=>{
    const log=vi.spyOn(console,"log").mockImplementation(()=>{});
    try {
      expect(await run(["recommend","zzzzzzzz","--provider","offline","--json"])).toBe(2);
      expect(JSON.parse(log.mock.calls[0]![0]).recommendedId).toBeNull();
    } finally {log.mockRestore();}
  });
  it("saves repeatable refinement rounds and retains the current bytes offline",async()=>{
    const root=mkdtempSync(join(tmpdir(),"refine-cli-"));
    const log=vi.spyOn(console,"log").mockImplementation(()=>{});
    try {
      const current=getBlueprint("evaluator-optimizer")!.yaml;
      const proposal=loadSpecFromYaml(current).spec!;
      if(proposal.body[0]?.kind === "agent") proposal.body[0].prompt="Check factual claims against source evidence before editing.";
      const request=join(root,"request.json");
      writeFileSync(request,JSON.stringify({brief:{goal:"Improve factual accuracy"},current,proposals:[{id:"accuracy",yaml:JSON.stringify(proposal)}],feedback:"Check facts"}));
      const first=join(root,"r1"),second=join(root,"r2");
      expect(await run(["refine",request,"--out",first])).toBe(0);
      expect(await run(["refine",request,"--out",second,"--previous",join(first,"decision.json"),"--json"])).toBe(0);
      expect(readFileSync(join(second,"loop.yaml"),"utf8")).toBe(current);
      expect(JSON.parse(readFileSync(join(second,"decision.json"),"utf8")).report.round).toBe(2);
      await expect(run(["refine",request,"--out",second])).rejects.toThrow();
      expect(await run(["compile",join(second,"loop.yaml"),"--target","standalone","--out",join(root,"compiled")])).toBe(0);
    } finally {log.mockRestore();rmSync(root,{recursive:true,force:true});}
  });
  it("rejects unsupported providers",async()=>{
    await expect(run(["recommend","goal","--provider","invented"])).rejects.toThrow("provider");
  });
});
