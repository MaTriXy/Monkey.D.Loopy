/**
 * The durable runtime. createRuntime() returns an engine that executes a compiled
 * loop with: an event-sourced journal, idempotent effect replay (so a killed run
 * resumes without re-running completed effects), hard cap enforcement, durable sleep
 * (park + resume), and breakpoints. It owns the OUTER loop only — agent steps delegate
 * the inner ReAct turn to a harness.
 */
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "./journal.js";
import {
  builtinHarnesses,
  execHttp,
  execShell,
  resolveAgentExecLimits,
  resolveAgentTimeoutMs,
  DEFAULT_LLM_TIMEOUT_MS,
  resolveLlm,
  type AgentHarness,
  type AgentRequest,
  type AgentResult,
  type HttpRequestSpec,
  type ShellCommand,
} from "./effects.js";
import { isCostMeterable } from "./pricing.js";
import { jsonpath, parseDuration } from "./helpers.js";

export interface LoopCaps {
  max_iterations: number;
  no_progress?: { fingerprint: string; max_repeats: number };
  budget?: { tokens?: number; usd?: number; wallclock?: string };
  on_cap_exceeded?: "fail" | "breakpoint" | "exit-clean";
}

export interface LoopCtx {
  state: Record<string, unknown>;
  inputs: Record<string, unknown>;
  env: Record<string, unknown>;
  iteration: number;
  meta: Record<string, unknown>;
  http: (req: HttpRequestSpec) => Promise<unknown>;
  shell: (cmd: ShellCommand) => Promise<unknown>;
  agent: (req: AgentRequest) => Promise<AgentResult>;
  sleep: (dur: string) => Promise<void>;
  sleepUntil: (predicate: () => boolean) => Promise<void>;
  breakpoint: (opts: { ask: string; strategy?: string; autoApproveIn?: string[] }) => Promise<boolean>;
  jsonpath: (obj: unknown, path: string) => unknown;
}

export interface RuntimeSpecMeta {
  id: string;
  meta?: Record<string, unknown>;
  caps: LoopCaps;
  schedule?: { mode?: string; cron?: string };
  signal?: string;
  observe?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  /** Transient-error retry policy for http/shell/agent effects. */
  retry?: { max?: number; backoff_ms?: number };
}

export interface RuntimeConfig {
  spec: RuntimeSpecMeta;
  initialState: () => Record<string, unknown>;
  iterate: (ctx: LoopCtx) => Promise<void>;
  terminate: (ctx: LoopCtx) => boolean;
  fingerprint?: (ctx: LoopCtx) => string;
  onExit?: (ctx: LoopCtx) => Promise<void>;
  /** Best-effort post-success observer. It is journaled but cannot rewrite completion. */
  onComplete?: (ctx: LoopCtx, result: RunResult) => Promise<void>;
  // NB: there is no `gates` config — a spec's gates are lowered to inline ctx.breakpoint()
  // calls by the emitters, so the runtime needs no separate gate machinery.
}

export interface RuntimeOptions {
  cwd?: string;
  runId?: string;
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  now?: () => number;
  /** Sleeps no longer than this block in run(); longer ones park + exit (default 1000ms). */
  maxBlockMs?: number;
  mode?: string;
  /** Auto-approve breakpoints. Defaults to FALSE — human gates fail closed. */
  autoApprove?: boolean;
  /** Per-effect timeout (ms) for http/shell. Default 300000. */
  effectTimeoutMs?: number;
  /** Injectable delay for durable sleep (lets tests advance without real waits). */
  delay?: (ms: number) => Promise<void>;
  /** Approve a pending cap-breakpoint on resume (reset its counter and continue). */
  approveCaps?: boolean;
  /** Transient-error retry count for effects (overrides spec.retry.max). Default 0. */
  effectRetries?: number;
  /** Base backoff (ms) between effect retries; exponential. Default 1000. */
  effectRetryBackoffMs?: number;
  /** Environment for shell effects. When set, shell subprocesses use ONLY this env
   * (scrubbed); when omitted they inherit the runtime process env. */
  effectEnv?: Record<string, string>;
  agentHarnesses?: Record<string, AgentHarness>;
  effects?: { http?: typeof execHttp; shell?: typeof execShell };
}

export type RunStatus = "completed" | "waiting" | "paused" | "uncertain" | "stopped" | "failed";

export interface UncertainEffectInfo {
  iteration: number;
  seq: number;
  kind: string;
  identity: string;
}

export type UncertainResolution =
  | { action: "retry"; reason: string; actor?: string }
  | { action: "assume-done"; reason: string; actor?: string; result: unknown }
  | { action: "abort"; reason: string; actor?: string };

export interface StopRequest {
  version: 1;
  runId: string;
  requestedAt: number;
  actor: string;
  reason: string;
}

export interface RunResult {
  status: RunStatus;
  iteration: number;
  state: Record<string, unknown>;
  reason?: string;
  wakeAt?: number;
  next?: { iteration: number };
  uncertain?: UncertainEffectInfo;
}

class ParkSignal {
  constructor(public readonly wakeAt: number) {}
}
class PauseSignal {
  constructor(public readonly reason: string) {}
}
class CapSignal {
  constructor(public readonly reason: string) {}
}
class NonDeterministicReplayError extends Error {
  constructor(seq: number, expected: string, found: string) {
    super(`non-deterministic replay at effect seq ${seq}: expected '${expected}' but journal has '${found}'. The iterate() body must be deterministic across replays.`);
  }
}
class UncertainEffectError extends Error {
  constructor(public readonly effect: UncertainEffectInfo) {
    super(uncertainReason(effect));
  }
}

function uncertainReason(effect: UncertainEffectInfo): string {
  return `effect seq ${effect.seq} (${effect.kind}) crashed after starting but before its result was journaled; its outcome is unknown. Choose an explicit recovery: retry, assume-done, or abort.`;
}

function isLegacyUncertainFailure(message: unknown): boolean {
  return typeof message === "string" && message.includes("crashed after starting but before its result was journaled") && message.includes("outcome is unknown");
}

/** Stable identity for an effect call (kind-agnostic), used to detect divergent replays. */
function canonId(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Runtime {
  private readonly journal: Journal;
  private readonly now: () => number;
  private readonly maxBlockMs: number;
  private readonly mode: string;
  private readonly autoApprove: boolean;
  private readonly harnesses: Record<string, AgentHarness>;
  private readonly httpImpl: typeof execHttp;
  private readonly shellImpl: typeof execShell;
  private readonly inputs: Record<string, unknown>;
  private readonly env: Record<string, unknown>;
  private readonly cwd: string;
  private readonly effectTimeoutMs: number;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly retries: number;
  private readonly retryBackoffMs: number;
  private readonly effectEnv?: Record<string, string>;
  private readonly runId: string;
  private lockHeld = false;

  private state: Record<string, unknown> = {};
  private iteration = 0;
  private terminalStatus: RunStatus | null = null;
  private effectSeq = 0;
  private replayMap = new Map<number, Record<string, unknown>>();
  private effectsByIteration = new Map<number, Map<number, Record<string, unknown>>>();
  private tokens = 0;
  private usd = 0;
  private firstStartTs = 0;
  /** Budget reset offsets: a budget cap-breakpoint, once approved, opens a FRESH window by
   *  rebasing the relevant meter here (mirrors iterationBudgetBase for max_iterations). */
  private tokensBase = 0;
  private usdBase = 0;
  private wallclockBase = 0;
  private lastFp: string | undefined;
  private fpRepeats = 0;
  private loaded = false;
  /** A cap whose action is "breakpoint" has fired and is awaiting approval to resume. */
  private pendingCap: { reason: string } | null = null;
  /** max_iterations is counted from here; bumped each time a cap is approved. */
  private iterationBudgetBase = 0;
  /** no_progress repeats are counted from snapshots at/after this iteration. */
  private fpResetAt = 0;
  /** When true, a pending cap is approved on the next run (reset + continue). */
  private approveCaps: boolean;
  /** A write-ahead effect without a matching result. It is recoverable, never generic-terminal. */
  private pendingUncertain: UncertainEffectInfo | null = null;
  /** A graceful external stop acknowledged at a replay-safe boundary. Explicit resume clears it. */
  private pendingStop: StopRequest | null = null;

  constructor(private readonly config: RuntimeConfig, options: RuntimeOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    this.cwd = cwd;
    this.runId = options.runId ?? "default";
    this.journal = new Journal(cwd, this.runId);
    this.now = options.now ?? (() => Date.now());
    this.maxBlockMs = options.maxBlockMs ?? 1000;
    this.mode = options.mode ?? "nonInteractive";
    this.autoApprove = options.autoApprove ?? false; // human gates fail CLOSED by default
    this.effectTimeoutMs = options.effectTimeoutMs ?? 300_000;
    this.delayFn = options.delay ?? delay;
    this.retries = options.effectRetries ?? config.spec.retry?.max ?? 0;
    this.retryBackoffMs = options.effectRetryBackoffMs ?? config.spec.retry?.backoff_ms ?? 1000;
    this.effectEnv = options.effectEnv;
    this.approveCaps = options.approveCaps ?? false;
    this.harnesses = { ...builtinHarnesses, ...options.agentHarnesses };
    this.httpImpl = options.effects?.http ?? execHttp;
    this.shellImpl = options.effects?.shell ?? execShell;
    this.env = options.env ?? (process.env as Record<string, unknown>);
    this.inputs = options.inputs ?? loadInputsFile(cwd);
  }

  // --- replay / load -------------------------------------------------------
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.acquireLock();
    const events = this.journal.load();
    if (events.length === 0) {
      this.state = this.config.initialState();
      this.iteration = 0;
      this.firstStartTs = this.now();
      this.wallclockBase = this.firstStartTs;
      // record the base state in the journal so resume never re-invokes initialState()
      this.journal.append("run_start", { loopId: this.config.spec.id, baseState: this.state }, this.firstStartTs);
      return;
    }
    this.firstStartTs = events[0]!.ts;
    this.wallclockBase = this.firstStartTs;
    let snapshotIteration = -1;
    let baseState: Record<string, unknown> | undefined;
    const snapshots: { iteration: number; fp: string | undefined }[] = [];
    for (const ev of events) {
      if (ev.type === "run_start") {
        if (ev.data.baseState) baseState = ev.data.baseState as Record<string, unknown>;
        continue;
      }
      if (ev.type === "effect") {
        const it = ev.data.iteration as number;
        const seq = ev.data.seq as number;
        if (!this.effectsByIteration.has(it)) this.effectsByIteration.set(it, new Map());
        this.effectsByIteration.get(it)!.set(seq, ev.data);
        if (ev.data.status === "pending") {
          this.pendingUncertain = {
            iteration: it,
            seq,
            kind: ev.data.kind as string,
            identity: ev.data.identity as string,
          };
        } else if (ev.data.status === "done" && this.pendingUncertain?.iteration === it && this.pendingUncertain.seq === seq) {
          this.pendingUncertain = null;
        }
        const usage = ev.data.usage as { tokens?: number; usd?: number } | undefined;
        if (usage?.tokens) this.tokens += usage.tokens;
        if (usage?.usd) this.usd += usage.usd;
      } else if (ev.type === "effect_recovery") {
        const effect = ev.data.effect as UncertainEffectInfo;
        const action = ev.data.action as UncertainResolution["action"];
        const iterationEffects = this.effectsByIteration.get(effect.iteration);
        if (action === "retry") {
          iterationEffects?.delete(effect.seq);
        } else if (action === "assume-done") {
          if (!iterationEffects) this.effectsByIteration.set(effect.iteration, new Map());
          this.effectsByIteration.get(effect.iteration)!.set(effect.seq, {
            iteration: effect.iteration,
            seq: effect.seq,
            kind: effect.kind,
            identity: effect.identity,
            status: "done",
            result: ev.data.result,
            recovered: true,
          });
        } else if (action === "abort") {
          this.terminalStatus = "stopped";
        }
        this.pendingUncertain = null;
      } else if (ev.type === "stop_requested") {
        this.pendingStop = ev.data.request as unknown as StopRequest;
      } else if (ev.type === "stop_cleared") {
        this.pendingStop = null;
      } else if (ev.type === "iteration_snapshot") {
        snapshotIteration = ev.data.iteration as number;
        this.state = structuredClone(ev.data.state) as Record<string, unknown>;
        snapshots.push({ iteration: snapshotIteration, fp: ev.data.fp as string | undefined });
      } else if (ev.type === "terminated") {
        this.terminalStatus = "completed";
      } else if (ev.type === "failed") {
        // Runtime <=0.1.0 converted a pending effect into a sticky generic failure. Preserve
        // compatibility by recognizing that exact failure and exposing the original pending
        // effect through the new explicit recovery flow.
        if (!this.pendingUncertain || !isLegacyUncertainFailure(ev.data.error)) this.terminalStatus = "failed";
      } else if (ev.type === "cap") {
        const action = ev.data.action as string;
        const reason = ev.data.reason as string;
        if (action === "fail") this.terminalStatus = "failed";
        else if (action === "exit-clean") this.terminalStatus = "stopped";
        else this.pendingCap = { reason }; // breakpoint → awaiting approval (NOT sticky-terminal)
      } else if (ev.type === "cap_cleared") {
        this.pendingCap = null;
        const reason = ev.data.reason as string;
        const at = ev.data.atIteration as number;
        if (reason === "max_iterations") this.iterationBudgetBase = at;
        if (reason === "no_progress") this.fpResetAt = at;
        // rebase budgets to the running totals at the moment of approval (events replay in
        // chronological order, so this.tokens/usd already reflect everything before this point).
        if (reason === "token-budget") this.tokensBase = this.tokens;
        if (reason === "usd-budget") this.usdBase = this.usd;
        if (reason === "wallclock-budget") this.wallclockBase = ev.ts;
      }
    }
    if (snapshotIteration < 0) {
      // resume before the first snapshot — restore base from the journal, not initialState()
      this.state = structuredClone(baseState ?? this.config.initialState());
      this.iteration = 0;
    } else {
      this.iteration = snapshotIteration + 1;
    }
    // recompute the no-progress streak from snapshots at/after the last reset point
    for (const s of snapshots) if (s.iteration >= this.fpResetAt) this.recordFingerprint(s.fp);
  }

  private recordFingerprint(fp: string | undefined): void {
    if (fp === undefined) return;
    if (fp === this.lastFp) this.fpRepeats++;
    else {
      this.fpRepeats = 0;
      this.lastFp = fp;
    }
  }

  // --- effect context ------------------------------------------------------
  private makeCtx(): LoopCtx {
    return {
      state: this.state,
      inputs: this.inputs,
      env: this.env,
      iteration: this.iteration,
      meta: this.config.spec.meta ?? {},
      jsonpath,
      http: (req) =>
        // `envelope` is part of the identity so a body-direct and an enveloped call to the same
        // URL replay as distinct effects (their result shapes differ) — replay stays deterministic.
        this.doEffect("http", canonId({ method: req.method, url: req.url, headers: req.headers, body: req.body, envelope: req.envelope }), { req }, () =>
          this.httpImpl(req, this.effectTimeoutMs)
        ),
      shell: (cmd) => this.doEffect("shell", canonId({ cmd }), { cmd }, () => this.shellImpl(cmd, this.effectTimeoutMs, this.cwd, this.effectEnv)),
      agent: (req) => this.doAgent(req),
      sleep: (dur) => this.doSleep(dur),
      sleepUntil: (pred) => this.doSleepUntil(pred),
      breakpoint: (opts) => this.doBreakpoint(opts),
    };
  }

  /**
   * Write-ahead, identity-checked effect. A "pending" record is journaled BEFORE the
   * side effect and a "done" record (with result) AFTER. On replay: a divergent
   * identity or a pending-without-done (crash mid-effect) fails LOUD rather than
   * silently re-running or returning a stale result.
   */
  private async doEffect(
    kind: string,
    identity: string,
    data: Record<string, unknown>,
    exec: () => Promise<unknown>
  ): Promise<unknown> {
    const seq = this.effectSeq++;
    const replay = this.replayMap.get(seq);
    if (replay) {
      if (replay.kind !== kind || replay.identity !== identity) {
        throw new NonDeterministicReplayError(seq, kind, replay.kind as string);
      }
      if (replay.status === "pending") {
        throw new UncertainEffectError({ iteration: this.iteration, seq, kind, identity });
      }
      return replay.result;
    }
    this.journal.append("effect", { iteration: this.iteration, seq, kind, identity, status: "pending", ...data }, this.now());
    const result = await this.withRetry(exec);
    this.journal.append("effect", { iteration: this.iteration, seq, kind, identity, status: "done", ...data, result }, this.now());
    return result;
  }

  /** Retry a transient-failing effect with exponential backoff before giving up. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt < this.retries) await this.delayFn(this.retryBackoffMs * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  private async doAgent(req: AgentRequest): Promise<AgentResult> {
    const seq = this.effectSeq++;
    const identity = canonId({ harness: req.harness, prompt: req.prompt, tools: req.allowedTools });
    const replay = this.replayMap.get(seq);
    if (replay) {
      if (replay.kind !== "agent" || replay.identity !== identity) {
        throw new NonDeterministicReplayError(seq, "agent", replay.kind as string);
      }
      if (replay.status === "pending") {
        throw new UncertainEffectError({ iteration: this.iteration, seq, kind: "agent", identity });
      }
      return replay.result as AgentResult;
    }
    const harness = this.harnesses[req.harness];
    if (!harness) throw new Error(`unknown agent harness '${req.harness}'`);
    this.journal.append(
      "effect",
      { iteration: this.iteration, seq, kind: "agent", identity, status: "pending", harness: req.harness },
      this.now()
    );
    const result = await this.withRetry(() => harness(req));
    if (result.usage?.tokens) this.tokens += result.usage.tokens;
    if (result.usage?.usd) this.usd += result.usage.usd;
    this.journal.append(
      "effect",
      { iteration: this.iteration, seq, kind: "agent", identity, status: "done", harness: req.harness, result, usage: result.usage },
      this.now()
    );
    // budget is metered HERE so multiple agent calls in one iteration cannot overshoot.
    const cap = this.budgetExceeded();
    if (cap) throw new CapSignal(cap);
    return result;
  }

  private async doSleep(dur: string): Promise<void> {
    const ms = parseDuration(dur);
    const seq = this.effectSeq++;
    const replay = this.replayMap.get(seq);
    if (replay) {
      // a replay slot of a DIFFERENT kind means the iterate body diverged — fail loud rather
      // than appending a second effect at the same seq (mirrors doEffect/doAgent).
      if (replay.kind !== "sleep") throw new NonDeterministicReplayError(seq, "sleep", replay.kind as string);
      if (this.now() >= (replay.wakeAt as number)) return;
      throw new ParkSignal(replay.wakeAt as number);
    }
    const wakeAt = this.now() + ms;
    if (ms <= this.maxBlockMs) {
      this.journal.append("effect", { iteration: this.iteration, seq, kind: "sleep", wakeAt }, this.now());
      await this.delayFn(ms);
      return;
    }
    this.journal.append("effect", { iteration: this.iteration, seq, kind: "sleep", wakeAt }, this.now());
    throw new ParkSignal(wakeAt);
  }

  private async doSleepUntil(predicate: () => boolean): Promise<void> {
    const seq = this.effectSeq++;
    const replayKind = this.replayMap.get(seq)?.kind;
    if (replayKind !== undefined && replayKind !== "sleepUntil") {
      throw new NonDeterministicReplayError(seq, "sleepUntil", replayKind as string);
    }
    if (predicate()) {
      const replay = this.replayMap.get(seq);
      if (!replay) {
        this.journal.append(
          "effect",
          { iteration: this.iteration, seq, kind: "sleepUntil", resolved: true },
          this.now()
        );
      }
      return;
    }
    const wakeAt = this.now() + 5000;
    if (!this.replayMap.has(seq)) {
      this.journal.append("effect", { iteration: this.iteration, seq, kind: "sleepUntil", wakeAt }, this.now());
    }
    throw new ParkSignal(wakeAt);
  }

  private async doBreakpoint(opts: { ask: string; strategy?: string; autoApproveIn?: string[] }): Promise<boolean> {
    const seq = this.effectSeq++;
    const replay = this.replayMap.get(seq);
    if (replay && replay.kind !== "breakpoint") throw new NonDeterministicReplayError(seq, "breakpoint", replay.kind as string);
    // only APPROVED breakpoints are journaled; a denial is left unresolved so a later
    // run re-evaluates the gate (fail-closed + resumable) instead of auto-denying.
    if (replay && replay.kind === "breakpoint") return (replay.result as { approved: boolean }).approved;
    // `single` is the strategy this single-process runtime can ENFORCE (one approver, in-process).
    // `first-wins`/`quorum` describe a multi-party gate it can't gather itself, so they are surfaced
    // as metadata (journal record + pause reason) for an external approver/UI — never silently dropped.
    const strategy = opts.strategy ?? "single";
    const approved = this.autoApprove || (opts.autoApproveIn?.includes(this.mode) ?? false);
    if (!approved) throw new PauseSignal(`breakpoint awaiting approval [strategy: ${strategy}]: ${opts.ask}`);
    this.journal.append(
      "effect",
      { iteration: this.iteration, seq, kind: "breakpoint", ask: opts.ask, strategy, result: { approved } },
      this.now()
    );
    return approved;
  }

  // --- caps ----------------------------------------------------------------
  /** Budget caps, checked at meter-time (per agent call) so a single iteration cannot overshoot. */
  private budgetExceeded(): string | null {
    const b = this.config.spec.caps.budget;
    if (!b) return null;
    if (b.tokens && this.tokens - this.tokensBase >= b.tokens) return "token-budget";
    if (b.usd && this.usd - this.usdBase >= b.usd) return "usd-budget";
    if (b.wallclock && this.now() - this.wallclockBase >= parseDuration(b.wallclock)) return "wallclock-budget";
    return null;
  }

  private capExceeded(): string | null {
    const caps = this.config.spec.caps;
    if (this.iteration - this.iterationBudgetBase >= caps.max_iterations) return "max_iterations";
    const budget = this.budgetExceeded();
    if (budget) return budget;
    if (caps.no_progress && this.fpRepeats >= caps.no_progress.max_repeats) return "no_progress";
    return null;
  }

  private capHit(reason: string): RunResult {
    const action = this.config.spec.caps.on_cap_exceeded ?? "breakpoint";
    this.journal.append("cap", { reason, action }, this.now());
    if (action === "fail" || action === "exit-clean") {
      const status: RunStatus = action === "fail" ? "failed" : "stopped";
      this.terminalStatus = status;
      this.persist(status);
      return { status, iteration: this.iteration, state: this.state, reason };
    }
    // breakpoint: pause, awaiting approval — NOT sticky-terminal (resumable with approveCaps).
    this.pendingCap = { reason };
    this.persist("paused");
    return { status: "paused", iteration: this.iteration, state: this.state, reason };
  }

  /** Approve a pending cap: reset its counter and clear it so the loop can continue. */
  private clearPendingCap(): void {
    if (!this.pendingCap) return;
    const reason = this.pendingCap.reason;
    this.journal.append("cap_cleared", { reason, atIteration: this.iteration }, this.now());
    if (reason === "max_iterations") this.iterationBudgetBase = this.iteration;
    if (reason === "no_progress") {
      this.fpResetAt = this.iteration;
      this.fpRepeats = 0;
      this.lastFp = undefined;
    }
    // budget caps: rebase the relevant meter so an approved pause opens a fresh window
    // (otherwise budgetExceeded() would re-fire immediately at the same totals → stuck re-pausing).
    if (reason === "token-budget") this.tokensBase = this.tokens;
    if (reason === "usd-budget") this.usdBase = this.usd;
    if (reason === "wallclock-budget") this.wallclockBase = this.now();
    this.pendingCap = null;
  }

  /** Resolve a pending cap before iterating: approve+continue, or stay paused. Returns a
   * paused RunResult to short-circuit, or null to proceed. */
  private resolvePendingCap(): RunResult | null {
    if (!this.pendingCap) return null;
    if (!this.approveCaps) {
      this.persist("paused");
      return { status: "paused", iteration: this.iteration, state: this.state, reason: this.pendingCap.reason };
    }
    this.clearPendingCap();
    return null;
  }

  // --- run / step ----------------------------------------------------------
  async run(): Promise<RunResult> {
    this.acquireLock(); // re-acquire if a prior run()/step() on this instance released it (load() early-returns)
    try {
      this.load();
      if (this.terminalStatus) return { status: this.terminalStatus, iteration: this.iteration, state: this.state };
      if (this.pendingUncertain) {
        this.persist("uncertain");
        return this.uncertainResult();
      }
      const stopped = this.resolveExternalStop();
      if (stopped) return stopped;
      const paused = this.resolvePendingCap();
      if (paused) return paused;
      for (;;) {
        const result = await this.runOneIteration();
        if (result) return result;
      }
    } finally {
      this.releaseLock();
    }
  }

  async step(): Promise<RunResult> {
    this.acquireLock(); // re-acquire if a prior run()/step() on this instance released it (load() early-returns)
    try {
      this.load();
      if (this.terminalStatus) {
        return { status: this.terminalStatus, iteration: this.iteration, state: this.state, next: { iteration: this.iteration } };
      }
      if (this.pendingUncertain) {
        this.persist("uncertain");
        return { ...this.uncertainResult(), next: { iteration: this.iteration } };
      }
      const stopped = this.resolveExternalStop();
      if (stopped) return { ...stopped, next: { iteration: this.iteration } };
      const paused = this.resolvePendingCap();
      if (paused) return paused;
      const result = await this.runOneIteration();
      if (result) return result;
      return { status: "waiting", iteration: this.iteration, state: this.state, next: { iteration: this.iteration } };
    } finally {
      this.releaseLock();
    }
  }

  /** Run a single iteration. Returns a terminal/parked RunResult, or null to continue. */
  private async runOneIteration(): Promise<RunResult | null> {
    const ctx = this.makeCtx();
    try {
      if (this.config.terminate(ctx)) {
        await this.runExit(ctx); // inside the try so a parking/throwing onExit is handled
        this.journal.append("terminated", { iteration: this.iteration }, this.now());
        this.terminalStatus = "completed";
        const result: RunResult = { status: "completed", iteration: this.iteration, state: this.state };
        await this.runCompletionObserver(ctx, result);
        this.persist("completed");
        return result;
      }

      const cap = this.capExceeded();
      if (cap) return this.capHit(cap);

      this.effectSeq = 0;
      this.replayMap = this.effectsByIteration.get(this.iteration) ?? new Map();
      await this.config.iterate(ctx);

      // snapshot — may throw if state is not JSON-serializable; handled below.
      const fp = this.config.fingerprint ? this.config.fingerprint(ctx) : undefined;
      this.journal.append("iteration_snapshot", { iteration: this.iteration, state: this.state, fp }, this.now());
      this.recordFingerprint(fp);
      this.iteration++;
      // checkpoint the committed event count + state cache every iteration, so load()'s
      // truncation guard stays current during a long continuous run (not only on park/terminal)
      // and inspect_run sees live state. Best-effort (persist swallows write errors).
      this.persist("waiting");
      const stopped = this.resolveExternalStop();
      if (stopped) return stopped;
      return null;
    } catch (e) {
      return this.handleThrow(e);
    }
  }

  private handleThrow(e: unknown): RunResult {
    if (e instanceof ParkSignal) {
      this.journal.append("parked", { iteration: this.iteration, wakeAt: e.wakeAt }, this.now());
      this.persist("waiting");
      return { status: "waiting", iteration: this.iteration, state: this.state, wakeAt: e.wakeAt };
    }
    if (e instanceof PauseSignal) {
      this.persist("paused");
      return { status: "paused", iteration: this.iteration, state: this.state, reason: e.reason };
    }
    if (e instanceof CapSignal) {
      return this.capHit(e.reason);
    }
    if (e instanceof UncertainEffectError) {
      this.pendingUncertain = e.effect;
      this.persist("uncertain");
      return this.uncertainResult();
    }
    this.journal.append("failed", { iteration: this.iteration, error: (e as Error).message }, this.now());
    this.terminalStatus = "failed";
    this.persist("failed");
    return { status: "failed", iteration: this.iteration, state: this.state, reason: (e as Error).message };
  }

  private uncertainResult(): RunResult {
    const effect = this.pendingUncertain!;
    return {
      status: "uncertain",
      iteration: this.iteration,
      state: this.state,
      reason: uncertainReason(effect),
      uncertain: effect,
    };
  }

  /** Resolve a write-ahead effect whose external outcome is unknown. Every resolution is
   * journaled with actor/reason and the original identity before execution can continue. */
  async recoverUncertain(resolution: UncertainResolution): Promise<RunResult> {
    this.acquireLock();
    let continueRun = false;
    try {
      this.load();
      if (this.terminalStatus) {
        throw new Error(`cannot recover uncertain effect: run is already ${this.terminalStatus}`);
      }
      const effect = this.pendingUncertain;
      if (!effect) throw new Error("cannot recover uncertain effect: no unresolved effect");
      if (!resolution.reason?.trim()) throw new Error("uncertain recovery requires a non-empty reason");
      if (resolution.action === "assume-done" && !("result" in resolution)) {
        throw new Error("assume-done recovery requires a result");
      }

      this.journal.append(
        "effect_recovery",
        {
          effect,
          action: resolution.action,
          actor: resolution.actor ?? "unknown",
          reason: resolution.reason.trim(),
          ...(resolution.action === "assume-done" ? { result: resolution.result } : {}),
        },
        this.now()
      );

      const effects = this.effectsByIteration.get(effect.iteration);
      if (resolution.action === "retry") {
        effects?.delete(effect.seq);
      } else if (resolution.action === "assume-done") {
        if (!effects) this.effectsByIteration.set(effect.iteration, new Map());
        this.effectsByIteration.get(effect.iteration)!.set(effect.seq, {
          ...effect,
          status: "done",
          result: resolution.result,
          recovered: true,
        });
      } else {
        this.pendingUncertain = null;
        this.terminalStatus = "stopped";
        this.persist("stopped");
        return { status: "stopped", iteration: this.iteration, state: this.state, reason: resolution.reason.trim() };
      }
      this.pendingUncertain = null;
      this.persist("waiting");
      continueRun = true;
    } finally {
      this.releaseLock();
    }
    if (continueRun) return this.run();
    throw new Error("unreachable uncertain recovery state");
  }

  /** Request a cross-process graceful stop. The active runner acknowledges this marker only
   * after it reaches a replay-safe boundary; no concurrent journal writes are attempted. */
  requestStop(input: { reason: string; actor?: string }): StopRequest {
    const reason = input.reason?.trim();
    if (!reason) throw new Error("stop requires a non-empty reason");
    mkdirSync(this.journal.dir, { recursive: true });
    const request: StopRequest = {
      version: 1,
      runId: this.runId,
      requestedAt: this.now(),
      actor: input.actor ?? "unknown",
      reason,
    };
    const path = this.stopRequestPath();
    const temp = `${path}.${process.pid}.${request.requestedAt}.tmp`;
    writeFileSync(temp, JSON.stringify(request, null, 2));
    try {
      // An atomic hard-link publishes the complete request without overwriting an earlier one.
      linkSync(temp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`a stop is already requested for run '${this.runId}'`);
      }
      throw e;
    } finally {
      rmSync(temp, { force: true });
    }
    return request;
  }

  /** Resume a run paused by an acknowledged external stop. Terminal stops (cap/abort) remain
   * terminal, and uncertain effects still require recoverUncertain(). */
  async resume(input: { reason?: string; actor?: string } = {}): Promise<RunResult> {
    this.acquireLock();
    try {
      this.load();
      if (this.terminalStatus) {
        return { status: this.terminalStatus, iteration: this.iteration, state: this.state };
      }
      if (this.pendingUncertain) {
        this.persist("uncertain");
        return this.uncertainResult();
      }
      // A stop may have been requested while no runner was active. Acknowledge it before the
      // explicit resume so both sides of the transition remain visible in the journal.
      this.acknowledgeStopRequest();
      if (this.pendingStop) {
        this.journal.append(
          "stop_cleared",
          {
            request: this.pendingStop,
            actor: input.actor ?? "unknown",
            reason: input.reason?.trim() || "explicit resume",
          },
          this.now()
        );
        this.pendingStop = null;
        this.persist("waiting");
      }
    } finally {
      this.releaseLock();
    }
    return this.run();
  }

  private stopRequestPath(): string {
    return join(this.journal.dir, "stop-request.json");
  }

  private acknowledgeStopRequest(): void {
    const path = this.stopRequestPath();
    if (!existsSync(path)) return;
    const request = JSON.parse(readFileSync(path, "utf8")) as StopRequest;
    if (request.version !== 1 || request.runId !== this.runId || !request.reason?.trim()) {
      throw new Error(`invalid stop request for run '${this.runId}'`);
    }
    this.journal.append("stop_requested", { request }, this.now());
    this.pendingStop = request;
    unlinkSync(path);
  }

  private resolveExternalStop(): RunResult | null {
    if (!this.pendingStop) this.acknowledgeStopRequest();
    if (!this.pendingStop) return null;
    this.persist("stopped");
    return {
      status: "stopped",
      iteration: this.iteration,
      state: this.state,
      reason: this.pendingStop.reason,
    };
  }

  // --- cross-process lock --------------------------------------------------
  private acquireLock(): void {
    if (this.lockHeld) return;
    mkdirSync(this.journal.dir, { recursive: true });
    const lockPath = join(this.journal.dir, "lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, "wx");
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        this.lockHeld = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let pid = 0;
        try {
          pid = Number(readFileSync(lockPath, "utf8").trim());
        } catch {
          /* unreadable lock — treat as stale */
        }
        if (pid && pid !== process.pid && isAlive(pid)) {
          throw new Error(`another run holds the lock (pid ${pid}) for ${this.journal.dir}`);
        }
        try {
          unlinkSync(lockPath); // stale (dead pid) or our own — reclaim
        } catch {
          /* race: someone else reclaimed; retry */
        }
      }
    }
    throw new Error(`could not acquire run lock for ${this.journal.dir}`);
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    try {
      unlinkSync(join(this.journal.dir, "lock"));
    } catch {
      /* already gone */
    }
    this.lockHeld = false;
  }

  private async runExit(ctx: LoopCtx): Promise<void> {
    if (!this.config.onExit) return;
    this.effectSeq = 0;
    this.replayMap = this.effectsByIteration.get(-1) ?? new Map();
    const exitCtx: LoopCtx = { ...ctx };
    // onExit effects are journaled under iteration -1.
    const saved = this.iteration;
    this.iteration = -1;
    try {
      await this.config.onExit(exitCtx);
    } finally {
      this.iteration = saved;
    }
  }

  private async runCompletionObserver(ctx: LoopCtx, result: RunResult): Promise<void> {
    if (!this.config.onComplete) return;
    this.journal.append("observer", { event: "completed", status: "started" }, this.now());
    const observerCtx: LoopCtx = {
      ...ctx,
      http: (req) => this.withRetry(() => this.httpImpl(req, this.effectTimeoutMs)),
      shell: (cmd) => this.withRetry(() => this.shellImpl(cmd, this.effectTimeoutMs, this.cwd, this.effectEnv)),
    };
    try {
      await this.config.onComplete(observerCtx, result);
      this.journal.append("observer", { event: "completed", status: "done" }, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.journal.append(
        "observer",
        { event: "completed", status: "failed", error: message.slice(0, 500) },
        this.now()
      );
    }
  }

  private persist(status: RunStatus): void {
    const meta = {
      runId: this.runId,
      loopId: this.config.spec.id,
      status,
      iteration: this.iteration,
      tokens: this.tokens,
      usd: this.usd,
      updatedAt: this.now(),
    };
    try {
      this.journal.writeState(this.state, meta);
    } catch {
      // state cache is best-effort (the journal is the source of truth); never crash on
      // a non-serializable state cache write.
      this.journal.writeState({ note: "state not JSON-serializable" }, meta);
    }
  }

  // --- doctor + cli --------------------------------------------------------
  async doctor(): Promise<boolean> {
    const caps = this.config.spec.caps;
    const lines: string[] = [`doctor — loop '${this.config.spec.id}'`];
    let ok = true;
    try {
      // probe writability WITHOUT polluting the real journal
      mkdirSync(this.journal.dir, { recursive: true });
      const probe = join(this.journal.dir, ".probe");
      writeFileSync(probe, "");
      rmSync(probe, { force: true });
      lines.push(`  ✓ journal dir writable (${this.journal.dir})`);
    } catch (e) {
      ok = false;
      lines.push(`  ✗ journal dir NOT writable: ${(e as Error).message}`);
    }
    lines.push(caps.budget ? `  ✓ budget set: ${JSON.stringify(caps.budget)}` : `  ⚠ no token/$/wallclock budget`);
    // a usd budget only bites if SOME harness produces cost. claude-code reports total_cost_usd;
    // the agnostic `llm` harness derives cost from the price table (or LOOPY_LLM_PRICE_IN/OUT).
    // doctor can't see which harness the spec's agent steps use, so it ADVISES rather than asserts
    // (avoids a false alarm for a claude-code-only loop, or a false green from an unrelated key).
    if (caps.budget?.usd) {
      const cfg = resolveLlm();
      if (cfg && isCostMeterable(cfg.model)) {
        lines.push(`  ✓ usd budget ($${caps.budget.usd}): claude-code self-reports cost; the llm harness can price model '${cfg.model}'`);
      } else {
        lines.push(
          `  ℹ usd budget ($${caps.budget.usd}): claude-code harnesses self-report cost (metered). If this loop uses the 'llm' harness, set LOOPY_LLM_PRICE_IN/OUT or a known model so its cost is metered too ${cfg ? `(current model '${cfg.model}' isn't priced)` : "(no LLM configured)"}. Token/wallclock caps always apply.`
        );
      }
    }
    lines.push(`  ✓ max_iterations: ${caps.max_iterations}`);
    try {
      const limits = resolveAgentExecLimits();
      const llmTimeoutMs = resolveAgentTimeoutMs(process.env, DEFAULT_LLM_TIMEOUT_MS);
      lines.push(`  ✓ agent limits: cliTimeout=${limits.timeoutMs}ms, llmTimeout=${llmTimeoutMs}ms, cliMaxBuffer=${limits.maxBufferBytes} bytes`);
    } catch (e) {
      ok = false;
      lines.push(`  ✗ invalid agent limits: ${(e as Error).message}`);
    }
    lines.push(`  ℹ termination signal: ${this.config.spec.signal ?? "(unset)"}`);
    lines.push(`  ℹ node: ${process.version}`);
    console.log(lines.join("\n"));
    return ok;
  }

  async main(argv: string[]): Promise<void> {
    const cmd = argv[0] ?? "run";
    if (argv.includes("--approve")) this.approveCaps = true; // approve a pending cap-breakpoint
    if (cmd === "run" || cmd === "resume") {
      const r = cmd === "resume"
        ? await this.resume({ actor: argvValue(argv, "--actor"), reason: argvValue(argv, "--reason") })
        : await this.run();
      console.log(JSON.stringify(r));
      process.exitCode = resultExitCode(r);
    } else if (cmd === "step") {
      const r = await this.step();
      console.log(JSON.stringify(r));
      process.exitCode = resultExitCode(r);
    } else if (cmd === "doctor") {
      const ok = await this.doctor();
      process.exitCode = ok ? 0 : 1;
    } else if (cmd === "recover") {
      const actionFlags = ["retry", "assume-done", "abort"].filter((action) => argv.includes(`--${action}`));
      if (actionFlags.length !== 1) throw new Error("recover requires exactly one of --retry, --assume-done, or --abort");
      const action = actionFlags[0] as UncertainResolution["action"];
      const reason = argvValue(argv, "--reason");
      if (!reason) throw new Error("recover requires --reason <text>");
      const actor = argvValue(argv, "--actor");
      let resolution: UncertainResolution;
      if (action === "assume-done") {
        const raw = argvValue(argv, "--result-json");
        if (raw === undefined) throw new Error("--assume-done requires --result-json <json>");
        let result: unknown;
        try {
          result = JSON.parse(raw);
        } catch (e) {
          throw new Error(`invalid --result-json: ${(e as Error).message}`);
        }
        resolution = { action, reason, actor, result };
      } else {
        resolution = { action, reason, actor };
      }
      const r = await this.recoverUncertain(resolution);
      console.log(JSON.stringify(r));
      process.exitCode = resultExitCode(r);
    } else if (cmd === "stop") {
      const reason = argvValue(argv, "--reason");
      if (!reason) throw new Error("stop requires --reason <text>");
      const request = this.requestStop({ reason, actor: argvValue(argv, "--actor") });
      console.log(JSON.stringify({ status: "stop-requested", request }));
      process.exitCode = 0;
    } else {
      console.error(`loop: unknown command '${cmd}' (use run | step | resume | stop | recover | doctor)`);
      process.exitCode = 1;
    }
  }
}

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function resultExitCode(result: RunResult): number {
  if (result.status === "failed") return 1;
  // Intervention is required. A distinct code prevents schedulers from treating uncertainty as
  // success without encouraging an automatic generic retry of the same external effect.
  if (result.status === "uncertain") return 2;
  return 0;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

function loadInputsFile(cwd: string): Record<string, unknown> {
  const p = join(cwd, "inputs.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createRuntime(config: RuntimeConfig, options?: RuntimeOptions): Runtime {
  return new Runtime(config, options);
}
