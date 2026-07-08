/**
 * LoopSpec IR — the single typed contract that every input (NL brief, blueprint,
 * hand-written YAML) normalizes into before any code is emitted.
 *
 * The load-bearing invariant of Monkey D Loopy lives here in the type shape and is
 * enforced by the validator: every loop MUST declare a termination predicate and
 * MUST carry caps. The compiler refuses to emit an unbounded loop.
 */

export const LOOPSPEC_VERSION = "0.1";

/** Strength of the exit/verify signal, strongest first. Drives the scorecard. */
export type SignalTier = "oracle" | "state-predicate" | "llm-judge" | "self-assess";

/** Named outer-loop archetypes. The inner ReAct turn is owned by the harness, never by Loopy. */
export type LoopPattern =
  | "react"
  | "plan-execute-reflect"
  | "evaluator-optimizer"
  | "loop-until-dry"
  | "map-reduce"
  | "poll-until"
  | "cron";

/** Runtime targets a LoopSpec can be lowered to. */
export type RuntimeTarget = "standalone" | "babysitter" | "claude-code" | "claude-native" | "n8n";

/** Closed enum of step kinds. No raw code — keeps emitted loops auditable. */
export type StepKind = "agent" | "shell" | "http" | "breakpoint" | "sleep" | "reduce";

/** What surfaces to emit alongside the runnable loop. */
export type EmitSurface = "cli" | "skill" | "doctor";

export type ScheduleMode = "manual" | "cron" | "watch" | "forever";

export type CapAction = "fail" | "breakpoint" | "exit-clean";

export type GateStrategy = "single" | "first-wins" | "quorum";

/** A tiny scalar/structured type language used for inputs and state vars. */
export type LoopyType =
  | "string"
  | "int"
  | "number"
  | "boolean"
  | "json"
  | "list"
  | `enum[${string}]`;

export interface LoopMeta {
  name?: string;
  version?: string;
  description?: string;
}

export interface Provenance {
  factory_version?: string;
  source?: string;
  run_id?: string;
}

export interface TargetSpec {
  /** Default runtime if `loopc compile` is not given an explicit --target. */
  runtime?: RuntimeTarget;
  emit?: EmitSurface[];
}

export interface InputDecl {
  type: LoopyType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface StateVarDecl {
  type: LoopyType;
  init: unknown;
  description?: string;
}

export interface StateSpec {
  /** Only `journal` is supported in 0.1 — durable, event-sourced, you never manage storage. */
  store?: "journal" | "memory";
  vars: Record<string, StateVarDecl>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Mutations applied to state after a step completes. */
export interface OnDone {
  /** Increment a numeric state var by 1. */
  incr?: string;
  /** Set state vars to literal values or interpolated expressions. */
  set?: Record<string, unknown>;
  /** Append a value to a list state var (enables map-reduce accumulation). */
  append?: Record<string, unknown>;
}

interface StepBase {
  id: string;
  kind: StepKind;
  /** Guard expression (e.g. "${state.status == 'red'}"). Step runs only when truthy. */
  when?: string;
}

export interface AgentStep extends StepBase {
  kind: "agent";
  /** Harness that owns the inner ReAct turn. Built-ins (none is a default): `internal`, `llm`
   *  (provider-agnostic), and the coding-agent CLIs `claude-code` / `codex` / `opencode` /
   *  `antigravity` / `cursor-agent`, plus a generic `cli` (any tool via LOOPY_AGENT_CMD). */
  harness: string;
  prompt: string;
  "allowed-tools"?: string[];
  /** json-path extractions from the agent's structured result envelope into state vars. */
  save?: Record<string, string>;
  on_done?: OnDone;
}

export interface ShellStep extends StepBase {
  kind: "shell";
  /** Command. With `args`, this is the program name run via execFile (no shell). */
  cmd: string;
  /** When present, `cmd` + `args` run as an argv (no shell) — safer for untrusted data. */
  args?: string[];
  /** json-path extractions from stdout (parsed as JSON) into state vars. */
  save?: Record<string, string>;
  on_done?: OnDone;
}

export interface HttpStep extends StepBase {
  kind: "http";
  request: HttpRequest;
  /**
   * Opt-in: deliver a { status, ok, headers, body } envelope instead of the bare parsed body,
   * so `save` can read the HTTP status of a JSON response (`$.status` / `$.ok` / `$.body.field`).
   * Default (omitted/false) keeps the body-direct shape — existing loops are unaffected.
   */
  envelope?: boolean;
  /** json-path extractions from the response (body by default, or the envelope) into state vars. */
  save?: Record<string, string>;
  on_done?: OnDone;
}

export interface BreakpointStep extends StepBase {
  kind: "breakpoint";
  ask: string;
  strategy?: GateStrategy;
  auto_approve_in?: string[];
}

export interface SleepStep extends StepBase {
  kind: "sleep";
  /** Duration string like "5m", "24h". Mutually exclusive with `until`. */
  for?: string;
  /** Sleep until an expression becomes truthy (re-checked on resume). */
  until?: string;
}

export interface ReduceStep extends StepBase {
  kind: "reduce";
  /** Expression yielding the collection to fan out over. */
  over: string;
  /** Name bound to each element inside `body`. */
  as?: string;
  body: Step[];
}

export type Step =
  | AgentStep
  | ShellStep
  | HttpStep
  | BreakpointStep
  | SleepStep
  | ReduceStep;

export interface ExitAction {
  kind: "shell" | "http" | "agent";
  cmd?: string;
  request?: HttpRequest;
  /** For an `http` exit action: opt into the { status, ok, headers, body } envelope. */
  envelope?: boolean;
  harness?: string;
  prompt?: string;
}

export interface Terminate {
  /** Declares the strength of the signal. Strongest available should be used. */
  signal: SignalTier;
  /** Boolean predicate; loop exits when truthy. */
  until: string;
  on_exit?: ExitAction;
}

export interface NoProgress {
  /** Expression whose value is fingerprinted each iteration to detect thrash. */
  fingerprint: string;
  /** Stop after this many consecutive identical fingerprints. */
  max_repeats: number;
}

export interface Budget {
  tokens?: number;
  usd?: number;
  /** Wall-clock budget as a duration string, e.g. "24h". */
  wallclock?: string;
}

export interface Caps {
  max_iterations: number;
  no_progress?: NoProgress;
  budget?: Budget;
  on_cap_exceeded?: CapAction;
}

export interface ScheduleSpec {
  mode: ScheduleMode;
  /** Required when mode === "cron". */
  cron?: string;
}

/** Transient-error retry policy for http/shell/agent effects. */
export interface RetrySpec {
  /** Max retries after the first attempt (default 0). */
  max?: number;
  /** Base backoff in ms between retries; exponential. */
  backoff_ms?: number;
}

export interface Gate {
  /** Step id this gate fires after. */
  after?: string;
  when?: string;
  ask: string;
  strategy?: GateStrategy;
  auto_approve_in?: string[];
}

export interface HookAction {
  kind: "shell" | "http";
  cmd?: string;
  request?: HttpRequest;
}

export interface ObserveSpec {
  trace?: "journal" | "none";
  hooks?: Record<string, HookAction>;
  notify?: Record<string, unknown>;
}

export interface LoopSpec {
  loopspec: string;
  id: string;
  meta?: LoopMeta;
  pattern: LoopPattern;
  provenance?: Provenance;
  target?: TargetSpec;
  inputs?: Record<string, InputDecl>;
  state?: StateSpec;
  body: Step[];
  terminate: Terminate;
  caps: Caps;
  schedule?: ScheduleSpec;
  retry?: RetrySpec;
  gates?: Gate[];
  observe?: ObserveSpec;
}

/** Steps that may mutate state via save/on_done. */
export type MutatingStep = ShellStep | HttpStep | AgentStep;

export function isMutatingStep(s: Step): s is MutatingStep {
  return s.kind === "shell" || s.kind === "http" || s.kind === "agent";
}
