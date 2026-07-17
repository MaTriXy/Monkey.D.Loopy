import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_RECIPE_CATALOG,
  CAPABILITY_MATRIX,
  SUPPORTED_TARGETS,
  loadSpecFromYaml,
  parseDuration,
  terminationGrounding,
  usedCapabilities,
  type LoopSpec,
} from "@loopyc/core";
import { BUILTIN_HARNESS_NAMES, createRuntime, type AgentHarness } from "@loopyc/runtime";
import { interpretLoop, sampleInputs, scoreLoop, verifyLoop } from "@loopyc/verify";
import { listRuns } from "./read-model.js";
import { OperatorRegistry } from "./registry.js";

export type RevisionStatus = "candidate" | "active" | "rejected" | "rolled-back" | "superseded";

export interface SemanticChange {
  path: string;
  before: string;
  after: string;
}

export interface EvolutionGate {
  code: string;
  severity: "fatal" | "waiver-required";
  message: string;
}

export interface FixtureGateResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface CandidateRecord {
  schemaVersion: 1;
  id: string;
  loopId: string;
  status: RevisionStatus;
  createdAt: number;
  updatedAt: number;
  baseSpecHash: string;
  candidateSpecHash: string;
  baseScore?: number;
  candidateScore?: number;
  baseGrounding?: string;
  candidateGrounding?: string;
  changes: SemanticChange[];
  gates: EvolutionGate[];
  fixtures: FixtureGateResult[];
  evidence: { recentRuns: Array<{ runId: string; status: string; integrity: string; iteration: number }> };
  decision?: { actor: string; reason: string; at: number; waivers: string[] };
}

interface ActivePointer {
  schemaVersion: 1;
  candidateId?: string;
  specHash: string;
  previousCandidateId?: string;
  updatedAt: number;
}

function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function bounded(value: unknown): string {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

function atomicText(path: string, contents: string, mode = 0o600): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, contents, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

function atomicJson(path: string, value: unknown): void { atomicText(path, `${JSON.stringify(value, null, 2)}\n`); }

function changes(before: unknown, after: unknown, path = ""): SemanticChange[] {
  if (Object.is(before, after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before as object), ...Object.keys(after as object)])].sort();
    return keys.flatMap((key) => changes((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], path ? `${path}.${key}` : key));
  }
  return [{ path: path || "(root)", before: bounded(before), after: bounded(after) }];
}

function envRefs(spec: LoopSpec): Set<string> {
  return new Set([...JSON.stringify(spec).matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!));
}

function regressionGates(base: LoopSpec, candidate: LoopSpec, baseScore: number, candidateScore: number): EvolutionGate[] {
  const gates: EvolutionGate[] = [];
  const waiver = (code: string, message: string) => gates.push({ code, severity: "waiver-required", message });
  const signalRank: Record<string, number> = { oracle: 4, "state-predicate": 3, "llm-judge": 2, "self-assess": 1 };
  if ((signalRank[candidate.terminate.signal] ?? 0) < (signalRank[base.terminate.signal] ?? 0)) waiver("termination-signal", "candidate weakens the declared termination signal");
  const groundingRank: Record<string, number> = { external: 5, structural: 4, mixed: 3, agent: 2, unknown: 1 };
  const baseGrounding = terminationGrounding(base).class;
  const candidateGrounding = terminationGrounding(candidate).class;
  if ((groundingRank[candidateGrounding] ?? 0) < (groundingRank[baseGrounding] ?? 0)) waiver("termination-grounding", `termination grounding drops from ${baseGrounding} to ${candidateGrounding}`);
  if (candidate.caps.max_iterations > base.caps.max_iterations) waiver("max-iterations", "candidate increases max_iterations");
  if (base.caps.no_progress && !candidate.caps.no_progress) waiver("no-progress-removed", "candidate removes no-progress protection");
  if (base.caps.no_progress && candidate.caps.no_progress && candidate.caps.no_progress.max_repeats > base.caps.no_progress.max_repeats) waiver("no-progress-weakened", "candidate allows more repeated fingerprints");
  if (base.caps.on_cap_exceeded !== "breakpoint" && candidate.caps.on_cap_exceeded === "breakpoint") waiver("cap-action", "candidate changes a terminal cap action into a resumable breakpoint");
  for (const meter of ["tokens", "usd"] as const) {
    const before = base.caps.budget?.[meter];
    const after = candidate.caps.budget?.[meter];
    if (before != null && (after == null || after > before)) waiver(`budget-${meter}`, `candidate removes or increases the ${meter} budget`);
  }
  const beforeWall = base.caps.budget?.wallclock ? parseDuration(base.caps.budget.wallclock) : undefined;
  const afterWall = candidate.caps.budget?.wallclock ? parseDuration(candidate.caps.budget.wallclock) : undefined;
  if (beforeWall != null && (afterWall == null || afterWall > beforeWall)) waiver("budget-wallclock", "candidate removes or increases the wallclock budget");
  const addedEnv = [...envRefs(candidate)].filter((name) => !envRefs(base).has(name));
  if (addedEnv.length) waiver("env-expansion", `candidate adds environment access: ${addedEnv.join(", ")}`);
  const baseIncludes = new Set(base.artifacts?.include ?? []);
  const addedArtifacts = (candidate.artifacts?.include ?? []).filter((path) => !baseIncludes.has(path));
  const removedExcludes = (base.artifacts?.exclude ?? []).filter((path) => !(candidate.artifacts?.exclude ?? []).includes(path));
  if (addedArtifacts.length || removedExcludes.length) waiver("artifact-expansion", `candidate expands artifact visibility (${[...addedArtifacts, ...removedExcludes].join(", ")})`);
  if ((candidate.artifacts?.max_files ?? 0) > (base.artifacts?.max_files ?? 0) || (candidate.artifacts?.max_bytes ?? 0) > (base.artifacts?.max_bytes ?? 0)) waiver("artifact-ceilings", "candidate increases artifact ceilings");
  const baseChannels = new Set(base.notify?.channels ?? []);
  const addedChannels = (candidate.notify?.channels ?? []).filter((channel) => !baseChannels.has(channel));
  if (addedChannels.length) waiver("notification-expansion", `candidate adds notification channels: ${addedChannels.join(", ")}`);
  if (candidateScore < baseScore) waiver("score-regression", `candidate score drops from ${baseScore} to ${candidateScore}`);
  const oldCapabilities = usedCapabilities(base);
  const capabilityRegressions: string[] = [];
  for (const capability of usedCapabilities(candidate)) {
    if (oldCapabilities.has(capability)) continue;
    for (const target of SUPPORTED_TARGETS) if (CAPABILITY_MATRIX[target][capability] !== "enforced") capabilityRegressions.push(`${capability}/${target}:${CAPABILITY_MATRIX[target][capability]}`);
  }
  if (capabilityRegressions.length) waiver("capability-expansion", `new capabilities degrade on targets: ${capabilityRegressions.join(", ")}`);
  return gates;
}

async function recipeFixtures(spec: LoopSpec): Promise<FixtureGateResult[]> {
  const recipeName = spec.provenance?.recipe?.name ?? (BUILTIN_RECIPE_CATALOG.get(spec.id) ? spec.id : undefined);
  if (!recipeName) return [];
  const recipe = BUILTIN_RECIPE_CATALOG.get(recipeName);
  if (!recipe) return [{ name: "recipe-catalog", passed: false, detail: `recipe '${recipeName}' is not installed` }];
  const results: FixtureGateResult[] = [];
  for (const [relativePath, raw] of Object.entries(recipe.fixtures)) {
    const fixture = JSON.parse(raw) as { scenario: string; inputs: Record<string, unknown>; effect_results: unknown[]; expect: { status: string; agent_calls: number } };
    const cwd = join(process.env.TMPDIR ?? "/tmp", `loopy-evolution-${process.pid}-${Date.now()}-${results.length}`);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    let effectCall = 0;
    let agentCalls = 0;
    const next = async () => structuredClone(fixture.effect_results[Math.min(effectCall++, fixture.effect_results.length - 1)]);
    const agent: AgentHarness = async () => { agentCalls++; return { result: "fixture agent completed", usage: { tokens: 10, usd: 0.001 } }; };
    try {
      const run = await createRuntime(interpretLoop(spec), {
        cwd,
        runId: fixture.scenario,
        inputs: { ...sampleInputs(spec), ...fixture.inputs },
        now: () => 1,
        delay: async () => undefined,
        maxBlockMs: Number.MAX_SAFE_INTEGER,
        autoApprove: true,
        agentHarnesses: Object.fromEntries(BUILTIN_HARNESS_NAMES.map((name) => [name, agent])),
        effects: { http: next, shell: next },
      }).run();
      const passed = run.status === fixture.expect.status && agentCalls === fixture.expect.agent_calls;
      results.push({ name: relativePath, passed, detail: passed ? undefined : `expected ${fixture.expect.status}/${fixture.expect.agent_calls} agent calls, got ${run.status}/${agentCalls}` });
    } catch (error) { results.push({ name: relativePath, passed: false, detail: (error as Error).message }); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  return results;
}

export class EvolutionManager {
  constructor(readonly registry: OperatorRegistry, private readonly now = () => Date.now()) {
    mkdirSync(registry.paths.revisions, { recursive: true, mode: 0o700 });
    chmodSync(registry.paths.revisions, 0o700);
  }

  private loopRoot(loopId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(loopId)) throw new Error(`invalid loop id '${loopId}'`);
    const path = join(this.registry.paths.revisions, loopId);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  }

  private candidateDir(loopId: string, candidateId: string): string {
    if (!/^candidate-[A-Za-z0-9._-]{1,160}$/.test(candidateId)) throw new Error(`invalid candidate id '${candidateId}'`);
    return join(this.loopRoot(loopId), candidateId);
  }
  private recordPath(loopId: string, candidateId: string): string { return join(this.candidateDir(loopId, candidateId), "record.json"); }

  private assertIdle(loopId: string, artifactPath: string, operation: "activate" | "roll back"): void {
    if (existsSync(this.registry.paths.scheduler)) {
      const state = JSON.parse(readFileSync(this.registry.paths.scheduler, "utf8")) as { loops?: Record<string, { active?: unknown }> };
      if (state.loops?.[loopId]?.active) throw new Error(`cannot ${operation} while the loop has an active operator run`);
    }
    if (listRuns(artifactPath).some((run) => run.integrity === "locked")) {
      throw new Error(`cannot ${operation} while the loop has an active host or standalone run`);
    }
  }

  read(loopId: string, candidateId: string): CandidateRecord {
    const path = this.recordPath(loopId, candidateId);
    if (!existsSync(path)) throw new Error(`candidate '${candidateId}' does not exist for '${loopId}'`);
    return JSON.parse(readFileSync(path, "utf8")) as CandidateRecord;
  }

  list(loopId: string): CandidateRecord[] {
    if (!this.registry.get(loopId)) throw new Error(`loop '${loopId}' is not installed`);
    const root = this.loopRoot(loopId);
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "record.json")))
      .map((entry) => this.read(loopId, entry.name)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async propose(loopId: string, candidateYaml: string, input: { actor?: string; surface?: "api" | "cli" } = {}): Promise<CandidateRecord> {
    const loop = this.registry.get(loopId);
    if (!loop) throw new Error(`loop '${loopId}' is not installed`);
    const sourcePath = join(loop.path, "loop.source.yaml");
    const baseYaml = readFileSync(sourcePath, "utf8");
    if (hashText(baseYaml) !== loop.specHash) throw new Error("active source changed since registration; reinstall before proposing evolution");
    const baseLoaded = loadSpecFromYaml(baseYaml);
    const candidateLoaded = loadSpecFromYaml(candidateYaml);
    const candidateHash = hashText(candidateYaml);
    const candidateId = `candidate-${this.now()}-${candidateHash.slice(0, 10)}`;
    const dir = this.candidateDir(loopId, candidateId);
    mkdirSync(dir, { mode: 0o700 });
    atomicText(join(dir, "base.yaml"), baseYaml);
    atomicText(join(dir, "candidate.yaml"), candidateYaml);
    const gates: EvolutionGate[] = [];
    let baseScore: number | undefined;
    let candidateScore: number | undefined;
    let baseGrounding: string | undefined;
    let candidateGrounding: string | undefined;
    let semanticChanges: SemanticChange[] = [];
    let fixtures: FixtureGateResult[] = [];
    if (!baseLoaded.spec) gates.push({ code: "base-invalid", severity: "fatal", message: "installed base source no longer validates" });
    if (!candidateLoaded.spec) gates.push({ code: "candidate-invalid", severity: "fatal", message: (candidateLoaded.parseErrors ?? candidateLoaded.validation?.errors.map((error) => error.message) ?? ["candidate does not validate"]).join("; ") });
    if (baseLoaded.spec && candidateLoaded.spec) {
      if (candidateLoaded.spec.id !== baseLoaded.spec.id) gates.push({ code: "loop-id", severity: "fatal", message: "candidate cannot change loop id" });
      const baseVerify = await verifyLoop(baseLoaded.spec, baseLoaded.capsInjected ?? false);
      const candidateVerify = await verifyLoop(candidateLoaded.spec, candidateLoaded.capsInjected ?? false);
      if (!candidateVerify.bounded || !candidateVerify.deterministic || !candidateVerify.resumeStable) gates.push({ code: "verification", severity: "fatal", message: candidateVerify.issues.join("; ") || "candidate verification failed" });
      baseScore = scoreLoop(baseLoaded.spec, baseVerify).total;
      candidateScore = scoreLoop(candidateLoaded.spec, candidateVerify).total;
      baseGrounding = terminationGrounding(baseLoaded.spec).class;
      candidateGrounding = terminationGrounding(candidateLoaded.spec).class;
      semanticChanges = changes(baseLoaded.spec, candidateLoaded.spec);
      gates.push(...regressionGates(baseLoaded.spec, candidateLoaded.spec, baseScore, candidateScore));
      fixtures = await recipeFixtures(candidateLoaded.spec);
      if (fixtures.some((fixture) => !fixture.passed)) gates.push({ code: "fixtures", severity: "fatal", message: "one or more representative recipe fixtures failed" });
    }
    const now = this.now();
    const record: CandidateRecord = {
      schemaVersion: 1, id: candidateId, loopId, status: "candidate", createdAt: now, updatedAt: now,
      baseSpecHash: loop.specHash, candidateSpecHash: candidateHash, baseScore, candidateScore, baseGrounding, candidateGrounding,
      changes: semanticChanges, gates, fixtures,
      evidence: { recentRuns: listRuns(loop.path).slice(-5).map((run) => ({ runId: run.runId, status: run.status, integrity: run.integrity, iteration: run.iteration })) },
    };
    atomicJson(join(dir, "record.json"), record);
    this.registry.appendAudit({ actor: input.actor ?? "operator", surface: input.surface ?? "api", action: "evolution.propose", outcome: gates.some((gate) => gate.severity === "fatal") ? "rejected" : "completed", loopId, specHash: loop.specHash, detail: { candidateId, candidateSpecHash: candidateHash, gates: gates.map((gate) => gate.code) } });
    return record;
  }

  reject(loopId: string, candidateId: string, input: { actor: string; reason: string; surface?: "api" | "cli" }): CandidateRecord {
    if (!input.reason.trim()) throw new Error("rejection requires a reason");
    const record = this.read(loopId, candidateId);
    if (record.status !== "candidate") throw new Error(`candidate is ${record.status}, not pending`);
    const next = { ...record, status: "rejected" as const, updatedAt: this.now(), decision: { actor: input.actor, reason: input.reason.trim(), at: this.now(), waivers: [] } };
    atomicJson(this.recordPath(loopId, candidateId), next);
    this.registry.appendAudit({ actor: input.actor, surface: input.surface ?? "api", action: "evolution.reject", outcome: "completed", loopId, specHash: record.baseSpecHash, detail: { candidateId, reason: input.reason.trim() } });
    return next;
  }

  activate(loopId: string, candidateId: string, input: { actor: string; reason: string; waivers?: string[]; surface?: "api" | "cli" }): CandidateRecord {
    if (!input.reason.trim()) throw new Error("activation requires a reason");
    const record = this.read(loopId, candidateId);
    if (record.status !== "candidate") throw new Error(`candidate is ${record.status}, not pending`);
    const fatal = record.gates.filter((gate) => gate.severity === "fatal");
    if (fatal.length) throw new Error(`candidate has fatal gates: ${fatal.map((gate) => gate.code).join(", ")}`);
    const waivers = new Set(input.waivers ?? []);
    const requiredWaivers = new Set(record.gates.filter((gate) => gate.severity === "waiver-required").map((gate) => gate.code));
    const unknownWaivers = [...waivers].filter((code) => !requiredWaivers.has(code));
    if (unknownWaivers.length) throw new Error(`candidate was given unknown waivers: ${unknownWaivers.join(", ")}`);
    const unwaived = record.gates.filter((gate) => gate.severity === "waiver-required" && !waivers.has(gate.code));
    if (unwaived.length) throw new Error(`candidate requires explicit waivers: ${unwaived.map((gate) => gate.code).join(", ")}`);
    const loop = this.registry.get(loopId);
    if (!loop || loop.specHash !== record.baseSpecHash) throw new Error("active spec changed after candidate evaluation; create a fresh candidate");
    this.assertIdle(loopId, loop.path, "activate");
    const source = join(loop.path, "loop.source.yaml");
    const baseYaml = readFileSync(source, "utf8");
    if (hashText(baseYaml) !== record.baseSpecHash) throw new Error("active source bytes changed after candidate evaluation");
    const candidateYaml = readFileSync(join(this.candidateDir(loopId, candidateId), "candidate.yaml"), "utf8");
    const mode = statSync(source).mode & 0o777;
    const previousPointerPath = join(this.loopRoot(loopId), "active.json");
    const previous = existsSync(previousPointerPath) ? JSON.parse(readFileSync(previousPointerPath, "utf8")) as ActivePointer : undefined;
    try {
      atomicText(source, candidateYaml, mode);
      this.registry.replaceSpecHash(loopId, record.baseSpecHash, record.candidateSpecHash);
    } catch (error) {
      atomicText(source, baseYaml, mode);
      throw error;
    }
    if (previous?.candidateId) {
      const previousRecord = this.read(loopId, previous.candidateId);
      atomicJson(this.recordPath(loopId, previous.candidateId), { ...previousRecord, status: "superseded", updatedAt: this.now() });
    }
    const next: CandidateRecord = { ...record, status: "active", updatedAt: this.now(), decision: { actor: input.actor, reason: input.reason.trim(), at: this.now(), waivers: [...waivers].sort() } };
    atomicJson(this.recordPath(loopId, candidateId), next);
    atomicJson(previousPointerPath, { schemaVersion: 1, candidateId, specHash: record.candidateSpecHash, previousCandidateId: previous?.candidateId, updatedAt: this.now() } satisfies ActivePointer);
    this.registry.appendAudit({ actor: input.actor, surface: input.surface ?? "api", action: "evolution.activate", outcome: "completed", loopId, specHash: record.candidateSpecHash, detail: { candidateId, previousSpecHash: record.baseSpecHash, reason: input.reason.trim(), waivers: [...waivers].sort() } });
    return next;
  }

  rollback(loopId: string, input: { actor: string; reason: string; surface?: "api" | "cli" }): CandidateRecord {
    if (!input.reason.trim()) throw new Error("rollback requires a reason");
    const pointerPath = join(this.loopRoot(loopId), "active.json");
    if (!existsSync(pointerPath)) throw new Error(`loop '${loopId}' has no activated candidate to roll back`);
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as ActivePointer;
    if (!pointer.candidateId) throw new Error(`loop '${loopId}' has no activated candidate to roll back`);
    const record = this.read(loopId, pointer.candidateId);
    const loop = this.registry.get(loopId);
    if (!loop || loop.specHash !== record.candidateSpecHash) throw new Error("active spec no longer matches the rollback pointer");
    this.assertIdle(loopId, loop.path, "roll back");
    const source = join(loop.path, "loop.source.yaml");
    const current = readFileSync(source, "utf8");
    if (hashText(current) !== record.candidateSpecHash) throw new Error("active source bytes no longer match the rollback pointer");
    const baseYaml = readFileSync(join(this.candidateDir(loopId, record.id), "base.yaml"), "utf8");
    const mode = statSync(source).mode & 0o777;
    try {
      atomicText(source, baseYaml, mode);
      this.registry.replaceSpecHash(loopId, record.candidateSpecHash, record.baseSpecHash);
    } catch (error) { atomicText(source, current, mode); throw error; }
    const rolledBack: CandidateRecord = { ...record, status: "rolled-back", updatedAt: this.now(), decision: { actor: input.actor, reason: input.reason.trim(), at: this.now(), waivers: record.decision?.waivers ?? [] } };
    atomicJson(this.recordPath(loopId, record.id), rolledBack);
    if (pointer.previousCandidateId) {
      const previous = this.read(loopId, pointer.previousCandidateId);
      atomicJson(this.recordPath(loopId, previous.id), { ...previous, status: "active", updatedAt: this.now() });
      atomicJson(pointerPath, { schemaVersion: 1, candidateId: previous.id, specHash: record.baseSpecHash, updatedAt: this.now() } satisfies ActivePointer);
    } else {
      atomicJson(pointerPath, { schemaVersion: 1, specHash: record.baseSpecHash, updatedAt: this.now() } satisfies ActivePointer);
    }
    this.registry.appendAudit({ actor: input.actor, surface: input.surface ?? "api", action: "evolution.rollback", outcome: "completed", loopId, specHash: record.baseSpecHash, detail: { candidateId: record.id, rolledBackSpecHash: record.candidateSpecHash, reason: input.reason.trim() } });
    return rolledBack;
  }
}
