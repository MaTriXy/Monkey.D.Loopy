/**
 * Spec interpreter: turn a validated LoopSpec into a @loopyc/runtime RuntimeConfig
 * WITHOUT codegen, by closing over core's expression engine. This is the execution
 * path `verify` drives (against mocked effects) — it mirrors the adapters' lowering
 * 1:1 (same expr engine, same runtime), so a loop that verifies behaves like the
 * compiled artifact.
 */
import { evaluate, parseGuard, parseInterpolations, type EvalContext } from "@loopyc/core";
import type { ExitAction, Gate, LoopSpec, OnDone, Step } from "@loopyc/core";
import type { LoopCtx, RuntimeConfig } from "@loopyc/runtime";

/** Group gates by the step id they fire after; gates with no `after` run once at the body end.
 *  Mirrors the standalone/babysitter emitters so `loopc run`/verify/MCP enforce gates identically. */
function groupGates(gates: Gate[] | undefined): { byStep: Map<string, Gate[]>; trailing: Gate[] } {
  const byStep = new Map<string, Gate[]>();
  const trailing: Gate[] = [];
  for (const g of gates ?? []) {
    if (g.after) byStep.set(g.after, [...(byStep.get(g.after) ?? []), g]);
    else trailing.push(g);
  }
  return { byStep, trailing };
}

async function fireGate(gate: Gate, ctx: LoopCtx, scope: Record<string, unknown>): Promise<void> {
  if (gate.when && !guard(gate.when, ctx, scope)) return;
  await ctx.breakpoint({ ask: interp(gate.ask, ctx, scope), strategy: gate.strategy, autoApproveIn: gate.auto_approve_in });
}

function evalCtx(ctx: LoopCtx, scope: Record<string, unknown>): EvalContext {
  return { state: ctx.state, inputs: ctx.inputs, env: ctx.env, meta: ctx.meta, iteration: ctx.iteration, ...scope };
}

function guard(src: string, ctx: LoopCtx, scope: Record<string, unknown>): unknown {
  return evaluate(parseGuard(src), evalCtx(ctx, scope));
}

function interp(src: string, ctx: LoopCtx, scope: Record<string, unknown>): string {
  return parseInterpolations(src)
    .map((seg) => (seg.kind === "lit" ? seg.text : String(evaluate(seg.ast, evalCtx(ctx, scope)))))
    .join("");
}

function value(v: unknown, ctx: LoopCtx, scope: Record<string, unknown>): unknown {
  return typeof v === "string" ? interp(v, ctx, scope) : v;
}

function applySave(save: Record<string, string> | undefined, src: unknown, ctx: LoopCtx): void {
  for (const [k, path] of Object.entries(save ?? {})) ctx.state[k] = ctx.jsonpath(src, path);
}

function applyOnDone(onDone: OnDone | undefined, ctx: LoopCtx, scope: Record<string, unknown>): void {
  if (!onDone) return;
  if (onDone.incr) ctx.state[onDone.incr] = (ctx.state[onDone.incr] as number) + 1;
  for (const [k, v] of Object.entries(onDone.set ?? {})) ctx.state[k] = value(v, ctx, scope);
  for (const [k, v] of Object.entries(onDone.append ?? {})) {
    // matches the emitted `state["k"].push(...)` — list vars are init'd to arrays (validator-enforced)
    (ctx.state[k] as unknown[]).push(value(v, ctx, scope));
  }
}

async function execSteps(
  steps: Step[],
  ctx: LoopCtx,
  scope: Record<string, unknown>,
  gates: Map<string, Gate[]>
): Promise<void> {
  for (const step of steps) {
    const skip = Boolean(step.when) && !guard(step.when!, ctx, scope);
    if (!skip) await execStep(step, ctx, scope, gates);
    // the emitters place a step's after-gate OUTSIDE the step's `if (when) {...}` block, so it
    // fires regardless of whether the step ran (the gate has its own `when`). Match that here.
    for (const g of gates.get(step.id) ?? []) await fireGate(g, ctx, scope);
  }
}

async function execStep(step: Step, ctx: LoopCtx, scope: Record<string, unknown>, gates: Map<string, Gate[]>): Promise<void> {
    switch (step.kind) {
      case "http": {
        const res = await ctx.http({
          method: step.request.method,
          url: interp(step.request.url, ctx, scope),
          headers: mapValues(step.request.headers, (v) => interp(v, ctx, scope)),
          body: value(step.request.body, ctx, scope),
          envelope: step.envelope,
        });
        applySave(step.save, res, ctx);
        applyOnDone(step.on_done, ctx, scope);
        break;
      }
      case "shell": {
        const cmd = step.args
          ? { command: interp(step.cmd, ctx, scope), args: step.args.map((a) => interp(a, ctx, scope)) }
          : interp(step.cmd, ctx, scope);
        const out = await ctx.shell(cmd);
        applySave(step.save, out, ctx);
        applyOnDone(step.on_done, ctx, scope);
        break;
      }
      case "agent": {
        const r = await ctx.agent({
          harness: step.harness,
          prompt: interp(step.prompt, ctx, scope),
          allowedTools: step["allowed-tools"],
        });
        applySave(step.save, r, ctx);
        applyOnDone(step.on_done, ctx, scope);
        break;
      }
      case "breakpoint":
        await ctx.breakpoint({ ask: interp(step.ask, ctx, scope), strategy: step.strategy, autoApproveIn: step.auto_approve_in });
        break;
      case "sleep":
        if (step.for) await ctx.sleep(step.for);
        else await ctx.sleepUntil(() => Boolean(guard(step.until!, ctx, scope)));
        break;
      case "reduce": {
        const alias = step.as ?? "item";
        const coll = guard(step.over, ctx, scope);
        // strict (matches the emitted `for...of`): a non-iterable `over` throws here too,
        // so verify surfaces the problem instead of silently iterating nothing.
        for (const item of coll as Iterable<unknown>) {
          await execSteps(step.body, ctx, { ...scope, [alias]: item }, gates);
        }
        break;
      }
    }
}

async function execExit(action: ExitAction, ctx: LoopCtx): Promise<void> {
  if (action.kind === "shell") await ctx.shell(interp(action.cmd ?? "", ctx, {}));
  else if (action.kind === "http") {
    await ctx.http({
      method: action.request?.method ?? "GET",
      url: interp(action.request?.url ?? "", ctx, {}),
      headers: mapValues(action.request?.headers, (v) => interp(v, ctx, {})),
      body: value(action.request?.body, ctx, {}),
      envelope: action.envelope,
    });
  } else await ctx.agent({ harness: action.harness ?? "llm", prompt: interp(action.prompt ?? "", ctx, {}) });
}

function mapValues<T, U>(obj: Record<string, T> | undefined, fn: (v: T) => U): Record<string, U> | undefined {
  if (!obj) return undefined;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

/** Build a runnable RuntimeConfig from a validated spec (no codegen). */
export function interpretLoop(spec: LoopSpec): RuntimeConfig {
  return {
    spec: {
      id: spec.id,
      meta: spec.meta as Record<string, unknown> | undefined,
      caps: spec.caps,
      schedule: spec.schedule,
      retry: spec.retry,
      signal: spec.terminate.signal,
      observe: spec.observe as Record<string, unknown> | undefined,
    },
    initialState: () =>
      Object.fromEntries(Object.entries(spec.state?.vars ?? {}).map(([k, d]) => [k, structuredClone(d.init)])),
    terminate: (ctx) => Boolean(guard(spec.terminate.until, ctx, {})),
    fingerprint: spec.caps.no_progress ? (ctx) => String(guard(spec.caps.no_progress!.fingerprint, ctx, {})) : undefined,
    iterate: async (ctx) => {
      const { byStep, trailing } = groupGates(spec.gates);
      await execSteps(spec.body, ctx, {}, byStep);
      for (const g of trailing) await fireGate(g, ctx, {}); // after-less gates fire once per iteration
    },
    onExit: spec.terminate.on_exit ? (ctx) => execExit(spec.terminate.on_exit!, ctx) : undefined,
  };
}

/** Dummy inputs so interpolation/guards don't throw during a dry-run. */
export function sampleInputs(spec: LoopSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(spec.inputs ?? {})) {
    if (decl.default !== undefined) out[name] = decl.default;
    else if (decl.type === "int" || decl.type === "number") out[name] = 0;
    else if (decl.type === "boolean") out[name] = false;
    else if (decl.type === "json" || decl.type === "list") out[name] = [];
    else out[name] = "x";
  }
  return out;
}
