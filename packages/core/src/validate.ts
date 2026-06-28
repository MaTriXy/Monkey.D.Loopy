/**
 * Two-tier validation.
 *
 *  - HARD gates (severity "error"): compile-blocking. This is where Monkey D Loopy
 *    refuses to emit an unbounded or un-runnable loop — missing/weak termination,
 *    a predicate that can never change, references to undeclared bindings, faked
 *    step outputs, unsafe expressions.
 *  - SOFT rules (severity "warning"/"info"): authoring guidance that downgrades the
 *    scorecard but does not block (weak signal, auto-injected caps, no observability).
 */
import {
  ALLOWED_ROOTS,
  collectRefs,
  ExprError,
  parseGuard,
  parseInterpolations,
  validateRefs,
  type ExprNode,
  type RefScope,
} from "./expr.js";
import { isValidDuration } from "./duration.js";
import type { NormalizedSpec } from "./normalize.js";
import type { Step } from "./types.js";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  info: Diagnostic[];
  diagnostics: Diagnostic[];
}

const LOOPY_TYPE_RE = /^(string|int|number|boolean|json|list|enum\[[^\]]+\])$/;
/** A 5- or 6-field cron expression. Each field is a comma-list of elements; each element is a
 *  number, a range, or a star — any of which may carry a /step. (Structural only — see
 *  cronOutOfRange for per-field numeric bounds.) */
const CRON_ELEM = String.raw`(?:\d+(?:-\d+)?|\*)(?:\/\d+)?`;
const CRON_FIELD = String.raw`(?:${CRON_ELEM})(?:,(?:${CRON_ELEM}))*`;
const CRON_RE = new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4,5}$`);
/** Per-field numeric bounds. 5-field: [min,hour,dom,month,dow]; 6-field: a leading seconds field. */
const CRON_BOUNDS_5: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** True if any numeric token in a structurally-valid cron is out of its field's range. */
function cronOutOfRange(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  const bounds = fields.length === 6 ? ([[0, 59], ...CRON_BOUNDS_5] as [number, number][]) : CRON_BOUNDS_5;
  return fields.some((field, i) => {
    const [lo, hi] = bounds[i]!;
    return field.split(",").some((elem) => {
      const [rangePart, stepPart] = elem.split("/");
      if (stepPart !== undefined && !(Number(stepPart) >= 1)) return true; // /0 or /NaN
      if (rangePart === "*") return false;
      // a plain number or a-b range — every numeric endpoint must be within [lo, hi]
      return rangePart!.split("-").some((n) => {
        const v = Number(n);
        return !Number.isInteger(v) || v < lo || v > hi;
      });
    });
  });
}

/** Whether a declared `init`/`default` value is consistent with its Loopy type. */
function typeMatchesValue(type: string, value: unknown): boolean {
  if (value === undefined || value === null) return true; // an absent value is fine
  if (type === "int") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  if (type === "json") return true;
  if (type === "list") return Array.isArray(value);
  const em = /^enum\[([^\]]+)\]$/.exec(type);
  if (em) return em[1]!.split(/[|,]/).map((s) => s.trim()).includes(String(value));
  return true; // unknown type is reported by bad-type elsewhere
}
const NUMERIC_TYPES = new Set(["int", "number"]);
const LIST_TYPES = new Set(["list"]);
/** Valid JS-binding identifier — every spec-supplied name interpolated into generated code must match. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** JS reserved words: a `reduce.as` alias matching one emits `for (const <word> of …)` → SyntaxError. */
const JS_RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function",
  "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this",
  "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield", "let", "static",
  "implements", "interface", "package", "private", "protected", "public",
]);
/** Identifiers the emitters bind in the iterate/process scope — a reduce alias must not shadow them. */
const EMITTER_RESERVED = new Set([
  "ctx", "state", "inputs", "env", "meta", "iteration", "spec", "runtime",
  "__res", "__out", "__in", "__fp", "__waited",
]);
/** Valid id (also excludes CR/LF so it is safe inside generated `// ...` comments). */
const ID_RE = /^[A-Za-z0-9_.:-]+$/;

/** How a step's write to a var contributes to exit-reachability liveness (see validate()). */
interface WriterLiveness {
  /** A top-level writer that is unguarded (or guarded only by an always-advancing `iteration`). */
  unconditional: boolean;
  /** State vars this top-level writer's `when` depends on (null when it contributes no liveness). */
  guardDeps: string[] | null;
}

export function validate(normalized: NormalizedSpec): ValidationResult {
  const { spec, capsInjected } = normalized;
  const diags: Diagnostic[] = [];
  const err = (code: string, message: string, path?: string) =>
    diags.push({ severity: "error", code, message, path });
  const warn = (code: string, message: string, path?: string) =>
    diags.push({ severity: "warning", code, message, path });
  const info = (code: string, message: string, path?: string) =>
    diags.push({ severity: "info", code, message, path });

  const stateVars = new Set(Object.keys(spec.state?.vars ?? {}));
  const inputs = new Set(Object.keys(spec.inputs ?? {}));
  const baseScope: RefScope = { stateVars, inputs };

  // --- identifier safety: names flow into generated JS, so they must be safe ---
  if (!ID_RE.test(spec.id)) {
    err("bad-id", `loop id '${spec.id}' must match ${ID_RE} (letters, digits, _ . : - ; no newlines)`, "id");
  }

  // --- declared type sanity -------------------------------------------------
  for (const [name, decl] of Object.entries(spec.state?.vars ?? {})) {
    if (!NAME_RE.test(name)) {
      err("bad-name", `state var name '${name}' is not a valid identifier`, `state.vars.${name}`);
    }
    if (!LOOPY_TYPE_RE.test(decl.type)) {
      err("bad-type", `state var '${name}' has invalid type '${decl.type}'`, `state.vars.${name}`);
    }
    if (decl.type === "list" && !Array.isArray(decl.init)) {
      err("bad-init", `state var '${name}' is type 'list' but its init is not an array`, `state.vars.${name}`);
    } else if (decl.type !== "list" && LOOPY_TYPE_RE.test(decl.type) && !typeMatchesValue(decl.type, decl.init)) {
      err("bad-init", `state var '${name}' init ${JSON.stringify(decl.init)} does not match type '${decl.type}'`, `state.vars.${name}`);
    }
  }
  for (const [name, decl] of Object.entries(spec.inputs ?? {})) {
    if (!NAME_RE.test(name)) {
      err("bad-name", `input name '${name}' is not a valid identifier`, `inputs.${name}`);
    }
    if (!LOOPY_TYPE_RE.test(decl.type)) {
      err("bad-type", `input '${name}' has invalid type '${decl.type}'`, `inputs.${name}`);
    } else if (decl.default !== undefined && !typeMatchesValue(decl.type, decl.default)) {
      err("bad-init", `input '${name}' default ${JSON.stringify(decl.default)} does not match type '${decl.type}'`, `inputs.${name}`);
    }
  }

  // --- step walk: ids, completeness, expressions, mutations -----------------
  const seenIds = new Set<string>();
  const mutatedVars = new Set<string>();
  // Exit-reachability refinement: a var has an "unconditional" writer if some top-level step
  // writes it with no `when` (or a `when` that reads `iteration`, which always advances). A
  // guarded top-level writer instead records the state vars its `when` depends on, so we can tell
  // whether the guard can ever flip (a writer behind `${state.x == 0}` is live iff `x` is live).
  const unconditionalWriters = new Set<string>();
  const guardedWriters = new Map<string, Set<string>>();

  const checkGuard = (src: string, path: string, scope: RefScope): ExprNode | null => {
    try {
      const ast = parseGuard(src);
      for (const p of validateRefs(ast, scope)) err("bad-ref", `${path}: ${p}`, path);
      return ast;
    } catch (e) {
      if (e instanceof ExprError) err("bad-expr", `${path}: ${e.message}`, path);
      else throw e;
    }
    return null;
  };

  const checkTemplate = (src: string, path: string, scope: RefScope): void => {
    try {
      for (const seg of parseInterpolations(src)) {
        if (seg.kind === "expr") {
          for (const p of validateRefs(seg.ast, scope)) err("bad-ref", `${path}: ${p}`, path);
        }
      }
    } catch (e) {
      if (e instanceof ExprError) err("bad-expr", `${path}: ${e.message}`, path);
      else throw e;
    }
  };

  /** Record that a step writes `varName`, tracking whether that write is unconditional/live. */
  const recordWrite = (varName: string, w: WriterLiveness): void => {
    mutatedVars.add(varName);
    if (w.unconditional) {
      unconditionalWriters.add(varName);
    } else if (w.guardDeps) {
      const set = guardedWriters.get(varName) ?? new Set<string>();
      for (const d of w.guardDeps) set.add(d);
      guardedWriters.set(varName, set);
    }
  };

  const checkMutationTargets = (
    step: Extract<Step, { kind: "agent" | "shell" | "http" }>,
    path: string,
    scope: RefScope,
    w: WriterLiveness
  ): void => {
    const save = "save" in step ? step.save : undefined;
    for (const [varName, jsonPath] of Object.entries(save ?? {})) {
      if (!stateVars.has(varName)) {
        err("bad-binding", `${path}.save writes undeclared state var '${varName}'`, path);
      } else {
        recordWrite(varName, w);
      }
      if (typeof jsonPath === "string" && !jsonPath.startsWith("$")) {
        warn("jsonpath", `${path}.save['${varName}'] should be a json-path starting with '$'`, path);
      }
    }
    const onDone = step.on_done;
    if (onDone?.incr) {
      const decl = spec.state?.vars?.[onDone.incr];
      if (!decl) {
        err("bad-binding", `${path}.on_done.incr targets undeclared state var '${onDone.incr}'`, path);
      } else {
        if (!NUMERIC_TYPES.has(decl.type)) {
          err("bad-binding", `${path}.on_done.incr targets non-numeric state var '${onDone.incr}'`, path);
        }
        recordWrite(onDone.incr, w);
      }
    }
    for (const [varName, value] of Object.entries(onDone?.set ?? {})) {
      if (!stateVars.has(varName)) {
        err("bad-binding", `${path}.on_done.set writes undeclared state var '${varName}'`, path);
      } else {
        recordWrite(varName, w);
      }
      if (typeof value === "string") checkTemplate(value, `${path}.on_done.set.${varName}`, scope);
    }
    for (const [varName, value] of Object.entries(onDone?.append ?? {})) {
      const decl = spec.state?.vars?.[varName];
      if (!decl) {
        err("bad-binding", `${path}.on_done.append targets undeclared state var '${varName}'`, path);
      } else {
        if (!LIST_TYPES.has(decl.type)) {
          err("bad-binding", `${path}.on_done.append targets non-list state var '${varName}' (declare it as 'list')`, path);
        }
        recordWrite(varName, w);
      }
      if (typeof value === "string") checkTemplate(value, `${path}.on_done.append.${varName}`, scope);
    }
  };

  const walk = (steps: Step[], scope: RefScope, prefix: string, topLevel: boolean): void => {
    steps.forEach((step, idx) => {
      const path = `${prefix}[${idx}]:${step.id}`;
      if (!step.id) err("step-id", `${path} has an empty id`, path);
      else if (!ID_RE.test(step.id)) {
        err("bad-id", `step id '${step.id}' must match ${ID_RE} (no newlines)`, path);
      }
      if (seenIds.has(step.id)) err("dup-id", `duplicate step id '${step.id}'`, path);
      seenIds.add(step.id);

      const guardAst = step.when ? checkGuard(step.when, `${path}.when`, scope) : null;
      // classify this step as an exit-var writer: top-level + unguarded (or a guard that reads
      // `iteration`, which always advances) is "unconditional"; a top-level guarded step records
      // its guard's state deps; a step inside a reduce contributes nothing (never unconditional).
      let w: WriterLiveness = { unconditional: false, guardDeps: null };
      if (topLevel) {
        if (!step.when) w = { unconditional: true, guardDeps: null };
        else if (guardAst) {
          const grefs = collectRefs(guardAst);
          if (grefs.some((p) => p[0] === "iteration")) w = { unconditional: true, guardDeps: null };
          else w = { unconditional: false, guardDeps: grefs.filter((p) => p[0] === "state" && p[1]).map((p) => p[1]!) };
        }
      }

      switch (step.kind) {
        case "agent":
          checkTemplate(step.prompt, `${path}.prompt`, scope);
          checkMutationTargets(step, path, scope, w);
          break;
        case "shell":
          checkTemplate(step.cmd, `${path}.cmd`, scope);
          for (const [ai, a] of (step.args ?? []).entries()) checkTemplate(a, `${path}.args[${ai}]`, scope);
          checkMutationTargets(step, path, scope, w);
          break;
        case "http":
          checkTemplate(step.request.url, `${path}.request.url`, scope);
          for (const [, v] of Object.entries(step.request.headers ?? {})) {
            checkTemplate(v, `${path}.request.headers`, scope);
          }
          // a STRING body is lowered as an interpolated template (emitValue→emitTemplate),
          // so it must honor the same ref-allowlist as url/headers; an object body is
          // JSON.stringify'd verbatim (no interpolation) and is safe.
          if (typeof step.request.body === "string") {
            checkTemplate(step.request.body, `${path}.request.body`, scope);
          }
          checkMutationTargets(step, path, scope, w);
          break;
        case "breakpoint":
          checkTemplate(step.ask, `${path}.ask`, scope);
          break;
        case "sleep": {
          const hasFor = typeof step.for === "string";
          const hasUntil = typeof step.until === "string";
          if (hasFor === hasUntil) {
            err("sleep-shape", `${path} must set exactly one of 'for' or 'until'`, path);
          }
          if (hasFor && !isValidDuration(step.for!)) {
            err("bad-duration", `${path}.for is not a valid duration: '${step.for}'`, path);
          }
          if (hasUntil) checkGuard(step.until!, `${path}.until`, scope);
          break;
        }
        case "reduce": {
          checkGuard(step.over, `${path}.over`, scope);
          const alias = step.as ?? "item";
          if (step.as !== undefined) {
            if (!NAME_RE.test(step.as)) {
              err("bad-alias", `${path}.as is not a valid identifier: '${step.as}'`, path);
            } else if (JS_RESERVED.has(step.as)) {
              err("bad-alias", `${path}.as '${step.as}' is a JS reserved word; the emitted 'for (const ${step.as} of …)' is a SyntaxError`, path);
            } else if (EMITTER_RESERVED.has(step.as) || ALLOWED_ROOTS.has(step.as)) {
              err("bad-alias", `${path}.as '${step.as}' shadows an emitter binding (ctx/state/inputs/…); the reduce body would break`, path);
            } else if (stateVars.has(step.as) || inputs.has(step.as)) {
              err("bad-alias", `${path}.as '${step.as}' shadows a declared state var / input, masking it inside the reduce body`, path);
            }
          }
          const innerScope: RefScope = {
            stateVars,
            inputs,
            extraRoots: new Set([...(scope.extraRoots ?? []), alias]),
          };
          walk(step.body, innerScope, `${path}.body`, false);
          break;
        }
      }
    });
  };

  walk(spec.body as Step[], baseScope, "body", true);

  // Transitive liveness: a var is "live" if it has an unconditional writer, or a guarded writer
  // whose `when` reads a var that is itself live (so the guard can actually flip). Used only to
  // soften the exit-reachability check into a warning — never to fail a spec.
  const liveVars = new Set(unconditionalWriters);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [v, deps] of guardedWriters) {
      if (liveVars.has(v)) continue;
      for (const d of deps) {
        if (liveVars.has(d)) {
          liveVars.add(v);
          changed = true;
          break;
        }
      }
    }
  }

  // --- termination: the load-bearing gate -----------------------------------
  if (!spec.terminate) {
    err(
      "no-terminate",
      "termination predicate required: add a `terminate:` block with a `signal` and an `until` expression. The compiler refuses to emit an unbounded loop."
    );
  } else {
    const t = spec.terminate;
    const untilAst = checkGuard(t.until, "terminate.until", baseScope);

    if ((t.signal === "self-assess" || t.signal === "llm-judge") && capsInjected) {
      err(
        "weak-signal",
        `${t.signal} termination requires EXPLICIT caps (don't rely on auto-injected defaults). Add a \`caps:\` block acknowledging the limits.`,
        "terminate.signal"
      );
    }
    if (t.signal === "self-assess") {
      warn("weak-signal", "self-assess is the weakest exit signal; prefer an oracle, state predicate, or judged rubric.", "terminate.signal");
    } else if (t.signal === "llm-judge") {
      warn("weak-signal", "llm-judge exit signals can loop on an unsatisfiable rubric; cap judge iterations and prefer an objective oracle where possible.", "terminate.signal");
    }

    // exit reachability: the predicate must read a signal that can actually change.
    if (untilAst) {
      const refs = collectRefs(untilAst);
      const stateRefs = refs.filter((p) => p[0] === "state" && p[1]).map((p) => p[1]!);
      const usesIteration = refs.some((p) => p[0] === "iteration");
      if (stateRefs.length === 0 && !usesIteration) {
        err(
          "unreachable-exit",
          "termination predicate references no mutable signal (no state var, no iteration); it can never change, so the loop cannot terminate.",
          "terminate.until"
        );
      } else if (stateRefs.length > 0) {
        const writable = stateRefs.filter((v) => mutatedVars.has(v));
        if (writable.length === 0 && !usesIteration) {
          err(
            "unreachable-exit",
            `termination predicate reads state var(s) [${stateRefs.join(", ")}] that no step ever writes; the loop cannot terminate.`,
            "terminate.until"
          );
        } else if (writable.length > 0 && !usesIteration && !writable.some((v) => liveVars.has(v))) {
          // Every writer of the exit var(s) is behind a `when` guard (whose guard can't be shown to
          // flip) or lives inside a reduce — so the predicate may never flip on its own and only the
          // cap would stop the loop. Non-blocking authoring guidance; never an error.
          warn(
            "cap-only-termination",
            `every writer of exit var(s) [${writable.join(", ")}] is conditionally gated (behind a \`when\`) or inside a reduce; the predicate may never flip on its own, leaving only the cap to stop the loop. Add an unconditional writer, or confirm the cap is the intended bound.`,
            "terminate.until"
          );
        }
      }
    }

    // on_exit actions are lowered to generated code — reference-check their templates.
    if (t.on_exit) {
      if (t.on_exit.cmd) checkTemplate(t.on_exit.cmd, "terminate.on_exit.cmd", baseScope);
      if (t.on_exit.prompt) checkTemplate(t.on_exit.prompt, "terminate.on_exit.prompt", baseScope);
      if (t.on_exit.request) {
        checkTemplate(t.on_exit.request.url, "terminate.on_exit.request.url", baseScope);
        for (const [, v] of Object.entries(t.on_exit.request.headers ?? {})) {
          checkTemplate(v, "terminate.on_exit.request.headers", baseScope);
        }
        if (typeof t.on_exit.request.body === "string") {
          checkTemplate(t.on_exit.request.body, "terminate.on_exit.request.body", baseScope);
        }
      }
      // an on_exit action is lowered to a real effect call; require the field its kind needs
      // (else http→ctx.http({})→fetch(undefined), shell→empty cmd, agent→empty prompt).
      if (t.on_exit.kind === "http" && !t.on_exit.request) {
        err("exit-action", "terminate.on_exit kind 'http' requires a `request`.", "terminate.on_exit");
      }
      if (t.on_exit.kind === "shell" && !t.on_exit.cmd) {
        err("exit-action", "terminate.on_exit kind 'shell' requires a `cmd`.", "terminate.on_exit");
      }
      if (t.on_exit.kind === "agent" && !t.on_exit.prompt) {
        err("exit-action", "terminate.on_exit kind 'agent' requires a `prompt`.", "terminate.on_exit");
      }
    }
  }

  // --- caps -----------------------------------------------------------------
  const caps = spec.caps;
  if (caps.no_progress) checkGuard(caps.no_progress.fingerprint, "caps.no_progress.fingerprint", baseScope);
  if (caps.budget?.wallclock && !isValidDuration(caps.budget.wallclock)) {
    err("bad-duration", `caps.budget.wallclock is not a valid duration: '${caps.budget.wallclock}'`, "caps.budget.wallclock");
  }
  if (capsInjected) {
    info("caps-injected", `caps were auto-injected (max_iterations=${caps.max_iterations}); review them for your cost tolerance.`);
  }
  if (!caps.no_progress && (spec.pattern === "loop-until-dry" || spec.pattern === "poll-until")) {
    warn("no-fingerprint", "no `caps.no_progress` fingerprint set; max_iterations alone misses thrash (identical repeated states). Add one.", "caps");
  }
  if (!caps.budget) {
    warn("no-budget", "no token/$/wallclock budget set; consider adding `caps.budget` to bound cost.", "caps");
  }

  // --- schedule & gates -----------------------------------------------------
  if (spec.schedule?.mode === "cron" && !spec.schedule.cron) {
    err("cron-missing", "schedule.mode is 'cron' but no `schedule.cron` expression is set.", "schedule");
  } else if (spec.schedule?.cron && !CRON_RE.test(spec.schedule.cron.trim())) {
    err("bad-cron", `schedule.cron '${spec.schedule.cron}' is not a valid 5/6-field cron expression.`, "schedule.cron");
  } else if (spec.schedule?.cron && cronOutOfRange(spec.schedule.cron)) {
    err("bad-cron", `schedule.cron '${spec.schedule.cron}' has an out-of-range field (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-7).`, "schedule.cron");
  }
  for (const [i, gate] of (spec.gates ?? []).entries()) {
    if (gate.after && !seenIds.has(gate.after)) {
      err("gate-ref", `gates[${i}].after references unknown step id '${gate.after}'`, `gates[${i}]`);
    }
    if (gate.when) checkGuard(gate.when, `gates[${i}].when`, baseScope);
    if (gate.ask) checkTemplate(gate.ask, `gates[${i}].ask`, baseScope);
  }

  // --- observability --------------------------------------------------------
  if (spec.observe?.trace === "none") {
    warn("no-trace", "observe.trace is 'none'; without a journal trace, failures are hard to diagnose.", "observe.trace");
  }

  const errors = diags.filter((d) => d.severity === "error");
  const warnings = diags.filter((d) => d.severity === "warning");
  const infos = diags.filter((d) => d.severity === "info");
  return { ok: errors.length === 0, errors, warnings, info: infos, diagnostics: diags };
}

export function formatValidation(result: ValidationResult): string {
  if (result.diagnostics.length === 0) return "✓ valid (no diagnostics)";
  const icon: Record<Severity, string> = { error: "✗", warning: "⚠", info: "ℹ" };
  const lines = result.diagnostics.map((d) => {
    const where = d.path ? ` (${d.path})` : "";
    return `  ${icon[d.severity]} [${d.code}] ${d.message}${where}`;
  });
  const header = result.ok
    ? `✓ valid — ${result.warnings.length} warning(s), ${result.info.length} note(s)`
    : `✗ invalid — ${result.errors.length} error(s), ${result.warnings.length} warning(s)`;
  return [header, ...lines].join("\n");
}
