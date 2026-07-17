import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpecFromYaml, type LoopSpec } from "@loopyc/core";
import { createRuntime, type RunResult, type RuntimeOptions, type UncertainResolution } from "@loopyc/runtime";
import { interpretLoop } from "@loopyc/verify";
import { OperatorRegistry, type LoopRegistration } from "./registry.js";

export const SCHEDULER_SCHEMA_VERSION = 1;

export interface OperatorClaim {
  pid: number;
  runId: string;
  action: "run" | "step" | "resume" | "approve" | "recover";
  startedAt: number;
}

export interface LoopScheduleState {
  nextDueAt?: number;
  lastDueAt?: number;
  pendingDueAt?: number;
  active?: OperatorClaim;
  lastOutcome?: RunResult["status"] | "failed";
}

export interface SchedulerStateFile {
  schemaVersion: 1;
  loops: Record<string, LoopScheduleState>;
}

export interface OperatorActionContext {
  actor: string;
  surface: "api" | "cli" | "scheduler";
  reason?: string;
}

export interface OperatorRunControllerOptions {
  registry?: OperatorRegistry;
  now?: () => number;
  runtimeOptions?: (loop: LoopRegistration, runId: string) => RuntimeOptions;
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function specHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

export class OperatorRunController {
  readonly registry: OperatorRegistry;
  private readonly now: () => number;
  private readonly runtimeOptions?: OperatorRunControllerOptions["runtimeOptions"];
  private readonly active = new Map<string, { runId: string; promise: Promise<RunResult> }>();

  constructor(options: OperatorRunControllerOptions = {}) {
    this.registry = options.registry ?? new OperatorRegistry();
    this.now = options.now ?? (() => Date.now());
    this.runtimeOptions = options.runtimeOptions;
    this.recoverStaleClaims();
  }

  readState(): SchedulerStateFile {
    if (!existsSync(this.registry.paths.scheduler)) return { schemaVersion: 1, loops: {} };
    const parsed = JSON.parse(readFileSync(this.registry.paths.scheduler, "utf8")) as SchedulerStateFile;
    if (parsed.schemaVersion !== SCHEDULER_SCHEMA_VERSION || !parsed.loops || typeof parsed.loops !== "object") {
      throw new Error(`unsupported scheduler state schema '${String(parsed.schemaVersion)}'; explicit migration required`);
    }
    return parsed;
  }

  updateSchedule(loopId: string, update: Partial<LoopScheduleState>): LoopScheduleState {
    return this.registry.withLock(() => {
      const state = this.readState();
      const next = { ...(state.loops[loopId] ?? {}), ...update };
      for (const [key, value] of Object.entries(next)) if (value === undefined) delete (next as Record<string, unknown>)[key];
      state.loops[loopId] = next;
      atomicJson(this.registry.paths.scheduler, state);
      return next;
    });
  }

  clearSchedule(loopId: string): void {
    this.registry.withLock(() => {
      const state = this.readState();
      const active = state.loops[loopId]?.active;
      state.loops[loopId] = active ? { active } : {};
      atomicJson(this.registry.paths.scheduler, state);
    });
  }

  isActive(loopId: string): boolean {
    if (this.active.has(loopId)) return true;
    const claim = this.readState().loops[loopId]?.active;
    return Boolean(claim && processAlive(claim.pid));
  }

  private recoverStaleClaims(): void {
    this.registry.withLock(() => {
      const state = this.readState();
      let changed = false;
      for (const [loopId, loopState] of Object.entries(state.loops)) {
        if (loopState.active && !processAlive(loopState.active.pid)) {
          const stale = loopState.active;
          delete loopState.active;
          loopState.lastOutcome = "failed";
          changed = true;
          this.registry.appendAudit({ actor: "operator", surface: "scheduler", action: "run.claim-recovered", outcome: "completed", loopId, runId: stale.runId, detail: { stalePid: stale.pid, startedAt: stale.startedAt } });
        }
      }
      if (changed) atomicJson(this.registry.paths.scheduler, state);
    });
  }

  private loadLoop(loopId: string): { loop: LoopRegistration; spec: LoopSpec } {
    const loop = this.registry.get(loopId);
    if (!loop) throw new Error(`loop '${loopId}' is not installed`);
    const source = join(loop.path, "loop.source.yaml");
    if (!existsSync(source)) throw new Error(`loop '${loopId}' has no loop.source.yaml and cannot be operated`);
    const currentHash = specHash(source);
    if (currentHash !== loop.specHash) throw new Error(`loop '${loopId}' source changed since install; reinstall or activate a reviewed revision before running`);
    const loaded = loadSpecFromYaml(readFileSync(source, "utf8"));
    if (!loaded.spec) throw new Error(`loop '${loopId}' source does not pass validation`);
    return { loop, spec: loaded.spec };
  }

  private claim(loop: LoopRegistration, runId: string, action: OperatorClaim["action"]): void {
    if (!validRunId(runId)) throw new Error(`invalid run id '${runId}'`);
    this.registry.withLock(() => {
      const state = this.readState();
      const existing = state.loops[loop.id]?.active;
      if (existing && processAlive(existing.pid)) {
        throw new Error(`loop '${loop.id}' already has active run '${existing.runId}' (pid ${existing.pid})`);
      }
      state.loops[loop.id] = {
        ...(state.loops[loop.id] ?? {}),
        active: { pid: process.pid, runId, action, startedAt: this.now() },
      };
      atomicJson(this.registry.paths.scheduler, state);
    });
  }

  private release(loopId: string, status: LoopScheduleState["lastOutcome"]): void {
    this.registry.withLock(() => {
      const state = this.readState();
      const loopState = state.loops[loopId] ?? {};
      delete loopState.active;
      loopState.lastOutcome = status;
      state.loops[loopId] = loopState;
      atomicJson(this.registry.paths.scheduler, state);
    });
    this.active.delete(loopId);
  }

  execute(loopId: string, action: OperatorClaim["action"], input: OperatorActionContext & { runId?: string; recovery?: UncertainResolution }): Promise<RunResult> {
    const { loop, spec } = this.loadLoop(loopId);
    const runId = input.runId ?? `${input.surface}-${this.now()}`;
    this.claim(loop, runId, action);
    this.registry.appendAudit({ actor: input.actor, surface: input.surface, action: `run.${action}`, outcome: "accepted", loopId, runId, specHash: loop.specHash, detail: { reason: input.reason } });

    const promise = (async () => {
      const baseOptions = this.runtimeOptions?.(loop, runId) ?? {};
      const runtime = createRuntime(interpretLoop(spec), {
        ...baseOptions,
        cwd: loop.path,
        runId,
        autoApprove: action === "approve" ? true : baseOptions.autoApprove,
        approveCaps: action === "approve" ? true : baseOptions.approveCaps,
      });
      if (action === "step") return runtime.step();
      if (action === "resume" || action === "approve") return runtime.resume({ actor: input.actor, reason: input.reason });
      if (action === "recover") {
        if (!input.recovery) throw new Error("recover requires an explicit resolution");
        return runtime.recoverUncertain({ ...input.recovery, actor: input.actor } as UncertainResolution);
      }
      return runtime.run();
    })()
      .then((result) => {
        this.release(loopId, result.status);
        this.registry.appendAudit({ actor: input.actor, surface: input.surface, action: `run.${action}`, outcome: "completed", loopId, runId, specHash: loop.specHash, detail: { status: result.status, iteration: result.iteration, reason: result.reason } });
        return result;
      })
      .catch((error) => {
        this.release(loopId, "failed");
        this.registry.appendAudit({ actor: input.actor, surface: input.surface, action: `run.${action}`, outcome: "failed", loopId, runId, specHash: loop.specHash, detail: { error: (error as Error).message } });
        throw error;
      });
    this.active.set(loopId, { runId, promise });
    return promise;
  }

  requestStop(loopId: string, input: OperatorActionContext & { runId: string; action?: "pause" | "stop" }): { runId: string; requestedAt: number } {
    const { loop, spec } = this.loadLoop(loopId);
    if (!validRunId(input.runId)) throw new Error(`invalid run id '${input.runId}'`);
    const action = input.action ?? "stop";
    const runtime = createRuntime(interpretLoop(spec), { cwd: loop.path, runId: input.runId });
    const request = runtime.requestStop({ actor: input.actor, reason: input.reason?.trim() || `${action} requested from ${input.surface}` });
    this.registry.appendAudit({ actor: input.actor, surface: input.surface, action: `run.${action}`, outcome: "accepted", loopId, runId: input.runId, specHash: loop.specHash, detail: { reason: request.reason } });
    return { runId: input.runId, requestedAt: request.requestedAt };
  }

  async shutdown(timeoutMs = 30_000): Promise<boolean> {
    for (const [loopId, active] of this.active) {
      try { this.requestStop(loopId, { actor: "operator", surface: "scheduler", runId: active.runId, reason: "operator shutdown", action: "stop" }); } catch { /* already stopped/requested */ }
    }
    const all = Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
    if (this.active.size === 0) return true;
    return Promise.race([
      all.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
}

interface CronField { wildcard: boolean; matches(value: number): boolean }

function cronField(source: string, lo: number, hi: number, normalize?: (value: number) => number): CronField {
  const allowed = new Set<number>();
  for (const part of source.split(",")) {
    const [rangeSource, stepSource] = part.split("/");
    const step = Number(stepSource ?? 1);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step '${String(stepSource)}'`);
    const [start, end] = rangeSource === "*" ? [lo, hi] : rangeSource!.includes("-")
      ? rangeSource!.split("-").map(Number) as [number, number]
      : [Number(rangeSource), stepSource ? hi : Number(rangeSource)];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || start > end) {
      throw new Error(`invalid cron field '${source}'`);
    }
    for (let value = start; value <= end; value += step) allowed.add(normalize ? normalize(value) : value);
  }
  return { wildcard: source === "*" || source.startsWith("*/"), matches: (value) => allowed.has(normalize ? normalize(value) : value) };
}

/** Return the first local-time cron occurrence strictly after `after`. Supports the validated
 * numeric 5/6-field grammar and scans at most 400 days. */
export function nextCronOccurrence(cron: string, after: number): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) throw new Error(`unsupported cron '${cron}'`);
  const withSeconds = fields.length === 6;
  const values = withSeconds ? fields : ["0", ...fields];
  const matchers = [
    cronField(values[0]!, 0, 59), cronField(values[1]!, 0, 59), cronField(values[2]!, 0, 23),
    cronField(values[3]!, 1, 31), cronField(values[4]!, 1, 12), cronField(values[5]!, 0, 7, (value) => value === 7 ? 0 : value),
  ];
  const step = withSeconds ? 1_000 : 60_000;
  let candidate = new Date(after + step);
  candidate.setMilliseconds(0);
  if (!withSeconds) candidate.setSeconds(0);
  const limit = candidate.getTime() + 400 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= limit) {
    const parts = [candidate.getSeconds(), candidate.getMinutes(), candidate.getHours(), candidate.getDate(), candidate.getMonth() + 1, candidate.getDay()];
    const baseMatches = [0, 1, 2, 4].every((index) => matchers[index]!.matches(parts[index]!));
    const dom = matchers[3]!;
    const dow = matchers[5]!;
    const dayMatches = dom.wildcard && dow.wildcard
      ? true
      : dom.wildcard ? dow.matches(parts[5]!)
        : dow.wildcard ? dom.matches(parts[3]!)
          : dom.matches(parts[3]!) || dow.matches(parts[5]!);
    if (baseMatches && dayMatches) return candidate.getTime();
    candidate = new Date(candidate.getTime() + step);
  }
  throw new Error(`cron '${cron}' has no occurrence within 400 days`);
}

export class OperatorScheduler {
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly controller: OperatorRunController, private readonly intervalMs = 1_000, private readonly now = () => Date.now()) {}

  private specFor(loop: LoopRegistration): LoopSpec {
    const source = join(loop.path, "loop.source.yaml");
    const loaded = loadSpecFromYaml(readFileSync(source, "utf8"));
    if (!loaded.spec) throw new Error(`loop '${loop.id}' source does not pass validation`);
    return loaded.spec;
  }

  enable(loopId: string): LoopScheduleState {
    const loop = this.controller.registry.get(loopId);
    if (!loop) throw new Error(`loop '${loopId}' is not installed`);
    const spec = this.specFor(loop);
    const schedule = spec.schedule;
    if (!schedule || schedule.mode === "manual") throw new Error(`loop '${loopId}' has no recurring schedule`);
    const nextDueAt = schedule.mode === "cron" ? nextCronOccurrence(schedule.cron!, this.now()) : this.now();
    return this.controller.updateSchedule(loopId, { nextDueAt, pendingDueAt: undefined });
  }

  disable(loopId: string): void { this.controller.clearSchedule(loopId); }

  tick(at = this.now()): void {
    for (const loop of this.controller.registry.list()) {
      if (loop.schedulerAuthority !== "operator") continue;
      let spec: LoopSpec;
      try { spec = this.specFor(loop); } catch (error) {
        this.controller.registry.appendAudit({ actor: "operator", surface: "scheduler", action: "scheduler.tick", outcome: "failed", loopId: loop.id, specHash: loop.specHash, detail: { error: (error as Error).message } });
        continue;
      }
      const schedule = spec.schedule;
      if (!schedule || schedule.mode === "manual") continue;
      const current = this.controller.readState().loops[loop.id] ?? {};
      const scheduledDue = current.nextDueAt ?? (schedule.mode === "cron" ? nextCronOccurrence(schedule.cron!, at) : at);
      if (this.controller.isActive(loop.id)) {
        if (scheduledDue <= at) {
          const nextDueAt = schedule.mode === "cron" ? nextCronOccurrence(schedule.cron!, at) : at + 60_000;
          this.controller.updateSchedule(loop.id, {
            nextDueAt,
            pendingDueAt: loop.missedRunPolicy === "latest" ? scheduledDue : undefined,
          });
        } else if (current.nextDueAt == null) this.controller.updateSchedule(loop.id, { nextDueAt: scheduledDue });
        continue;
      }
      const due = current.pendingDueAt ?? scheduledDue;
      if (due > at) {
        if (current.nextDueAt == null) this.controller.updateSchedule(loop.id, { nextDueAt: due });
        continue;
      }
      const nextDueAt = current.pendingDueAt != null && scheduledDue > at
        ? scheduledDue
        : schedule.mode === "cron" ? nextCronOccurrence(schedule.cron!, at) : at + 60_000;
      const runId = `scheduled-${due}`;
      this.controller.updateSchedule(loop.id, { lastDueAt: due, nextDueAt, pendingDueAt: undefined });
      void this.controller.execute(loop.id, "step", { actor: "operator", surface: "scheduler", runId, reason: `scheduled ${schedule.mode} invocation` })
        .then((result) => {
          if ((schedule.mode === "forever" || schedule.mode === "watch") && result.wakeAt) {
            this.controller.updateSchedule(loop.id, { nextDueAt: result.wakeAt });
          }
        })
        .catch(() => undefined);
    }
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
