import { readFile, writeFile } from "node:fs/promises";
import { recommendWorkflow, designWorkflow, writeWorkflowDesign, formatRecommendation, type RecommendationReport } from "@loopyc/infer";
import { flagString } from "./args.js";

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 512_000) throw new Error("Input JSON exceeds 512 KB");
  return JSON.parse(text);
}
export async function cmdRecommend(goal: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  const briefFile = flagString(flags, "brief");
  const loaded = briefFile ? await readJson(briefFile) : {};
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) throw new Error("Brief must be a JSON object");
  const brief = {...loaded, ...(goal ? {goal} : {})};
  const provider = flagString(flags, "provider") ?? "offline";
  if (provider !== "jev" && provider !== "offline") throw new Error("--provider must be jev or offline");
  const report = await recommendWorkflow(brief, {provider, model: flagString(flags, "model")});
  const out = flagString(flags, "out");
  if (out) await writeFile(out, JSON.stringify(report, null, 2) + "\n", {flag: "wx", mode: 0o600});
  console.log(flags.json ? JSON.stringify(report, null, 2) : formatRecommendation(report));
  if (out && !flags.json) console.log(`\nSaved ${out}. Next: loopc design ${out} --select <candidate-id> --id <loop-id> --out <new-directory>`);
  return report.recommendedId ? 0 : 2;
}
export async function cmdDesign(file: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  const selection = flagString(flags, "select"), id = flagString(flags, "id"), out = flagString(flags, "out");
  if (!file || !selection || !id || !out) throw new Error("usage: loopc design <decision.json> --select <recipe:name|blueprint:name> --id <loop-id> --out <new-directory>");
  const report = await readJson(file) as RecommendationReport;
  if (!report || typeof report !== "object") throw new Error("Invalid decision report");
  const design = await designWorkflow(report, selection, id);
  await writeWorkflowDesign(out, report, design);
  console.log(`Created ${out}/loop.yaml and authoring handoff.\nMock verification passed; safety ${design.safety.total}/100 (${design.safety.grade}).\nRequired inputs: ${design.requiredInputs.join(", ") || "none"}. Review ${out}/README.md before compiling or running.`);
  return 0;
}
