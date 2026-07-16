/**
 * Verified recipe contract. A recipe is an opinionated product use case around a canonical
 * LoopSpec, not a second execution format. This module stays zero-I/O: callers provide file
 * contents, and receive a validated package or structured diagnostics.
 */
import { z } from "zod";
import { stringify as toYaml } from "yaml";
import { loadSpecFromYaml } from "./pipeline.js";
import type { LoopSpec } from "./types.js";
import { BUILTIN_RECIPE_SOURCES } from "./recipe-catalog.generated.js";

const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const INPUT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const relativePath = z.string().min(1).refine(
  (value) => !value.startsWith("/") && !value.startsWith("\\") && !value.split(/[\\/]+/).includes(".."),
  "must be a relative path without '..'"
);

export const RecipeManifestSchema = z.object({
  recipe: z.literal("1"),
  name: z.string().regex(NAME_RE, "must be kebab-case"),
  title: z.string().min(1),
  summary: z.string().min(1),
  inputs: z.array(z.object({
    name: z.string().regex(INPUT_RE, "must be a valid input name"),
    description: z.string().min(1),
    required: z.boolean(),
    secret: z.boolean().optional(),
    example: z.unknown().optional(),
  }).strict()),
  schedule: z.object({
    mode: z.enum(["manual", "cron", "watch", "forever"]),
    cadence: z.string().min(1).optional(),
    rationale: z.string().min(1),
  }).strict().superRefine((schedule, ctx) => {
    if (schedule.mode !== "manual" && !schedule.cadence) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cadence"], message: "is required for a recurring schedule" });
    }
  }),
  evidence: z.array(z.object({
    name: z.string().min(1),
    source: z.string().min(1),
    grounding: z.enum(["external", "structural", "agent"]),
    description: z.string().min(1),
  }).strict()).min(1),
  expected_artifacts: z.array(z.object({
    name: z.string().min(1),
    path: relativePath,
    format: z.enum(["json", "jsonl", "markdown", "text", "directory"]),
    description: z.string().min(1),
  }).strict()).min(1),
  safety: z.object({
    rationale: z.string().min(1),
    destructive_actions: z.enum(["none", "approval-required"]),
    secrets: z.string().min(1),
  }).strict(),
  minimum_score: z.number().int().min(90).max(100),
  fixtures: z.object({
    success: relativePath,
    no_op: relativePath,
    cap: relativePath,
    malformed_evidence: relativePath,
    prompt_injection: relativePath,
  }).strict(),
}).strict();

export type RecipeManifest = z.infer<typeof RecipeManifestSchema>;

export interface RecipeSource {
  /** Parsed JSON or the raw recipe.json text. */
  manifest: unknown;
  specYaml: string;
  readme: string;
  /** Recipe-relative fixture path → contents. */
  fixtures: Record<string, string>;
}

export interface Recipe {
  manifest: RecipeManifest;
  spec: LoopSpec;
  specYaml: string;
  readme: string;
  fixtures: Readonly<Record<string, string>>;
}

export interface RecipeDiagnostic {
  code: "manifest" | "spec" | "contract" | "duplicate";
  path: string;
  message: string;
}

export type RecipeParseResult =
  | { ok: true; recipe: Recipe; diagnostics: [] }
  | { ok: false; diagnostics: RecipeDiagnostic[] };

function parseManifest(raw: unknown): { manifest?: RecipeManifest; diagnostics: RecipeDiagnostic[] } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { diagnostics: [{ code: "manifest", path: "recipe.json", message: `invalid JSON: ${(error as Error).message}` }] };
    }
  }
  const parsed = RecipeManifestSchema.safeParse(value);
  if (parsed.success) return { manifest: parsed.data, diagnostics: [] };
  return {
    diagnostics: parsed.error.issues.map((issue) => ({
      code: "manifest",
      path: `recipe.json${issue.path.length ? `.${issue.path.join(".")}` : ""}`,
      message: issue.message,
    })),
  };
}

/** Validate one complete recipe package without touching disk. */
export function parseRecipeSource(source: RecipeSource): RecipeParseResult {
  const manifestResult = parseManifest(source.manifest);
  if (!manifestResult.manifest) return { ok: false, diagnostics: manifestResult.diagnostics };
  const manifest = manifestResult.manifest;
  const diagnostics: RecipeDiagnostic[] = [];

  const processed = loadSpecFromYaml(source.specYaml);
  if (!processed.spec) {
    for (const message of processed.parseErrors ?? []) diagnostics.push({ code: "spec", path: `${manifest.name}.loop.yaml`, message });
    for (const diagnostic of processed.validation?.diagnostics ?? []) {
      diagnostics.push({ code: "spec", path: diagnostic.path ?? `${manifest.name}.loop.yaml`, message: diagnostic.message });
    }
  } else {
    const spec = processed.spec;
    if (spec.id !== manifest.name) {
      diagnostics.push({ code: "contract", path: "recipe.json.name", message: `must match LoopSpec id '${spec.id}'` });
    }
    const manifestInputs = [...manifest.inputs.map((input) => input.name)].sort();
    const specInputs = Object.keys(spec.inputs ?? {}).sort();
    if (JSON.stringify(manifestInputs) !== JSON.stringify(specInputs)) {
      diagnostics.push({
        code: "contract",
        path: "recipe.json.inputs",
        message: `must exactly describe LoopSpec inputs (${specInputs.join(", ") || "none"})`,
      });
    } else {
      for (const input of manifest.inputs) {
        const specRequired = spec.inputs?.[input.name]?.required ?? false;
        if (input.required !== specRequired) {
          diagnostics.push({
            code: "contract",
            path: `recipe.json.inputs.${input.name}.required`,
            message: `must match LoopSpec required=${specRequired}`,
          });
        }
      }
    }
    const specMode = spec.schedule?.mode ?? "manual";
    if (manifest.schedule.mode !== specMode) {
      diagnostics.push({
        code: "contract",
        path: "recipe.json.schedule.mode",
        message: `must match LoopSpec schedule mode '${specMode}'`,
      });
    }
  }

  if (!source.readme.trim()) diagnostics.push({ code: "contract", path: "README.md", message: "must not be empty" });
  const fixturePaths = Object.values(manifest.fixtures);
  if (new Set(fixturePaths).size !== fixturePaths.length) {
    diagnostics.push({ code: "contract", path: "recipe.json.fixtures", message: "each scenario must use a distinct fixture" });
  }
  for (const path of fixturePaths) {
    if (!(path in source.fixtures)) diagnostics.push({ code: "contract", path, message: "fixture file is missing" });
  }
  const artifactPaths = manifest.expected_artifacts.map((artifact) => artifact.path);
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    diagnostics.push({ code: "contract", path: "recipe.json.expected_artifacts", message: "artifact paths must be unique" });
  }

  if (diagnostics.length || !processed.spec) return { ok: false, diagnostics };
  return {
    ok: true,
    recipe: {
      manifest,
      spec: processed.spec,
      specYaml: source.specYaml,
      readme: source.readme,
      fixtures: Object.freeze({ ...source.fixtures }),
    },
    diagnostics: [],
  };
}

export interface RecipeCatalog {
  list(): Recipe[];
  get(name: string): Recipe | undefined;
}

export type RecipeCatalogResult =
  | { ok: true; catalog: RecipeCatalog; diagnostics: [] }
  | { ok: false; diagnostics: RecipeDiagnostic[] };

/** Build a deterministic, name-sorted catalog and reject an invalid or ambiguous package set. */
export function createRecipeCatalog(sources: RecipeSource[]): RecipeCatalogResult {
  const recipes: Recipe[] = [];
  const diagnostics: RecipeDiagnostic[] = [];
  for (const source of sources) {
    const result = parseRecipeSource(source);
    if (result.ok) recipes.push(result.recipe);
    else diagnostics.push(...result.diagnostics);
  }
  const seen = new Set<string>();
  for (const recipe of recipes) {
    if (seen.has(recipe.manifest.name)) {
      diagnostics.push({ code: "duplicate", path: recipe.manifest.name, message: "recipe name is duplicated" });
    }
    seen.add(recipe.manifest.name);
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const sorted = [...recipes].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0));
  const byName = new Map(sorted.map((recipe) => [recipe.manifest.name, recipe]));
  return {
    ok: true,
    catalog: {
      list: () => [...sorted],
      get: (name) => byName.get(name),
    },
    diagnostics: [],
  };
}

const builtinResult = createRecipeCatalog([...BUILTIN_RECIPE_SOURCES]);
if (!builtinResult.ok) {
  throw new Error(`invalid built-in recipe catalog: ${builtinResult.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ")}`);
}

/** The embedded, release-versioned recipe catalog available to CLI and MCP consumers. */
export const BUILTIN_RECIPE_CATALOG: RecipeCatalog = builtinResult.catalog;

/** Instantiate a canonical recipe under a user-selected loop id and preserve its origin. */
export function instantiateRecipe(recipe: Recipe, id: string): string {
  const spec = structuredClone(recipe.spec);
  spec.id = id;
  spec.provenance = {
    ...spec.provenance,
    recipe: { name: recipe.manifest.name, version: recipe.manifest.recipe },
  };
  return toYaml(spec);
}
