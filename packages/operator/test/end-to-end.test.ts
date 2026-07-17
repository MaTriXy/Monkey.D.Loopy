import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_RECIPE_CATALOG, loadSpecFromYaml, planLoopExport, terminationGrounding, type LoopSpec } from "@loopyc/core";
import type { RunResult } from "@loopyc/runtime";
import { indexArtifacts } from "../src/artifacts.js";
import { OperatorRunController } from "../src/controller.js";
import { EvolutionManager } from "../src/evolution.js";
import { NotificationDispatcher } from "../src/notifications.js";
import { OperatorRegistry, type LoopRegistration } from "../src/registry.js";
import { createOperatorServer } from "../src/server.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "loopy-release-proof-")); }

describe("0.5.0 competitive release proof", () => {
  it("compiles, operates, observes, notifies, evolves, displays, and rolls back an externally grounded recipe", async () => {
    const root = tmp();
    const recipe = BUILTIN_RECIPE_CATALOG.get("repo-health-doctor")!;
    const specYaml = recipe.specYaml.replace("channels: []", "channels: [ops]");
    const loaded = loadSpecFromYaml(specYaml);
    expect(loaded.spec).toBeTruthy();
    expect(terminationGrounding(loaded.spec!).class).toBe("external");

    const artifact = join(root, "compiled", "standalone");
    for (const file of planLoopExport(loaded.spec!, "standalone").files) {
      const path = join(artifact, file.relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.contents);
      if (file.executable) chmodSync(path, 0o755);
    }
    writeFileSync(join(artifact, "loop.source.yaml"), specYaml);

    const registry = new OperatorRegistry(join(root, "operator"));
    const installed = registry.install(artifact);
    expect(installed).toMatchObject({ id: "repo-health-doctor", target: "standalone", schedulerAuthority: "host" });

    const webhookBodies: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      webhookBodies.push(String(init?.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const notifier = new NotificationDispatcher(registry, {
      fetchImpl,
      env: { LOOPY_NOTIFY_OPS_URL: "https://hooks.example/loopy" },
      delay: async () => undefined,
    });
    const shellResults = [
      { status: "actionable", evidence: { finding: "externally verified repair required" } },
      { status: "complete", evidence: { verification: "external gate passed" } },
    ];
    let shellCall = 0;
    const runtimeOptions = () => ({
      inputs: { check_command: "trusted-check", report_path: "output/repo-health.md" },
      effects: { shell: async () => structuredClone(shellResults[Math.min(shellCall++, shellResults.length - 1)]) },
      agentHarnesses: {
        "claude-code": async () => {
          mkdirSync(join(artifact, "output"), { recursive: true });
          writeFileSync(join(artifact, "output", "repo-health.md"), "# Externally verified repair\n");
          return { result: "minimal repair complete", usage: { tokens: 120, usd: 0.02 } };
        },
      },
    });
    const onResult = async (loop: LoopRegistration, spec: LoopSpec, runId: string, result: RunResult) => {
      await notifier.dispatch(loop, spec, runId, result, indexArtifacts(loop.path, spec.artifacts, loop.id));
    };

    const firstController = new OperatorRunController({ registry, runtimeOptions, onResult });
    const first = await firstController.execute("repo-health-doctor", "step", { actor: "release-proof", surface: "cli", runId: "release-proof" });
    expect(first.status).toBe("waiting");

    // A fresh controller instance proves the durable journal can resume after the original host exits.
    const resumedController = new OperatorRunController({ registry, runtimeOptions, onResult });
    const resumed = await resumedController.execute("repo-health-doctor", "resume", { actor: "release-proof", surface: "cli", runId: "release-proof", reason: "restart recovery proof" });
    expect(resumed).toMatchObject({ status: "completed", iteration: 2 });
    expect(resumed.state).toMatchObject({ status: "complete", agent_runs: 1 });

    const products = indexArtifacts(artifact, loaded.spec!.artifacts, "repo-health-doctor");
    expect(products.files).toEqual([expect.objectContaining({ path: "output/repo-health.md", mime: expect.stringContaining("markdown") })]);
    expect(fetchImpl).toHaveBeenCalled();
    expect(webhookBodies.join("\n")).toContain("output/repo-health.md");
    expect(webhookBodies.join("\n")).not.toContain("Externally verified repair");

    const journalPath = join(artifact, ".loopy", "runs", "release-proof", "events.jsonl");
    const journalBeforeEvolution = readFileSync(journalPath, "utf8");
    let now = 1_700_000_000_000;
    const evolver = new EvolutionManager(registry, () => now++);
    const candidateYaml = specYaml.replace(
      "Diagnose repository health from an external check and perform a bounded repair.",
      "Diagnose repository health from external evidence and perform the smallest bounded repair.",
    );
    const candidate = await evolver.propose("repo-health-doctor", candidateYaml, { actor: "release-reviewer", surface: "cli" });
    expect(candidate.fixtures).toHaveLength(5);
    expect(candidate.fixtures.every((fixture) => fixture.passed)).toBe(true);
    expect(candidate.gates).toEqual([]);
    expect(readFileSync(join(artifact, "loop.source.yaml"), "utf8")).toBe(specYaml);
    expect(evolver.activate("repo-health-doctor", candidate.id, { actor: "release-reviewer", reason: "reviewed diff, score, grounding, and fixtures", surface: "cli" }).status).toBe("active");

    const server = createOperatorServer({ registry, controller: resumedController, notifier, evolver, token: "release-proof-token", port: 0 });
    try {
      const address = await server.start();
      const response = await fetch(`${address.url}/api/v1/loops`, { headers: { Authorization: `Bearer ${server.token}` } });
      expect(response.status).toBe(200);
      const overview = (await response.json() as { loops: Array<{ id: string; grounding: string; score: number; runs: Array<{ runId: string; status: string }>; artifacts: { files: Array<{ path: string }> }; revisions: Array<{ id: string; status: string }> }> }).loops[0]!;
      expect(overview).toMatchObject({ id: "repo-health-doctor", grounding: "external" });
      expect(overview.score).toBeGreaterThanOrEqual(90);
      expect(overview.runs).toContainEqual(expect.objectContaining({ runId: "release-proof", status: "completed" }));
      expect(overview.artifacts.files).toContainEqual(expect.objectContaining({ path: "output/repo-health.md" }));
      expect(overview.revisions).toContainEqual(expect.objectContaining({ id: candidate.id, status: "active" }));
    } finally {
      await server.stop();
    }

    expect(evolver.rollback("repo-health-doctor", { actor: "release-reviewer", reason: "complete rollback proof", surface: "cli" }).status).toBe("rolled-back");
    expect(readFileSync(join(artifact, "loop.source.yaml"), "utf8")).toBe(specYaml);
    expect(readFileSync(journalPath, "utf8")).toBe(journalBeforeEvolution);
  });
});
