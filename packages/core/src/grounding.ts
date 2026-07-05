/**
 * Termination grounding — who actually feeds the exit predicate?
 *
 * A `terminate.until` predicate is only as trustworthy as the steps that write the
 * state it reads. A spec can declare `signal: state-predicate` (or even `oracle`)
 * while every value feeding the predicate comes from an agent step's own output —
 * that is self-assessment wearing a stronger label. This module classifies the
 * evidence chain so the validator can call it out and the scorecard can price it.
 *
 * Evidence tags per state var:
 *  - external   — an http/shell step `save`s into it (real-world evidence)
 *  - agent      — an agent step `save`s into it (the model's own report)
 *  - structural — only `on_done` mutations (incr/set/append): deterministic
 *                 sequencing that carries no evidence of its own
 *
 * Taints propagate: an `on_done` write inherits the taints of the state vars its
 * step's `when` guard reads and of the vars its `set`/`append` value expressions
 * read — a `done` flag set only when an agent-reported score clears a bar is still
 * agent-fed. `save` writes do NOT inherit guard taints: the saved value is genuine
 * evidence of its kind regardless of when the step ran.
 */
import { collectRefs, parseGuard, parseInterpolations, type ExprNode } from "./expr.js";
import type { Step } from "./types.js";

export type GroundingClass = "external" | "structural" | "mixed" | "agent" | "none";

export interface TerminationGrounding {
  /** Combined class of the exit predicate's evidence chain. */
  class: GroundingClass;
  /** State vars the predicate reads. */
  exitVars: string[];
  /** Exit vars (transitively) backed by http/shell evidence. */
  externalFed: string[];
  /** Exit vars (transitively) fed by agent output. */
  agentFed: string[];
  /** The predicate also (or only) reads `iteration` — a structural signal. */
  usesIteration: boolean;
}

interface VarTaint {
  external: boolean;
  agent: boolean;
  written: boolean;
  deps: Set<string>;
}

const stateRefsOf = (ast: ExprNode): string[] =>
  collectRefs(ast)
    .filter((p) => p[0] === "state" && p[1])
    .map((p) => p[1]!);

/** State refs inside a `${...}` template value; malformed templates contribute nothing
 *  (validate() reports them). */
function templateStateRefs(src: string): string[] {
  const out: string[] = [];
  try {
    for (const seg of parseInterpolations(src)) {
      if (seg.kind === "expr") out.push(...stateRefsOf(seg.ast));
    }
  } catch {
    /* reported by validate() */
  }
  return out;
}

function guardStateRefs(when: string | undefined): string[] {
  if (!when) return [];
  try {
    return stateRefsOf(parseGuard(when));
  } catch {
    return [];
  }
}

/** The minimal spec shape grounding needs — both the validator's pre-normalization
 *  view and a full LoopSpec satisfy it. */
export interface GroundingInput {
  body: Step[];
  terminate: { until: string };
}

export function terminationGrounding(spec: GroundingInput): TerminationGrounding {
  const taints = new Map<string, VarTaint>();
  const taintOf = (v: string): VarTaint => {
    let t = taints.get(v);
    if (!t) {
      t = { external: false, agent: false, written: false, deps: new Set() };
      taints.set(v, t);
    }
    return t;
  };

  const walk = (steps: Step[], inheritedGuardDeps: string[]): void => {
    for (const step of steps) {
      const guards = [...inheritedGuardDeps, ...guardStateRefs(step.when)];
      if (step.kind === "reduce") {
        walk(step.body, guards);
        continue;
      }
      if (step.kind !== "agent" && step.kind !== "shell" && step.kind !== "http") continue;

      for (const v of Object.keys(step.save ?? {})) {
        const t = taintOf(v);
        t.written = true;
        if (step.kind === "agent") t.agent = true;
        else t.external = true;
      }

      const od = step.on_done;
      if (!od) continue;
      const structuralWrite = (v: string, valueRefs: string[]): void => {
        const t = taintOf(v);
        t.written = true;
        for (const d of [...guards, ...valueRefs]) if (d !== v) t.deps.add(d);
      };
      if (od.incr) structuralWrite(od.incr, []);
      for (const [v, val] of Object.entries(od.set ?? {})) {
        structuralWrite(v, typeof val === "string" ? templateStateRefs(val) : []);
      }
      for (const [v, val] of Object.entries(od.append ?? {})) {
        structuralWrite(v, typeof val === "string" ? templateStateRefs(val) : []);
      }
    }
  };
  walk(spec.body, []);

  // Propagate dependency taints to a fixpoint — a structural write gated by an
  // agent-fed var is itself agent-fed.
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of taints.values()) {
      for (const d of t.deps) {
        const dt = taints.get(d);
        if (!dt) continue;
        if (dt.agent && !t.agent) {
          t.agent = true;
          changed = true;
        }
        if (dt.external && !t.external) {
          t.external = true;
          changed = true;
        }
      }
    }
  }

  let exitVars: string[] = [];
  let usesIteration = false;
  try {
    const refs = collectRefs(parseGuard(spec.terminate.until));
    exitVars = [...new Set(refs.filter((p) => p[0] === "state" && p[1]).map((p) => p[1]!))];
    usesIteration = refs.some((p) => p[0] === "iteration");
  } catch {
    /* a malformed `until` is a validate() error; nothing to ground */
  }

  const written = exitVars.filter((v) => taints.get(v)?.written);
  const externalFed = written.filter((v) => taints.get(v)!.external);
  const agentFed = written.filter((v) => taints.get(v)!.agent);

  let cls: GroundingClass;
  if (written.length === 0 && !usesIteration) cls = "none";
  else if (agentFed.length > 0 && externalFed.length > 0) cls = "mixed";
  else if (agentFed.length > 0) cls = "agent";
  else if (externalFed.length > 0) cls = "external";
  else cls = "structural";

  return { class: cls, exitVars, externalFed, agentFed, usesIteration };
}
