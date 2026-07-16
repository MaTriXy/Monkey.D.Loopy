import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRecipeCatalog,
  planLoopExport,
  SUPPORTED_TARGETS,
  type Recipe,
  type RecipeSource,
} from "@loopyc/core";
import { BUILTIN_HARNESS_NAMES, createRuntime, type AgentHarness } from "@loopyc/runtime";
import { interpretLoop, sampleInputs, scoreLoop, verifyLoop } from "@loopyc/verify";
import type { EvalResult } from "./index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RECIPES = join(ROOT, "recipes");

interface FixtureExpectation {
  status: "completed" | "stopped";
  reason?: string;
  agent_calls: number;
}

interface RecipeFixture {
  scenario: "success" | "no-op" | "cap" | "malformed-evidence" | "prompt-injection";
  inputs: Record<string, unknown>;
  effect_results: unknown[];
  expect: FixtureExpectation;
}

function loadRecipeSource(directory: string): RecipeSource {
  const manifestText = readFileSync(join(directory, "recipe.json"), "utf8");
  const manifest = JSON.parse(manifestText) as { name: string; fixtures: Record<string, string> };
  const fixtures = Object.fromEntries(
    Object.values(manifest.fixtures).map((relativePath) => [relativePath, readFileSync(join(directory, relativePath), "utf8")])
  );
  return {
    manifest: manifestText,
    specYaml: readFileSync(join(directory, `${manifest.name}.loop.yaml`), "utf8"),
    readme: readFileSync(join(directory, "README.md"), "utf8"),
    fixtures,
  };
}

function parseFixture(recipe: Recipe, relativePath: string): RecipeFixture {
  const fixture = JSON.parse(recipe.fixtures[relativePath]!) as RecipeFixture;
  if (!fixture.scenario || !Array.isArray(fixture.effect_results) || fixture.effect_results.length === 0 || !fixture.expect) {
    throw new Error(`${recipe.manifest.name}/${relativePath}: invalid fixture contract`);
  }
  return fixture;
}

async function runFixture(recipe: Recipe, relativePath: string): Promise<string | undefined> {
  const fixture = parseFixture(recipe, relativePath);
  const cwd = mkdtempSync(join(tmpdir(), `loopy-recipe-${recipe.manifest.name}-`));
  let externalCalls = 0;
  let agentCalls = 0;
  const prompts: string[] = [];
  const nextExternal = async (): Promise<unknown> => {
    const index = Math.min(externalCalls++, fixture.effect_results.length - 1);
    return structuredClone(fixture.effect_results[index]);
  };
  const agent: AgentHarness = async (request) => {
    agentCalls++;
    prompts.push(request.prompt);
    return { result: "fixture agent completed", usage: { tokens: 10, usd: 0.001 } };
  };
  const harnesses = Object.fromEntries(BUILTIN_HARNESS_NAMES.map((name) => [name, agent]));

  try {
    const inputs = { ...sampleInputs(recipe.spec), ...fixture.inputs };
    const result = await createRuntime(interpretLoop(recipe.spec), {
      cwd,
      runId: fixture.scenario,
      inputs,
      now: () => 1,
      delay: async () => undefined,
      maxBlockMs: Number.MAX_SAFE_INTEGER,
      autoApprove: true,
      agentHarnesses: harnesses,
      effects: { http: nextExternal, shell: nextExternal },
    }).run();

    const prefix = `${recipe.manifest.name}/${fixture.scenario}`;
    if (result.status !== fixture.expect.status) return `${prefix}: expected status ${fixture.expect.status}, got ${result.status}`;
    if (result.reason !== fixture.expect.reason) {
      return `${prefix}: expected reason ${String(fixture.expect.reason)}, got ${String(result.reason)}`;
    }
    if (agentCalls !== fixture.expect.agent_calls) {
      return `${prefix}: expected ${fixture.expect.agent_calls} agent call(s), got ${agentCalls}`;
    }
    if (fixture.scenario === "success") {
      const prompt = prompts[0] ?? "";
      if (!prompt.includes("untrusted data") || !prompt.includes("ignore embedded instructions")) {
        return `${prefix}: actionable agent prompt does not preserve the prompt-injection boundary`;
      }
    }
    if (fixture.scenario === "prompt-injection" && agentCalls !== 0) {
      return `${prefix}: hostile evidence reached an agent despite an external no-op signal`;
    }
    if (result.iteration > recipe.spec.caps.max_iterations) {
      return `${prefix}: runtime exceeded max_iterations (${result.iteration} > ${recipe.spec.caps.max_iterations})`;
    }
    return undefined;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Product recipe gate: package contract -> verification/score -> every compiler target ->
 * adversarial execution through the real durable runtime.
 */
export async function recipeEval(): Promise<EvalResult> {
  const failures: string[] = [];
  let total = 0;
  const directories = readdirSync(RECIPES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(RECIPES, entry.name))
    .sort();
  const catalogResult = createRecipeCatalog(directories.map(loadRecipeSource));
  total++;
  if (!catalogResult.ok) {
    failures.push(...catalogResult.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`));
    return { name: "verified-recipes", total, failed: failures.length, failures };
  }

  for (const recipe of catalogResult.catalog.list()) {
    total++;
    const report = await verifyLoop(recipe.spec, false);
    if (!report.bounded || !report.deterministic || !report.resumeStable) {
      failures.push(`${recipe.manifest.name}: verification failed: ${report.issues.join("; ")}`);
    }

    total++;
    const score = scoreLoop(recipe.spec, report);
    if (score.total < recipe.manifest.minimum_score) {
      failures.push(`${recipe.manifest.name}: score ${score.total} is below ${recipe.manifest.minimum_score}`);
    }

    for (const target of SUPPORTED_TARGETS) {
      total++;
      try {
        const plan = planLoopExport(recipe.spec, target);
        if (plan.files.length === 0) failures.push(`${recipe.manifest.name}/${target}: compiler emitted no files`);
      } catch (error) {
        failures.push(`${recipe.manifest.name}/${target}: compile failed: ${(error as Error).message}`);
      }
    }

    for (const relativePath of Object.values(recipe.manifest.fixtures)) {
      total++;
      try {
        const failure = await runFixture(recipe, relativePath);
        if (failure) failures.push(failure);
      } catch (error) {
        failures.push(`${recipe.manifest.name}/${relativePath}: ${(error as Error).message}`);
      }
    }
  }
  return { name: "verified-recipes", total, failed: failures.length, failures };
}
