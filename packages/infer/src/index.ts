/** @loopy/infer — deterministic FactPack extraction + draft LoopSpec scaffolding. */
import { basename } from "node:path";
import { detectKind, extractFactPack, type FactPack, type SourceKind } from "./factpack.js";
import { scaffoldYaml } from "./scaffold.js";

export * from "./factpack.js";
export { scaffoldYaml } from "./scaffold.js";

export interface InferResult {
  kind: SourceKind;
  factpack: FactPack;
  draftYaml: string;
}

function deriveId(filename: string): string {
  const base = basename(filename).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
  return base.replace(/^-+|-+$/g, "") || "inferred-loop";
}

/** Extract a FactPack from a script/journal and produce a draft LoopSpec for the skill to finish. */
export function inferScaffold(filename: string, content: string, id?: string): InferResult {
  const kind = detectKind(filename, content);
  const factpack = extractFactPack(content, kind);
  return { kind, factpack, draftYaml: scaffoldYaml(factpack, id ?? deriveId(filename)) };
}
