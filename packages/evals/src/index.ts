/**
 * Eval harness — graders call the REAL factory code (processRaw / verifyLoop /
 * planLoopExport / node --check), so the evals measure the actual product, not a model.
 *
 *  - prop-pipeline:      fast-check generates valid-by-construction LoopSpecs that must
 *                        validate → verify (bounded/deterministic/resumable) → compile to
 *                        all targets → node --check (standalone+babysitter) → YAML round-trip
 *                        → planner byte-determinism.
 *  - capability-honesty: every capability a spec uses that a target can't fully enforce must
 *                        produce a warning; enforced ones must not.
 *  - validator-corpus:   a negative corpus where each malformed spec must fail with its code.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { stringify as toYaml } from "yaml";
import {
  CAPABILITY_MATRIX,
  capabilityWarnings,
  loadSpecFromYaml,
  planLoopExport,
  processRaw,
  SUPPORTED_TARGETS,
  usedCapabilities,
} from "@loopyc/core";
import { scoreLoop, verifyLoop } from "@loopyc/verify";
import { recipeEval } from "./recipe-eval.js";

export interface EvalResult {
  name: string;
  total: number;
  failed: number;
  failures: string[];
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  );
}

function nodeCheck(src: string): void {
  const dir = mkdtempSync(join(tmpdir(), "loopy-eval-"));
  const f = join(dir, "x.mjs");
  writeFileSync(f, src);
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- generator: valid-by-construction LoopSpecs -----------------------------
const validSpecArb = fc
  .record({
    id: fc.constantFrom("alpha", "beta", "gamma", "loop1", "wf", "x"),
    pattern: fc.constantFrom(
      "react",
      "plan-execute-reflect",
      "evaluator-optimizer",
      "loop-until-dry",
      "map-reduce",
      "poll-until",
      "cron"
    ),
    k: fc.integer({ min: 1, max: 4 }),
    extra: fc.array(fc.constantFrom("shell", "http", "agent"), { maxLength: 3 }),
    withSleep: fc.boolean(),
  })
  .map(({ id, pattern, k, extra, withSleep }) => {
    const body: Record<string, unknown>[] = extra.map((kind, i) => {
      const sid = `s${i}`;
      const when = i % 2 === 0 ? "${state.n >= 0}" : undefined;
      if (kind === "http") return { id: sid, kind: "http", request: { method: "GET", url: "https://example.test/x" }, when };
      if (kind === "agent") return { id: sid, kind: "agent", harness: "llm", prompt: "do work", when };
      return { id: sid, kind: "shell", cmd: "echo decorative", when };
    });
    if (withSleep) body.push({ id: "nap", kind: "sleep", for: "1s" });
    body.push({ id: "tick", kind: "shell", cmd: "echo", on_done: { incr: "n" } }); // writes the exit var
    return {
      loopspec: "0.1",
      id,
      pattern,
      state: { vars: { n: { type: "int", init: 0 } } },
      body,
      terminate: { signal: "state-predicate", until: `\${state.n >= ${k}}` },
      caps: { max_iterations: k + 5, on_cap_exceeded: "exit-clean" },
    };
  });

async function pipelineEval(): Promise<EvalResult> {
  const failures: string[] = [];
  const res = await fc.check(
    fc.asyncProperty(validSpecArb, async (raw) => {
      const r = processRaw(raw);
      if (!r.spec) throw new Error(`validate failed: ${JSON.stringify(r.validation?.errors ?? r.parseErrors)}`);
      const report = await verifyLoop(r.spec, r.capsInjected ?? false);
      if (!report.bounded || !report.deterministic || !report.resumeStable) {
        throw new Error(`verify not ok: ${JSON.stringify(report.issues)}`);
      }
      for (const t of SUPPORTED_TARGETS) {
        const a = planLoopExport(r.spec, t);
        const b = planLoopExport(r.spec, t);
        if (stable(a.files) !== stable(b.files)) throw new Error(`planner nondeterministic for ${t}`);
      }
      for (const [t, fname] of [["standalone", "loop.mjs"], ["babysitter", "process.mjs"]] as const) {
        const src = planLoopExport(r.spec, t).files.find((f) => f.relativePath === fname)!.contents;
        nodeCheck(src);
      }
      const rt = loadSpecFromYaml(toYaml(raw));
      if (!rt.spec) throw new Error(`YAML round-trip failed: ${JSON.stringify(rt.validation?.errors ?? rt.parseErrors)}`);
      return true;
    }),
    { numRuns: 40 }
  );
  if (res.failed) failures.push(`counterexample ${stable(res.counterexample)} — ${res.error}`);
  return { name: "prop-pipeline", total: res.numRuns, failed: res.failed ? 1 : 0, failures };
}

function capabilityEval(): EvalResult {
  const failures: string[] = [];
  const raw = {
    loopspec: "0.1",
    id: "capspec",
    pattern: "poll-until",
    inputs: { url: { type: "string", required: true } },
    state: { vars: { status: { type: "string", init: "" } } },
    body: [
      { id: "fetch", kind: "http", request: { method: "GET", url: "${inputs.url}" }, save: { status: "$.s" } },
      { id: "gate", kind: "breakpoint", ask: "ok?" },
      { id: "wait", kind: "sleep", for: "5m" },
    ],
    terminate: { signal: "state-predicate", until: "${state.status == 'done'}" },
    caps: {
      max_iterations: 10,
      no_progress: { fingerprint: "${state.status}", max_repeats: 3 },
      budget: { tokens: 1000, usd: 1, wallclock: "1h" },
      on_cap_exceeded: "breakpoint",
    },
    schedule: { mode: "forever" },
  };
  const r = processRaw(raw);
  if (!r.spec) return { name: "capability-honesty", total: 0, failed: 1, failures: [`spec invalid: ${JSON.stringify(r.validation?.errors)}`] };
  const used = [...usedCapabilities(r.spec)];
  let total = 0;
  for (const target of SUPPORTED_TARGETS) {
    const warns = capabilityWarnings(r.spec, target).join(" | ");
    for (const cap of used) {
      total++;
      const support = CAPABILITY_MATRIX[target][cap];
      const warned = warns.includes(`'${cap}'`);
      if (support === "enforced" && warned) failures.push(`${target}/${cap}: enforced but warned`);
      if (support !== "enforced" && !warned) failures.push(`${target}/${cap}: ${support} but NOT warned (silent downgrade)`);
    }
  }
  return { name: "capability-honesty", total, failed: failures.length, failures };
}

function negativeEval(): EvalResult {
  const base = {
    loopspec: "0.1",
    id: "n",
    pattern: "react",
    state: { vars: { done: { type: "boolean", init: false } } },
    body: [{ id: "w", kind: "shell", cmd: ":", on_done: { set: { done: true } } }],
    terminate: { signal: "state-predicate", until: "${state.done == true}" },
    caps: { max_iterations: 5 },
  };
  const corpus: [Record<string, unknown>, string][] = [
    [{ ...base, terminate: undefined }, "no-terminate"],
    [{ ...base, terminate: { signal: "state-predicate", until: "${1 == 1}" } }, "unreachable-exit"],
    [{ ...base, state: { vars: { done: { type: "nope", init: 0 } } } }, "bad-type"],
    [{ ...base, body: [{ id: "w", kind: "shell", cmd: ":" }, { id: "w", kind: "shell", cmd: ":" }] }, "dup-id"],
    [{ ...base, schedule: { mode: "cron" } }, "cron-missing"],
    [{ ...base, gates: [{ after: "ghost", ask: "?" }] }, "gate-ref"],
  ];
  const failures: string[] = [];
  for (const [raw, code] of corpus) {
    const r = processRaw(raw);
    const codes = r.parseErrors ? [`parse:${r.parseErrors.length}`] : (r.validation?.errors ?? []).map((e) => e.code);
    if (!codes.includes(code)) failures.push(`expected '${code}', got [${codes.join(", ")}]`);
  }
  return { name: "validator-negative-corpus", total: corpus.length, failed: failures.length, failures };
}

/**
 * grounding-honesty: a spec whose exit predicate is fed only by agent output must
 * (a) trip the ungrounded-exit warning when it wears a strong signal label, and
 * (b) score strictly below its externally-grounded twin — same loop, but a shell
 * check feeds the exit var. Guards the judge-quality measurement end to end.
 */
async function groundingEval(): Promise<EvalResult> {
  const failures: string[] = [];
  let total = 0;
  const mk = (exitWriter: Record<string, unknown>) => ({
    loopspec: "0.1",
    id: "g",
    pattern: "react",
    state: { vars: { status: { type: "string", init: "" } } },
    body: [exitWriter],
    terminate: { signal: "state-predicate", until: "${state.status == 'ok'}" },
    caps: { max_iterations: 5, budget: { tokens: 1000, usd: 1, wallclock: "1h" } },
  });
  const dishonest = processRaw(mk({ id: "a", kind: "agent", harness: "cli", prompt: "p", save: { status: "$.status" } }));
  const honest = processRaw(mk({ id: "s", kind: "shell", cmd: "./check.sh", save: { status: "$.stdout" } }));

  total++;
  if (!dishonest.validation?.warnings.some((w) => w.code === "ungrounded-exit")) {
    failures.push("agent-fed state-predicate did not trip ungrounded-exit");
  }
  total++;
  if (honest.validation?.warnings.some((w) => w.code === "ungrounded-exit")) {
    failures.push("externally-grounded exit tripped ungrounded-exit (false positive)");
  }
  total++;
  if (dishonest.spec && honest.spec) {
    const dCard = scoreLoop(dishonest.spec, await verifyLoop(dishonest.spec, false));
    const hCard = scoreLoop(honest.spec, await verifyLoop(honest.spec, false));
    if (!(dCard.total < hCard.total)) {
      failures.push(`agent-fed twin must score below grounded twin (got ${dCard.total} vs ${hCard.total})`);
    }
  } else {
    failures.push("grounding twins failed to build");
  }
  return { name: "grounding-honesty", total, failed: failures.length, failures };
}

export const ALL_EVALS: { name: string; run: () => Promise<EvalResult> }[] = [
  { name: "prop-pipeline", run: pipelineEval },
  { name: "capability-honesty", run: async () => capabilityEval() },
  { name: "validator-negative-corpus", run: async () => negativeEval() },
  { name: "grounding-honesty", run: groundingEval },
  { name: "verified-recipes", run: recipeEval },
];
