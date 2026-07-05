/**
 * verify + scorecard. `verify` dry-runs the loop through the real @loopyc/runtime with
 * MOCKED effects to prove two hard guarantees — it is BOUNDED under caps and
 * DETERMINISTIC on replay — without any real side effects. `score` grades the loop.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, BUILTIN_HARNESS_NAMES, type AgentHarness, type RunResult, type RuntimeOptions } from "@loopyc/runtime";
import { terminationGrounding, type GroundingClass, type LoopSpec, type Step } from "@loopyc/core";
import { interpretLoop, sampleInputs } from "./interpret.js";

export interface VerifyReport {
  ok: boolean;
  bounded: boolean;
  terminatedNaturally: boolean;
  terminalStatus: string;
  iterations: number;
  reason?: string;
  resumeStable: boolean;
  deterministic: boolean;
  capsInjected: boolean;
  issues: { severity: "error" | "warning" | "info"; message: string }[];
}

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

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  );
}

/** Independent dry-run ceiling so a pathological max_iterations can't make verify hang. */
const VERIFY_CEILING = 1000;
const CAP_REASONS = new Set(["max_iterations", "token-budget", "usd-budget", "wallclock-budget", "no_progress"]);
const TERMINAL = new Set(["completed", "stopped", "paused", "failed"]);

/** Clone the spec with max_iterations capped at the verify ceiling. */
function cappedSpec(spec: LoopSpec): { spec: LoopSpec; capped: boolean } {
  if (spec.caps.max_iterations <= VERIFY_CEILING) return { spec, capped: false };
  return { spec: { ...spec, caps: { ...spec.caps, max_iterations: VERIFY_CEILING } }, capped: true };
}

/** All agent-harness names a spec can reference (body + exit action). */
function allHarnesses(spec: LoopSpec): Set<string> {
  const names = harnessNames(spec.body);
  if (spec.terminate.on_exit?.kind === "agent") names.add(spec.terminate.on_exit.harness ?? "llm");
  // mock every built-in harness (not just claude-code) so a dry-run never shells out to a real
  // agent CLI regardless of which tool the spec picks.
  for (const n of BUILTIN_HARNESS_NAMES) names.add(n);
  return names;
}

function dryOpts(spec: LoopSpec, cwd: string): RuntimeOptions {
  const mock = async () => ({}) as unknown;
  const mockHarness: AgentHarness = async () => ({});
  const agentHarnesses: Record<string, AgentHarness> = {};
  for (const name of allHarnesses(spec)) agentHarnesses[name] = mockHarness;
  return {
    cwd,
    now: freshClock(),
    maxBlockMs: Number.MAX_SAFE_INTEGER, // sleeps resolve instantly (no parking) for the dry-run
    delay: () => Promise.resolve(),
    autoApprove: true, // don't pause on breakpoints during a dry-run
    effects: { http: mock, shell: mock },
    agentHarnesses,
    inputs: sampleInputs(spec),
  };
}

async function dryRun(spec: LoopSpec, cwd: string): Promise<RunResult> {
  return createRuntime(interpretLoop(spec), dryOpts(spec, cwd)).run();
}

/** Drive the loop with a FRESH runtime per step — a real process restart between every
 * iteration — to genuinely exercise journal resume (not just reload a terminal journal). */
async function steppedRun(spec: LoopSpec, cwd: string): Promise<RunResult> {
  const ceiling = spec.caps.max_iterations + 2;
  let r: RunResult = { status: "waiting", iteration: 0, state: {} };
  for (let i = 0; i <= ceiling; i++) {
    r = await createRuntime(interpretLoop(spec), dryOpts(spec, cwd)).step();
    if (TERMINAL.has(r.status)) break;
  }
  return r;
}

/** A terminal that reflects a real stop (not a crash). 'failed' counts only with a cap reason. */
function cleanTerminal(r: RunResult): boolean {
  if (r.status === "completed" || r.status === "stopped" || r.status === "paused") return true;
  return r.status === "failed" && CAP_REASONS.has(r.reason ?? "");
}

export async function verifyLoop(spec0: LoopSpec, capsInjected: boolean): Promise<VerifyReport> {
  const { spec, capped } = cappedSpec(spec0);
  const base = mkdtempSync(join(tmpdir(), "loopy-verify-"));

  const rA = await dryRun(spec, join(base, "a")); // full run
  const rB = await dryRun(spec, join(base, "b")); // fresh full run → determinism
  const rStep = await steppedRun(spec, join(base, "c")); // restart-per-iteration → resume

  const bounded = cleanTerminal(rA) && rA.iteration <= spec.caps.max_iterations + 1;
  const terminatedNaturally = rA.status === "completed";
  const deterministic = stable(rA.state) === stable(rB.state) && rA.status === rB.status;
  const resumeStable = stable(rStep.state) === stable(rA.state) && rStep.status === rA.status;

  const issues: VerifyReport["issues"] = [];
  if (!bounded) {
    const why = rA.status === "failed" ? `crashed (${rA.reason ?? "error"})` : `status=${rA.status}, iterations=${rA.iteration}`;
    issues.push({ severity: "error", message: `loop did not reach a clean terminal state within caps — ${why}` });
  }
  if (!deterministic) issues.push({ severity: "error", message: "non-deterministic: two fresh dry-runs produced different final state" });
  if (!resumeStable)
    issues.push({ severity: "error", message: "resume-instability: restarting between every iteration produced a different result than a single run" });
  if (capsInjected) issues.push({ severity: "warning", message: "relying on auto-injected caps; set explicit caps (loopc verify --fix) for your cost tolerance" });
  if (capped)
    issues.push({ severity: "info", message: `verify used a reduced ceiling of ${VERIFY_CEILING} (spec max_iterations=${spec0.caps.max_iterations})` });
  if (!terminatedNaturally)
    issues.push({
      severity: "info",
      message: `did not reach 'completed' under empty mocks (ended '${rA.status}'${rA.reason ? ` via ${rA.reason}` : ""}); it relies on caps or real effect values to stop — confirm a real exit signal exists`,
    });

  const ok = bounded && deterministic && resumeStable;
  return {
    ok,
    bounded,
    terminatedNaturally,
    terminalStatus: rA.status,
    iterations: rA.iteration,
    reason: rA.reason,
    resumeStable,
    deterministic,
    capsInjected,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export interface Scorecard {
  total: number;
  grade: string;
  dimensions: { name: string; score: number; weight: number; note: string }[];
}

const SIGNAL_SCORE: Record<string, number> = {
  oracle: 1.0,
  "state-predicate": 0.85,
  "llm-judge": 0.55,
  "self-assess": 0.35,
};

/** A declared signal can't score above what its evidence chain supports: an exit
 *  predicate fed only by agent output is self-assessment regardless of its label. */
const GROUNDING_CEILING: Record<GroundingClass, number> = {
  external: 1.0, // http/shell evidence backs the exit
  structural: 0.9, // deterministic sequencing (e.g. an unconditional done flag)
  mixed: 0.7, // some evidence, some agent self-report
  agent: 0.4, // only the model's own report feeds the exit
  none: 1.0, // unwritten exit vars are a hard validator error, not a scoring concern
};

export function scoreLoop(spec: LoopSpec, report: VerifyReport): Scorecard {
  const dims: Scorecard["dimensions"] = [];

  const declared = SIGNAL_SCORE[spec.terminate.signal] ?? 0.3;
  // llm-judge/self-assess already price in un-grounded judgment; the ceiling applies
  // only to signals that claim external strength.
  const claimsStrength = spec.terminate.signal === "oracle" || spec.terminate.signal === "state-predicate";
  const grounding = terminationGrounding(spec);
  const sig = claimsStrength ? Math.min(declared, GROUNDING_CEILING[grounding.class]) : declared;
  const downgraded = sig < declared ? ` (downgraded: exit fed by agent output [${grounding.agentFed.join(", ")}])` : "";
  dims.push({
    name: "termination safety",
    score: sig,
    weight: 30,
    note: `signal: ${spec.terminate.signal} · grounding: ${grounding.class}${downgraded}`,
  });

  let caps = 0;
  if (!report.capsInjected) caps += 0.5;
  if (spec.caps.no_progress) caps += 0.25;
  if (spec.caps.budget) caps += 0.25;
  dims.push({
    name: "caps",
    score: caps,
    weight: 25,
    note: `${report.capsInjected ? "auto-injected" : "explicit"}${spec.caps.no_progress ? ", no_progress" : ""}${spec.caps.budget ? ", budget" : ""}`,
  });

  const obs = (spec.observe?.trace === "journal" ? 0.7 : 0) + (spec.observe?.hooks || spec.observe?.notify ? 0.3 : 0);
  dims.push({ name: "observability", score: obs, weight: 15, note: `trace: ${spec.observe?.trace ?? "none"}` });

  dims.push({ name: "resumability", score: report.resumeStable ? 1 : 0, weight: 15, note: report.resumeStable ? "stable" : "unstable" });
  dims.push({ name: "determinism", score: report.deterministic ? 1 : 0, weight: 15, note: report.deterministic ? "deterministic" : "non-deterministic" });

  const total = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0));
  const grade = total >= 90 ? "A" : total >= 80 ? "B" : total >= 70 ? "C" : total >= 60 ? "D" : "F";
  return { total, grade, dimensions: dims };
}

export function formatVerify(r: VerifyReport): string {
  const icon = { error: "✗", warning: "⚠", info: "ℹ" } as const;
  const head = r.ok ? "✓ verify PASSED" : "✗ verify FAILED";
  const lines = [
    head,
    `  bounded: ${r.bounded ? "✓" : "✗"}  deterministic: ${r.deterministic ? "✓" : "✗"}  resume-stable: ${r.resumeStable ? "✓" : "✗"}`,
    `  dry-run ended '${r.terminalStatus}' after ${r.iterations} iteration(s)${r.reason ? ` (${r.reason})` : ""}`,
    ...r.issues.map((i) => `  ${icon[i.severity]} ${i.message}`),
  ];
  return lines.join("\n");
}

export function formatScore(s: Scorecard): string {
  const bar = (x: number): string => "█".repeat(Math.round(x * 10)).padEnd(10, "░");
  const lines = [
    `Scorecard: ${s.total}/100  (${s.grade})`,
    ...s.dimensions.map((d) => `  ${bar(d.score)} ${d.name.padEnd(20)} ${Math.round(d.score * d.weight)}/${d.weight}  — ${d.note}`),
  ];
  return lines.join("\n");
}
