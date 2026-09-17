/** Pure workflow selection policy. Model judgments never override eligibility. */
import { z } from "zod";
import { stringify } from "yaml";
import { listBlueprints, getBlueprint } from "./catalog.js";
import { BUILTIN_RECIPE_CATALOG, instantiateRecipe } from "./recipe.js";
import { loadSpecFromYaml } from "./pipeline.js";
import { terminationGrounding } from "./grounding.js";
import { CAPABILITY_MATRIX, planLoopExport } from "./plan/index.js";
import { isValidDuration, parseDuration } from "./duration.js";
import type { LoopSpec, Step } from "./types.js";

export const RECOMMEND_RUBRIC_VERSION = "1";
export const FIT_LEVELS = ["Does not meet the goal", "Needs substantial restructuring", "Useful with moderate adaptation", "Close fit with minor adaptation", "Direct fit for the goal"];
export const SIMPLICITY_LEVELS = ["Much unnecessary coordination", "Significant unnecessary coordination", "Some avoidable coordination", "Mostly appropriate coordination", "Minimal sufficient coordination"];
const positive = z.number().finite().positive();
export const WorkflowBriefSchema = z.object({
  goal: z.string().trim().min(1).max(6000),
  target: z.enum(["standalone", "babysitter", "claude-code", "claude-native", "n8n"]).default("standalone"),
  completionEvidence: z.enum(["external", "agent", "unknown"]).default("unknown"),
  availableEffects: z.array(z.enum(["agent", "shell", "http"])).max(3).optional(),
  requireExternalCompletion: z.boolean().default(false),
  requireRuntimeGuarantees: z.boolean().default(true),
  caps: z.object({
    maxIterations: positive.int().max(10000).optional(),
    tokens: positive.int().max(1e9).optional(),
    usd: positive.max(1e6).optional(),
    wallclock: z.string().max(30).refine((v) => isValidDuration(v) && parseDuration(v) > 0, "must be a positive duration").optional(),
  }).strict().default({}),
  priorities: z.object({fit: positive.max(100).default(3), simplicity: positive.max(100).default(1)}).strict().default({}),
}).strict();
export type WorkflowBrief = z.infer<typeof WorkflowBriefSchema>;
export interface WorkflowCandidate {
  id: string;
  name: string;
  kind: "recipe" | "blueprint";
  description: string;
  pattern: string;
  grounding: string;
  effects: string[];
  requiredInputs: string[];
  defaultCaps: LoopSpec["caps"];
  schedule: string;
  eligible: boolean;
  exclusions: string[];
  warnings: string[];
}

function source(id: string, loopId = "designed-loop"): string {
  const [kind, name, extra] = id.split(":");
  if (extra !== undefined) throw new Error("Invalid candidate ID");
  const recipe = kind === "recipe" ? BUILTIN_RECIPE_CATALOG.get(name!) : undefined;
  const blueprint = kind === "blueprint" ? getBlueprint(name!) : undefined;
  if (recipe) return instantiateRecipe(recipe, loopId);
  if (blueprint) return blueprint.yaml.replace(/^id:.*$/m, `id: ${loopId}`);
  throw new Error(`Unknown workflow candidate: ${id}`);
}

function effectKinds(spec: LoopSpec): string[] {
  const kinds = new Set<string>();
  const add = (kind: string) => {
    if (["agent", "shell", "http"].includes(kind)) kinds.add(kind);
  };
  const walk = (steps: Step[]) => {
    for (const step of steps) {
      add(step.kind);
      if (step.kind === "reduce") walk(step.body);
    }
  };
  walk(spec.body);
  if (spec.terminate.on_exit) add(spec.terminate.on_exit.kind);
  if (spec.observe?.hooks?.completed) add(spec.observe.hooks.completed.kind);
  return [...kinds].sort();
}

export function workflowCandidates(brief: WorkflowBrief): WorkflowCandidate[] {
  const entries = [
    ...BUILTIN_RECIPE_CATALOG.list().map((r) => ({id: `recipe:${r.manifest.name}`, name: r.manifest.name, kind: "recipe" as const, description: r.manifest.summary})),
    ...listBlueprints().map((b) => ({id: `blueprint:${b.name}`, name: b.name, kind: "blueprint" as const, description: b.description})),
  ];
  return entries.map((entry) => {
    const parsed = loadSpecFromYaml(source(entry.id));
    if (!parsed.spec || !parsed.validation?.ok) throw new Error(`Invalid catalog candidate: ${entry.id}`);
    const spec = parsed.spec;
    const grounding = terminationGrounding(spec).class;
    const effects = effectKinds(spec);
    const exclusions: string[] = [];
    if (brief.availableEffects) for (const effect of effects) {
      if (!brief.availableEffects.includes(effect as "agent" | "shell" | "http")) exclusions.push(`Requires unavailable effect: ${effect}`);
    }
    if (brief.requireExternalCompletion && grounding !== "external") exclusions.push("Completion is not externally grounded");
    if (brief.requireExternalCompletion && brief.completionEvidence !== "external") exclusions.push("External completion evidence must be supplied in the brief");
    if (brief.completionEvidence === "agent" && (grounding === "external" || grounding === "mixed")) exclusions.push("Requires external evidence; only agent judgment is available");
    if (brief.requireRuntimeGuarantees) for (const cap of ["journal", "replay", "max-iterations", "token-budget", "usd-budget", "wallclock-budget"] as const) {
      if (CAPABILITY_MATRIX[brief.target][cap] !== "enforced") exclusions.push(`${brief.target} cannot enforce ${cap}`);
    }
    const warnings = planLoopExport(spec, brief.target).warnings;
    if (brief.completionEvidence === "unknown") warnings.push("Completion evidence is unspecified; confirm it before execution.");
    if (!brief.availableEffects) warnings.push("Tool availability is unspecified; confirm required effects.");
    return {...entry, pattern: spec.pattern, grounding, effects, defaultCaps: spec.caps, schedule: spec.schedule?.mode ?? "manual",
      requiredInputs: Object.entries(spec.inputs ?? {}).filter(([, v]) => v.required && v.default === undefined).map(([k]) => k),
      eligible: exclusions.length === 0, exclusions, warnings};
  });
}

export interface CandidateAssessment { fit: number; simplicity: number; confidence: number | null }
export interface RankedWorkflow extends WorkflowCandidate {
  suitability: number;
  assessment: CandidateAssessment;
  explanation: string;
}
export function rankWorkflows(brief: WorkflowBrief, candidates: WorkflowCandidate[], assessments: Record<string, CandidateAssessment>): RankedWorkflow[] {
  const weights = brief.priorities;
  return candidates.filter((c) => c.eligible).map((candidate) => {
    const assessment = assessments[candidate.id];
    if (!assessment || ![assessment.fit, assessment.simplicity].every((v) => Number.isFinite(v) && v >= 0 && v <= 4)) throw new Error(`Missing or invalid assessment: ${candidate.id}`);
    const suitability = Math.round(100 * (assessment.fit * weights.fit + assessment.simplicity * weights.simplicity) / (4 * (weights.fit + weights.simplicity)));
    return {...candidate, assessment, suitability,
      explanation: `Fit ${assessment.fit.toFixed(2)}/4 × ${weights.fit}; simplicity ${assessment.simplicity.toFixed(2)}/4 × ${weights.simplicity}. Completion grounding: ${candidate.grounding}.`};
  }).sort((a, b) => b.suitability - a.suitability || a.id.localeCompare(b.id));
}

/** Explicitly labeled lexical baseline, not an AI recommendation or confidence estimate. */
export function offlineAssessments(brief: WorkflowBrief, candidates: WorkflowCandidate[]): Record<string, CandidateAssessment> {
  const words = [...new Set(brief.goal.toLowerCase().match(/[a-z]{3,}/g) ?? [])].filter((w) => !["the", "and", "with", "for", "our", "that"].includes(w));
  return Object.fromEntries(candidates.filter((c) => c.eligible).map((c) => {
    const text = `${c.name} ${c.description} ${c.pattern}`.toLowerCase();
    const matches = words.filter((w) => text.includes(w)).length;
    return [c.id, {fit: Math.min(4, matches), simplicity: c.pattern === "gauntlet" ? 1 : c.kind === "recipe" ? 4 : 3, confidence: null}];
  }));
}

export function scaffoldWorkflow(brief: WorkflowBrief, candidateId: string, id: string): {yaml: string; spec: LoopSpec; candidate: WorkflowCandidate; fixtures?: string} {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 100) throw new Error("Loop id must be kebab-case, at most 100 characters");
  const candidate = workflowCandidates(brief).find((c) => c.id === candidateId);
  if (!candidate?.eligible) throw new Error(`Candidate is unavailable: ${candidate?.exclusions.join("; ") ?? candidateId}`);
  const spec = loadSpecFromYaml(source(candidateId, id)).spec!;
  spec.meta = {...spec.meta, name: id, description: brief.goal};
  spec.target = {...spec.target, runtime: brief.target};
  if (spec.inputs?.goal) spec.inputs.goal.default = brief.goal;
  const caps = brief.caps;
  if (caps.maxIterations !== undefined) spec.caps.max_iterations = Math.min(spec.caps.max_iterations, caps.maxIterations);
  spec.caps.budget ??= {};
  for (const key of ["tokens", "usd"] as const) if (caps[key] !== undefined) spec.caps.budget[key] = Math.min(spec.caps.budget[key] ?? Infinity, caps[key]);
  if (caps.wallclock) {
    const existing = spec.caps.budget.wallclock;
    spec.caps.budget.wallclock = existing && parseDuration(existing) < parseDuration(caps.wallclock) ? existing : caps.wallclock;
  }
  const yaml = stringify(spec);
  const check = loadSpecFromYaml(yaml);
  if (!check.validation?.ok) throw new Error("Scaffold does not validate after applying constraints");
  const recipe = candidate.kind === "recipe" ? BUILTIN_RECIPE_CATALOG.get(candidate.name) : undefined;
  // Verification uses a constant terminal response, not the recipe regression sequence.
  const terminalEvidence = recipe
    ? JSON.parse(recipe.fixtures[recipe.manifest.fixtures.success]!).effect_results.at(-1)
    : undefined;
  const fixtures = recipe ? JSON.stringify({shell: terminalEvidence, http: terminalEvidence}, null, 2) : undefined;
  return {yaml, spec: check.spec!, candidate, fixtures};
}

export function workflowCatalogSources(): string[] {
  return [...BUILTIN_RECIPE_CATALOG.list().map((r) => r.specYaml), ...listBlueprints().map((b) => b.yaml)];
}
