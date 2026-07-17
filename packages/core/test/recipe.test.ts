import { describe, expect, it } from "vitest";
import { createRecipeCatalog, parseRecipeSource, type RecipeSource } from "../src/index.js";

const yaml = (id = "repo-health-doctor", schedule = "manual") => `loopspec: "0.1"
id: ${id}
pattern: react
inputs:
  repository: { type: string, required: true }
state:
  vars:
    done: { type: boolean, init: false }
body:
  - id: inspect
    kind: shell
    cmd: "echo done"
    on_done: { set: { done: true } }
terminate: { signal: state-predicate, until: "\${state.done == true}" }
caps: { max_iterations: 3 }
schedule: { mode: ${schedule}${schedule === "cron" ? ', cron: "0 * * * *"' : ""} }
artifacts: { include: ["output/report.md"], max_files: 10, max_bytes: 1000000 }
notify: { policy: on-change, channels: [] }
`;

const source = (name = "repo-health-doctor"): RecipeSource => ({
  manifest: {
    recipe: "1",
    name,
    title: "Repository health doctor",
    summary: "Fix one proven issue and stop.",
    inputs: [{ name: "repository", description: "Repository path", required: true }],
    schedule: { mode: "manual", rationale: "Run on demand after a failing check." },
    evidence: [{ name: "test result", source: "repository test command", grounding: "external", description: "Exact failing command output." }],
    expected_artifacts: [{ name: "report", path: "output/report.md", format: "markdown", description: "What changed and verification." }],
    safety: { rationale: "One issue per run.", destructive_actions: "approval-required", secrets: "No secrets belong in fixtures or reports." },
    minimum_score: 90,
    fixtures: {
      success: "fixtures/success.json",
      no_op: "fixtures/no-op.json",
      cap: "fixtures/cap.json",
      malformed_evidence: "fixtures/malformed.json",
      prompt_injection: "fixtures/prompt-injection.json",
    },
  },
  specYaml: yaml(name),
  readme: "# Run this recipe\n",
  fixtures: {
    "fixtures/success.json": "{}",
    "fixtures/no-op.json": "{}",
    "fixtures/cap.json": "{}",
    "fixtures/malformed.json": "{}",
    "fixtures/prompt-injection.json": "{}",
  },
});

describe("recipe contract", () => {
  it("accepts a complete recipe package", () => {
    const result = parseRecipeSource(source());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipe.spec.id).toBe("repo-health-doctor");
      expect(result.recipe.manifest.minimum_score).toBe(90);
    }
  });

  it("rejects unsafe paths before reading any files", () => {
    const value = source();
    (value.manifest as Record<string, unknown>).expected_artifacts = [
      { name: "escape", path: "../secret", format: "text", description: "bad" },
    ];
    const result = parseRecipeSource(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("relative path"))).toBe(true);
  });

  it("rejects manifest/spec/input/schedule and fixture drift", () => {
    const value = source();
    value.specYaml = yaml("different-id", "cron");
    ((value.manifest as { inputs: unknown[] }).inputs).push({ name: "extra", description: "Not in the spec", required: false });
    value.fixtures = {};
    const result = parseRecipeSource(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
      expect(messages).toContain("must match LoopSpec id");
      expect(messages).toContain("must exactly describe LoopSpec inputs");
      expect(messages).toContain("must match LoopSpec schedule mode");
      expect(messages).toContain("fixture file is missing");
    }
  });

  it("enforces the catalog quality floor in the manifest", () => {
    const value = source();
    (value.manifest as { minimum_score: number }).minimum_score = 89;
    const result = parseRecipeSource(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.path.endsWith("minimum_score"))).toBe(true);
  });

  it("requires verified product artifacts and notification policy to match the LoopSpec", () => {
    const value = source();
    value.specYaml = value.specYaml.replace('artifacts: { include: ["output/report.md"], max_files: 10, max_bytes: 1000000 }\n', "").replace("notify: { policy: on-change, channels: [] }\n", "");
    const result = parseRecipeSource(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
      expect(messages).toContain("must be explicitly allowlisted");
      expect(messages).toContain("notification policy");
    }
  });

  it("sorts valid recipes and rejects duplicate names", () => {
    const second = source("dependency-guardian");
    expect(createRecipeCatalog([source(), second]).ok).toBe(true);
    const valid = createRecipeCatalog([source(), second]);
    if (valid.ok) expect(valid.catalog.list().map((recipe) => recipe.manifest.name)).toEqual(["dependency-guardian", "repo-health-doctor"]);

    const duplicate = createRecipeCatalog([source(), source()]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.diagnostics.some((diagnostic) => diagnostic.code === "duplicate")).toBe(true);
  });
});
