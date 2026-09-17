import {describe,it,expect,vi} from "vitest";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
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
  it("rejects unsupported providers",async()=>{
    await expect(run(["recommend","goal","--provider","invented"])).rejects.toThrow("provider");
  });
});
