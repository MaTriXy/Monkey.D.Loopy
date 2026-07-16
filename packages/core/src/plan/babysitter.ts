/**
 * Babysitter adapter — lowers a LoopSpec into a valid babysitter durable process for
 * the @a5c-ai/babysitter-sdk (v0.0.x), relying on babysitter's event-sourced journal,
 * replay, breakpoints, and durable sleep as the execution engine.
 *
 * Reconciled against the real SDK API:
 *  - effects go through `ctx.task(definedTask, args)` where definedTask is created by
 *    `defineTask()` (inline task objects are rejected). We define one reusable shell task
 *    and one agent task, and pass the per-step command/prompt as args.
 *  - shell task shape is `{ kind: 'shell', shell: { command } }`; agent is
 *    `{ kind: 'agent', agent: { name, prompt }, execution: { harness } }`.
 *  - `ctx.task` returns the posted value directly (no stdout envelope) → `save` extracts
 *    with `__jsonpath(result, path)`.
 *  - `ctx.breakpoint(payload)` returns `{ approved, ... }` (an object) → branch on `.approved`.
 *  - `ctx.sleepUntil(target)` takes a timestamp; `ctx.now()` returns a Date → use
 *    `ctx.now().getTime() + ms`.
 *
 * Honest lowering notes (capability matrix flags these): `http` steps lower to a shell
 * `curl` task; token/$/wallclock budgets are not enforceable here (only max_iterations and
 * no-progress are generated as in-loop guards); `env` references resolve to `{}`.
 */
import type { Adapter, PlanResult, PlannedFile } from "./types.js";
import { capabilityWarnings } from "./types.js";
import { emitGuard, emitOnDone, emitTemplate } from "./step-emit.js";
import { parseDuration } from "../duration.js";
import { FACTORY_VERSION } from "../version.js";
import type { CapAction, ExitAction, Gate, LoopSpec, Step } from "../types.js";

const SDK_VERSION = "^0.0.188";

const RUNTIME_HELPERS = `function __in(l, r) {
  if (Array.isArray(r)) return r.includes(l);
  if (typeof r === "string") return r.includes(String(l));
  if (r && typeof r === "object") return l != null && String(l) in r;
  return false;
}
function __jsonpath(obj, path) {
  if (obj == null) return undefined;
  let cur = obj;
  for (const seg of String(path).replace(/^\\$\\.?/, "").split(".")) {
    if (!seg) continue;
    const m = /^([^\\[]*)(?:\\[(\\d+)\\])?$/.exec(seg);
    if (m && m[1]) cur = cur?.[m[1]];
    if (m && m[2] != null) cur = cur?.[Number(m[2])];
    if (cur == null) return undefined;
  }
  return cur;
}
function __sq(s) {
  // POSIX single-quote: wrap in quotes and replace each ' with '\\'' (built via char
  // codes so no quote/backslash literals appear here). Neutralizes $, backtick, \\\\, etc.
  var q = String.fromCharCode(39), bs = String.fromCharCode(92);
  return q + String(s).split(q).join(q + bs + q + q) + q;
}
function __curl(req) {
  const flags = ["-s", "-X", req.method];
  for (const [k, v] of Object.entries(req.headers || {})) flags.push("-H", __sq(k + ": " + v));
  if (req.body !== undefined) flags.push("--data", __sq(typeof req.body === "string" ? req.body : JSON.stringify(req.body)));
  // envelope: append a -w sentinel after the body so __httpEnv can recover the status/headers
  // (the body alone carries no status). %{header_json} needs curl >= 7.83 (else headers => {}).
  if (req.envelope) flags.push("-w", __sq("__LOOPY_HTTP__%{http_code}__LOOPY_SEP__%{header_json}"));
  flags.push(__sq(req.url));
  return "curl " + flags.join(" ");
}
function __tryJson(t) { try { return JSON.parse(t); } catch { return t; } }
function __httpEnv(raw) {
  // Reconstruct { status, ok, headers, body } from a curl whose -w writeout appended
  // "__LOOPY_HTTP__<status>__LOOPY_SEP__<header_json>" after the body. JS does the parsing,
  // so a non-JSON body is handled safely (the shell never has to assemble JSON itself).
  const s = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
  // Structure-aware split: match the sentinel + status digits + SEP and take the LAST well-formed
  // occurrence. The real writeout is appended at the very end, so a body/header value that merely
  // contains the literal sentinel can't hijack the split (a bare lastIndexOf could).
  const re = /__LOOPY_HTTP__(\\d+)__LOOPY_SEP__/g;
  let m, last;
  while ((m = re.exec(s)) !== null) last = m;
  if (!last) return { status: 0, ok: false, headers: {}, body: __tryJson(s) };
  const body = __tryJson(s.slice(0, last.index));
  const status = Number(last[1]) || 0;
  let headers = {};
  try {
    const parsed = JSON.parse(s.slice(last.index + last[0].length)) || {};
    // Normalize curl's header_json (original-case keys, ARRAY values) to execHttp's shape so the
    // { status, ok, headers, body } envelope is identical across targets: lowercase keys, joined
    // string values — so save: { ct: "$.headers.content-type" } reads a string here, as it does
    // under the standalone/interpreter execHttp.
    headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
  } catch {}
  return { status, ok: status >= 200 && status < 300, headers, body };
}`;

const TASK_DEFS = `const __shellTask = defineTask("loopy-shell", (args) => ({
  kind: "shell",
  title: args.title,
  shell: { command: args.command },
}));
const __agentTask = defineTask("loopy-agent", (args) => ({
  kind: "agent",
  title: args.title,
  agent: { name: args.name, prompt: args.prompt },
  execution: { harness: args.harness },
}));`;

/** Newlines in an id are already rejected by the validator; this is defense in depth. */
function safeComment(s: string): string {
  return String(s).replace(/[\r\n]/g, " ");
}

/**
 * Emit the cap-exceeded action. `reason` names which cap fired; `resetStmt` runs on an
 * approved breakpoint so the loop can continue without immediately re-tripping.
 */
function emitCapAction(
  action: CapAction | undefined,
  ind: string,
  reason: "max_iterations" | "no_progress",
  resetStmt: string
): string {
  switch (action ?? "breakpoint") {
    case "fail":
      return `${ind}throw new Error("cap exceeded: ${reason}");`;
    case "exit-clean":
      return `${ind}break;`;
    case "breakpoint":
    default:
      return [
        `${ind}const __r = await ctx.breakpoint({ label: "cap", question: "cap exceeded: ${reason} — approve continuation?" });`,
        `${ind}if (!__r.approved) break;`,
        `${ind}${resetStmt}`,
      ].join("\n");
  }
}

function emitSaveBaby(
  save: Record<string, string> | undefined,
  sourceVar: string,
  ind: string,
  lines: string[]
): void {
  for (const [varName, jsonPath] of Object.entries(save ?? {})) {
    lines.push(`${ind}state[${JSON.stringify(varName)}] = __jsonpath(${sourceVar}, ${JSON.stringify(jsonPath)});`);
  }
}

function emitHeadersBody(req: { headers?: Record<string, string>; body?: unknown }): string {
  let s = "";
  if (req.headers && Object.keys(req.headers).length > 0) {
    const h = Object.entries(req.headers)
      .map(([k, v]) => `${JSON.stringify(k)}: ${emitTemplate(v)}`)
      .join(", ");
    s += `, headers: { ${h} }`;
  }
  if (req.body !== undefined) s += `, body: ${emitTemplate(typeof req.body === "string" ? req.body : JSON.stringify(req.body))}`;
  return s;
}

/** Group gates by the step id they fire after; gates with no `after` run once at the body end. */
function groupGates(gates: Gate[] | undefined): { byStep: Map<string, Gate[]>; trailing: Gate[] } {
  const byStep = new Map<string, Gate[]>();
  const trailing: Gate[] = [];
  for (const g of gates ?? []) {
    if (g.after) byStep.set(g.after, [...(byStep.get(g.after) ?? []), g]);
    else trailing.push(g);
  }
  return { byStep, trailing };
}

/** A human gate lowers to a babysitter ctx.breakpoint (label/question shape). */
function emitGateBaby(gate: Gate, ind: string): string {
  const opts = [`label: "gate"`, `question: ${emitTemplate(gate.ask)}`];
  if (gate.strategy) opts.push(`strategy: ${JSON.stringify(gate.strategy)}`);
  const call = `await ctx.breakpoint({ ${opts.join(", ")} });`;
  if (gate.when) return [`${ind}if (${emitGuard(gate.when)}) {`, `${ind}  ${call}`, `${ind}}`].join("\n");
  return `${ind}${call}`;
}

function emitStepsBaby(steps: Step[], ind: string, gates: Map<string, Gate[]>): string {
  return steps.map((s) => emitStepBaby(s, ind, gates)).join("\n");
}

function emitStepBaby(step: Step, ind: string, gates: Map<string, Gate[]>): string {
  const ind2 = ind + "  ";
  const open = step.when ? `${ind}if (${emitGuard(step.when)}) {` : `${ind}{`;
  const inner = emitInnerBaby(step, ind2, gates);
  const out = [`${ind}// step: ${safeComment(step.id)}`, open, inner, `${ind}}`];
  for (const g of gates.get(step.id) ?? []) out.push(emitGateBaby(g, ind));
  return out.join("\n");
}

function emitInnerBaby(step: Step, ind: string, gates: Map<string, Gate[]>): string {
  const lines: string[] = [];
  switch (step.kind) {
    case "agent": {
      const args = [
        `title: ${JSON.stringify(step.id)}`,
        `name: ${JSON.stringify(step.id)}`,
        `prompt: ${emitTemplate(step.prompt)}`,
        `harness: ${JSON.stringify(step.harness)}`,
      ].join(", ");
      if (step.save && Object.keys(step.save).length > 0) {
        lines.push(`${ind}const __res = await ctx.task(__agentTask, { ${args} });`);
        emitSaveBaby(step.save, "__res", ind, lines);
      } else {
        lines.push(`${ind}await ctx.task(__agentTask, { ${args} });`);
      }
      emitOnDone(step.on_done, ind, lines);
      break;
    }
    case "shell": {
      const cmdExpr = step.args
        ? `[__sq(${emitTemplate(step.cmd)}), ${step.args.map((a) => `__sq(${emitTemplate(a)})`).join(", ")}].join(" ")`
        : emitTemplate(step.cmd);
      lines.push(`${ind}const __res = await ctx.task(__shellTask, { title: ${JSON.stringify(step.id)}, command: ${cmdExpr} });`);
      emitSaveBaby(step.save, "__res", ind, lines);
      emitOnDone(step.on_done, ind, lines);
      break;
    }
    case "http": {
      // lowered to a shell curl task (http is not a native babysitter task kind). With
      // `envelope`, the curl emits a -w status/header sentinel and __httpEnv rebuilds the
      // { status, ok, headers, body } shape so `save` can read `$.status` / `$.body.field`.
      const curlArg = `{ method: ${JSON.stringify(step.request.method)}, url: ${emitTemplate(step.request.url)}${emitHeadersBody(step.request)}${step.envelope ? ", envelope: true" : ""} }`;
      const call = `await ctx.task(__shellTask, { title: ${JSON.stringify(step.id)}, command: __curl(${curlArg}) })`;
      lines.push(`${ind}const __res = ${step.envelope ? `__httpEnv(${call})` : call};`);
      emitSaveBaby(step.save, "__res", ind, lines);
      emitOnDone(step.on_done, ind, lines);
      break;
    }
    case "breakpoint": {
      const opts = [`label: ${JSON.stringify(step.id)}`, `question: ${emitTemplate(step.ask)}`];
      if (step.strategy) opts.push(`strategy: ${JSON.stringify(step.strategy)}`);
      lines.push(`${ind}await ctx.breakpoint({ ${opts.join(", ")} });`);
      break;
    }
    case "sleep": {
      if (step.for) {
        lines.push(`${ind}await ctx.sleepUntil(ctx.now().getTime() + ${parseDuration(step.for)});`);
      } else {
        // honor the predicate: durably poll until it holds, bounded by MAX_ITERATIONS
        lines.push(`${ind}let __waited = 0;`);
        lines.push(`${ind}while (!(${emitGuard(step.until!)})) {`);
        lines.push(`${ind}  if (__waited++ >= MAX_ITERATIONS) break;`);
        lines.push(`${ind}  await ctx.sleepUntil(ctx.now().getTime() + 60000);`);
        lines.push(`${ind}}`);
      }
      break;
    }
    case "reduce": {
      const alias = step.as ?? "item";
      lines.push(`${ind}for (const ${alias} of (${emitGuard(step.over)})) {`);
      lines.push(emitStepsBaby(step.body, ind + "  ", gates));
      lines.push(`${ind}}`);
      break;
    }
  }
  return lines.join("\n");
}

function emitExitActionBaby(action: ExitAction, ind: string): string {
  switch (action.kind) {
    case "shell":
      return `${ind}await ctx.task(__shellTask, { title: "on_exit", command: ${emitTemplate(action.cmd ?? "")} });`;
    case "http":
      // on_exit results are discarded (ExitAction has no `save`), so the envelope's -w sentinel would
      // be emitted into a value nobody reads — pure garbage. Force envelope:false here regardless of
      // action.envelope so no sentinel is appended.
      return `${ind}await ctx.task(__shellTask, { title: "on_exit", command: __curl({ method: ${JSON.stringify(action.request?.method ?? "GET")}, url: ${emitTemplate(action.request?.url ?? "")} }) });`;
    case "agent":
      return `${ind}await ctx.task(__agentTask, { title: "on_exit", name: "on_exit", prompt: ${emitTemplate(action.prompt ?? "")}, harness: ${JSON.stringify(action.harness ?? "llm")} });`;
  }
}

function emitProcessFile(spec: LoopSpec): string {
  const initialState = Object.fromEntries(
    Object.entries(spec.state?.vars ?? {}).map(([k, d]) => [k, d.init])
  );
  const { byStep: gatesByStep, trailing: trailingGates } = groupGates(spec.gates);
  const p: string[] = [];
  p.push("// Generated by Monkey D Loopy (@loopyc/core). Target: babysitter durable process (@a5c-ai/babysitter-sdk).");
  p.push("// Do not hand-edit — edit the LoopSpec and recompile.");
  p.push(`// loop: ${safeComment(spec.id)}  pattern: ${spec.pattern}  exit: ${safeComment(spec.terminate.until)} (${spec.terminate.signal})`);
  p.push("");
  p.push('import { defineTask } from "@a5c-ai/babysitter-sdk";');
  p.push("");
  p.push(RUNTIME_HELPERS);
  p.push("");
  p.push(TASK_DEFS);
  p.push("");
  p.push(`export const spec = ${JSON.stringify({ id: spec.id, meta: spec.meta, pattern: spec.pattern, target: "babysitter", caps: spec.caps, schedule: spec.schedule }, null, 2)};`);
  p.push("");
  p.push("export async function process(inputs, ctx) {");
  p.push(`  const meta = ${JSON.stringify(spec.meta ?? {})};`);
  p.push("  const env = (ctx && ctx.env) || {}; // note: babysitter ProcessContext has no env; refs resolve to {}");
  p.push(`  let state = ${JSON.stringify(initialState)};`);
  p.push("  let iteration = 0;");
  if (spec.caps.no_progress) {
    p.push("  let __lastFp;");
    p.push("  let __fpRepeats = 0;");
  }
  p.push(`  const MAX_ITERATIONS = ${spec.caps.max_iterations};`);
  // iteration is 0-based inside the body (consistent with the standalone runtime + terminate guard).
  p.push(`  while (!(${emitGuard(spec.terminate.until)})) {`);
  p.push("    if (iteration >= MAX_ITERATIONS) {");
  p.push(emitCapAction(spec.caps.on_cap_exceeded, "      ", "max_iterations", "iteration = 0;"));
  p.push("    }");
  p.push(emitStepsBaby(spec.body, "    ", gatesByStep));
  for (const g of trailingGates) p.push(emitGateBaby(g, "    "));
  if (spec.caps.no_progress) {
    p.push(`    const __fp = String(${emitGuard(spec.caps.no_progress.fingerprint)});`);
    p.push("    if (__fp === __lastFp) {");
    p.push(`      if (++__fpRepeats >= ${spec.caps.no_progress.max_repeats}) {`);
    p.push(emitCapAction(spec.caps.on_cap_exceeded, "        ", "no_progress", "__fpRepeats = 0; __lastFp = undefined;"));
    p.push("      }");
    p.push("    } else { __fpRepeats = 0; __lastFp = __fp; }");
  }
  p.push("    iteration++;");
  p.push("  }");
  if (spec.terminate.on_exit) {
    p.push(emitExitActionBaby(spec.terminate.on_exit, "  "));
  }
  p.push("  return state;");
  p.push("}");
  p.push("");
  return p.join("\n");
}

function emitPackageJsonBaby(spec: LoopSpec): string {
  return (
    JSON.stringify(
      {
        name: `${spec.id}-babysitter-loop`,
        version: spec.meta?.version ?? FACTORY_VERSION,
        private: true,
        type: "module",
        description: spec.meta?.description ?? `Generated babysitter process: ${spec.id}`,
        dependencies: { "@a5c-ai/babysitter-sdk": SDK_VERSION },
      },
      null,
      2
    ) + "\n"
  );
}

function emitBabysitterConfig(spec: LoopSpec): string {
  return (
    JSON.stringify(
      {
        process: "./process.mjs",
        entry: "./process.mjs#process",
        loop_id: spec.id,
        nonInteractive: false,
        notes: "Run with the babysitter SDK CLI (or /babysitter:call). token/$/wallclock caps are NOT enforced here.",
      },
      null,
      2
    ) + "\n"
  );
}

function emitReadmeBaby(spec: LoopSpec): string {
  return `# ${spec.meta?.name ?? spec.id} (babysitter target)

> Generated by **Monkey D Loopy**. Lowers the LoopSpec to a babysitter durable process for
> [@a5c-ai/babysitter-sdk](https://github.com/a5c-ai/babysitter).

- **Pattern:** \`${spec.pattern}\`
- **Termination:** \`${spec.terminate.signal}\` — exits when \`${spec.terminate.until}\`
- **Enforced here:** max_iterations${spec.caps.no_progress ? " + no-progress fingerprint" : ""}, durable journal/replay, breakpoints, durable sleep.
- **NOT enforced here:** token/$/wallclock budgets (babysitter does not meter usage) — use the \`standalone\` target for hard cost caps. \`http\` steps are lowered to \`curl\` shell tasks; \`env\` references resolve to \`{}\`.
- **\`http\` envelope:** an \`envelope: true\` http step works here too — the \`curl\` is run with a \`-w\` status/header sentinel and reassembled into \`{ status, ok, headers, body }\` by an in-process helper, so \`save: { code: "$.status" }\` resolves. \`headers\` needs curl ≥ 7.83 (\`%{header_json}\`); older curl yields \`{}\` headers but a correct \`status\`/\`body\`.

## Install & run

\`\`\`bash
npm install   # pulls @a5c-ai/babysitter-sdk

# Tier 1 — deterministic, agent-free validation (drive the two-loops manually):
npx babysitter run:create --run-id r1 --process-id ${spec.id} \\
  --entry ./process.mjs#process --inputs ./inputs.json --runs-dir ./.a5c/runs --non-interactive --json
npx babysitter run:iterate ./.a5c/runs/r1 --json        # -> {status:"waiting"|"completed", nextActions}
npx babysitter task:list   ./.a5c/runs/r1 --pending --json
npx babysitter task:post   ./.a5c/runs/r1 <effectId> --status ok --value-inline '{"...":"..."}' --json
# repeat run:iterate + task:post until status:"completed"

# Tier 2 — full execution with a real agent harness:
npx babysitter harness:yolo --process ./process.mjs --harness claude-code --runs-dir ./.a5c/runs --json
\`\`\`

Provide an \`inputs.json\` with this loop's inputs${spec.inputs ? ` (${Object.keys(spec.inputs).join(", ")})` : ""}.
`;
}

function emitLockBaby(spec: LoopSpec): string {
  return (
    JSON.stringify(
      {
        loop_id: spec.id,
        loopspec_version: spec.loopspec,
        factory_version: spec.provenance?.factory_version ?? FACTORY_VERSION,
        target: "babysitter",
        recipe: spec.provenance?.recipe,
        signal: spec.terminate.signal,
        caps: spec.caps,
      },
      null,
      2
    ) + "\n"
  );
}

export const babysitterAdapter: Adapter = {
  target: "babysitter",
  plan(spec: LoopSpec): PlanResult {
    const files: PlannedFile[] = [
      { relativePath: "process.mjs", contents: emitProcessFile(spec), kind: "entry" },
      { relativePath: "package.json", contents: emitPackageJsonBaby(spec), kind: "config" },
      { relativePath: "babysitter.json", contents: emitBabysitterConfig(spec), kind: "config" },
      { relativePath: "README.md", contents: emitReadmeBaby(spec), kind: "doc" },
      { relativePath: "loop.lock", contents: emitLockBaby(spec), kind: "provenance" },
    ];
    return { target: "babysitter", files, warnings: capabilityWarnings(spec, "babysitter") };
  },
};
