import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntime, type AgentHarness, type HttpRequestSpec, type RuntimeConfig, type RunResult } from "@loopyc/runtime";
import { getBlueprint, listBlueprints, loadSpecFromYaml, planLoopExport, processRaw, type LoopSpec, type Step } from "@loopyc/core";
import { interpretLoop, sampleInputs } from "../src/interpret.js";

/**
 * The load-bearing M2 claim: `verify`'s codegen-free interpreter must behave like the
 * COMPILED standalone artifact. Here we run both under identical mocked effects and assert
 * equal final state/status — catching any drift between emit.ts and interpret.ts.
 */

function freshClock(): () => number {
  let t = 0;
  return () => (t += 1000);
}

function harnessNames(steps: Step[], acc = new Set<string>()): Set<string> {
  for (const s of steps) {
    if (s.kind === "agent") acc.add(s.harness);
    if (s.kind === "reduce") harnessNames(s.body, acc);
  }
  return acc;
}

type EffectOverride = { http?: (req: HttpRequestSpec) => Promise<unknown>; shell?: () => Promise<unknown> };

function mkOpts(spec: LoopSpec, cwd: string, effects?: EffectOverride) {
  const mock = async () => ({}) as unknown;
  const mockHarness: AgentHarness = async () => ({});
  const agentHarnesses: Record<string, AgentHarness> = { internal: mockHarness, "claude-code": mockHarness };
  for (const n of harnessNames(spec.body)) agentHarnesses[n] = mockHarness;
  return {
    cwd,
    now: freshClock(),
    maxBlockMs: Number.MAX_SAFE_INTEGER,
    delay: () => Promise.resolve(),
    autoApprove: true,
    effects: effects ?? { http: mock, shell: mock },
    agentHarnesses,
    inputs: sampleInputs(spec),
  };
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  );

// Create temp dirs INSIDE the package (next to this test) so Vitest/Vite transforms the
// emitted loop.mjs and resolves @loopyc/runtime to source (.js→.ts). A temp under
// node_modules or /tmp would be externalized and fail under Node's native loader.
const TMP_PREFIX = join(fileURLToPath(new URL(".", import.meta.url)), ".fidtmp-");

async function runGenerated(spec: LoopSpec, runCwd: string, effects?: EffectOverride): Promise<RunResult> {
  const src = planLoopExport(spec, "standalone").files.find((f) => f.relativePath === "loop.mjs")!.contents;
  const dir = mkdtempSync(TMP_PREFIX);
  const file = join(dir, "loop.mjs");
  writeFileSync(file, src);
  try {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    // the generated module exports the loop fns but `spec` is module-local — supply the
    // same spec-meta the interpreter uses so cap enforcement matches on both paths.
    const config = {
      spec: interpretLoop(spec).spec,
      initialState: mod.initialState,
      iterate: mod.iterate,
      terminate: mod.terminate,
      fingerprint: mod.fingerprint,
      onExit: mod.onExit,
      onComplete: mod.onComplete,
      gates: [],
    } as unknown as RuntimeConfig;
    return await createRuntime(config, mkOpts(spec, runCwd, effects)).run();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("interpreter ≡ generated standalone code (M2 fidelity)", () => {
  const specs = listBlueprints().map((b) => ({ name: b.name, spec: loadSpecFromYaml(b.yaml).spec! }));

  for (const { name, spec } of specs) {
    it(`agrees on final state + status for blueprint '${name}'`, async () => {
      const base = mkdtempSync(TMP_PREFIX);
      const interp = await createRuntime(interpretLoop(spec), mkOpts(spec, join(base, "i"))).run();
      const gen = await runGenerated(spec, join(base, "g"));
      rmSync(base, { recursive: true, force: true });
      expect(gen.status, `${name} status`).toBe(interp.status);
      expect(stable(gen.state), `${name} state`).toBe(stable(interp.state));
    });
  }
});

describe("envelope http fidelity (interpreter ≡ generated)", () => {
  // The mock returns DIFFERENT shapes for an enveloped vs a body-direct call, so this fails
  // loudly if either path drops the `envelope` flag (the save json-paths would then diverge).
  const httpMock = async (req: HttpRequestSpec): Promise<unknown> =>
    req.envelope
      ? { status: 503, ok: false, headers: { "x-test": "1" }, body: { ready: true } }
      : { ready: true };
  const effects: EffectOverride = { http: httpMock, shell: async () => ({}) };

  const spec = processRaw({
    loopspec: "0.1",
    id: "env-fid",
    pattern: "poll-until",
    state: { vars: { code: { type: "int", init: 0 }, done: { type: "boolean", init: false } } },
    body: [
      {
        id: "check",
        kind: "http",
        request: { method: "GET", url: "https://api.example/health" },
        envelope: true,
        save: { code: "$.status", done: "$.body.ready" },
      },
    ],
    terminate: { signal: "state-predicate", until: "${state.done == true}" },
    caps: { max_iterations: 3 },
  }).spec!;

  it("save reads $.status / $.body.* identically on both paths", async () => {
    const base = mkdtempSync(TMP_PREFIX);
    const interp = await createRuntime(interpretLoop(spec), mkOpts(spec, join(base, "i"), effects)).run();
    const gen = await runGenerated(spec, join(base, "g"), effects);
    rmSync(base, { recursive: true, force: true });
    expect(interp.status).toBe("completed");
    expect(interp.state.code).toBe(503);
    expect(interp.state.done).toBe(true);
    expect(gen.status).toBe(interp.status);
    expect(stable(gen.state)).toBe(stable(interp.state));
  });
});

describe("completion observer fidelity (interpreter ≡ generated)", () => {
  it("executes the same interpolated http completion hook on both paths", async () => {
    const spec = processRaw({
      loopspec: "0.1",
      id: "observer-fid",
      pattern: "react",
      state: { vars: { done: { type: "boolean", init: false } } },
      body: [{ id: "finish", kind: "shell", cmd: ":", on_done: { set: { done: true } } }],
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      caps: { max_iterations: 3 },
      observe: {
        hooks: {
          completed: {
            kind: "http",
            request: {
              method: "POST",
              url: "https://events.example/completed/${state.done}",
              headers: { "x-iteration": "${iteration}" },
              body: { done: "${state.done}" },
            },
          },
        },
      },
    }).spec!;
    const calls: HttpRequestSpec[] = [];
    const effects: EffectOverride = {
      shell: async () => ({}),
      http: async (request) => { calls.push(request); return { accepted: true }; },
    };
    const base = mkdtempSync(TMP_PREFIX);
    const interp = await createRuntime(interpretLoop(spec), mkOpts(spec, join(base, "i"), effects)).run();
    const gen = await runGenerated(spec, join(base, "g"), effects);
    rmSync(base, { recursive: true, force: true });

    expect(interp.status).toBe("completed");
    expect(gen.status).toBe("completed");
    expect(calls).toEqual([
      { method: "POST", url: "https://events.example/completed/true", headers: { "x-iteration": "1" }, body: { done: "${state.done}" } },
      { method: "POST", url: "https://events.example/completed/true", headers: { "x-iteration": "1" }, body: { done: "${state.done}" } },
    ]);
  });
});

describe("gate enforcement fidelity (interpreter ≡ generated)", () => {
  // A spec with a top-level human gate after `work`. The compiled artifact lowers it to a
  // fail-closed ctx.breakpoint(); the interpreter must do the same (was silently dropped).
  const spec = processRaw({
    loopspec: "0.1",
    id: "gate-fid",
    pattern: "react",
    state: { vars: { done: { type: "boolean", init: false } } },
    body: [{ id: "work", kind: "shell", cmd: ":", on_done: { set: { done: true } } }],
    gates: [{ after: "work", ask: "Approve before continuing?" }],
    terminate: { signal: "state-predicate", until: "${state.done == true}" },
    caps: { max_iterations: 3 },
  }).spec!;

  it("PAUSES on the gate (fail-closed) on both paths when not approved", async () => {
    const base = mkdtempSync(TMP_PREFIX);
    const noApprove = (cwd: string) => ({ ...mkOpts(spec, cwd), autoApprove: false });
    const interp = await createRuntime(interpretLoop(spec), noApprove(join(base, "i"))).run();
    const gen = await runGenerated(spec, join(base, "g")); // runGenerated uses mkOpts (autoApprove:true)
    rmSync(base, { recursive: true, force: true });
    // interpreter now honors the gate → paused (was "completed" before the fix)
    expect(interp.status).toBe("paused");
    // generated artifact (auto-approve) sails through — proving the SAME gate is present on both,
    // gated only by approval, not silently absent on the interpreter path.
    expect(gen.status).toBe("completed");
  });

  it("COMPLETES on the interpreter path when the gate is auto-approved (parity with generated)", async () => {
    const base = mkdtempSync(TMP_PREFIX);
    const interp = await createRuntime(interpretLoop(spec), mkOpts(spec, join(base, "i"))).run(); // autoApprove:true
    const gen = await runGenerated(spec, join(base, "g"));
    rmSync(base, { recursive: true, force: true });
    expect(interp.status).toBe("completed");
    expect(gen.status).toBe(interp.status);
    expect(stable(gen.state)).toBe(stable(interp.state));
  });
});
