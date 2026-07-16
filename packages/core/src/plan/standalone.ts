/**
 * Standalone adapter — the canonical target. Lowers a LoopSpec into a complete,
 * crash-resumable Node project that depends only on @loopyc/runtime and exposes
 * a human CLI surface (run | step | resume | stop | recover | doctor) plus an agent surface (SKILL.md).
 *
 * The runtime (@loopyc/runtime, built in M1) owns the journal/replay/caps machinery;
 * this adapter emits explicit, auditable loop logic that calls into it.
 */
import type {
  Adapter,
  PlanOptions,
  PlanResult,
  PlannedFile,
} from "./types.js";
import { capabilityWarnings } from "./types.js";
import { emitGuard, emitHttpReq, emitOnDone, emitSave, emitTemplate, emitValue } from "./step-emit.js";
import { parseDuration } from "../duration.js";
import { FACTORY_VERSION } from "../version.js";
import type {
  ExitAction,
  Gate,
  LoopSpec,
  ScheduleMode,
  Step,
} from "../types.js";

const CTX_DESTRUCTURE = "const { state, inputs, env, iteration, meta } = ctx;";

/** Newlines in an id are already rejected by the validator; this is defense in depth. */
function safeComment(s: string): string {
  return String(s).replace(/[\r\n]/g, " ");
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

/** A human gate lowers to a fail-closed ctx.breakpoint (resumable; an unapproved gate pauses). */
function emitGate(gate: Gate, ind: string): string {
  const opts = [`ask: ${emitTemplate(gate.ask)}`];
  if (gate.strategy) opts.push(`strategy: ${JSON.stringify(gate.strategy)}`);
  if (gate.auto_approve_in) opts.push(`autoApproveIn: ${JSON.stringify(gate.auto_approve_in)}`);
  const call = `await ctx.breakpoint({ ${opts.join(", ")} });`;
  if (gate.when) return [`${ind}if (${emitGuard(gate.when)}) {`, `${ind}  ${call}`, `${ind}}`].join("\n");
  return `${ind}${call}`;
}

function emitStepsStandalone(steps: Step[], ind: string, gates: Map<string, Gate[]>): string {
  return steps.map((s) => emitStep(s, ind, gates)).join("\n");
}

function emitStep(step: Step, ind: string, gates: Map<string, Gate[]>): string {
  const ind2 = ind + "  ";
  const open = step.when ? `${ind}if (${emitGuard(step.when)}) {` : `${ind}{`;
  const inner = emitInner(step, ind2, gates);
  const out = [`${ind}// step: ${safeComment(step.id)}`, open, inner, `${ind}}`];
  // a declared gate fires AFTER its step (human sign-off before the next action).
  for (const g of gates.get(step.id) ?? []) out.push(emitGate(g, ind));
  return out.join("\n");
}

function emitInner(step: Step, ind: string, gates: Map<string, Gate[]>): string {
  const lines: string[] = [];
  switch (step.kind) {
    case "agent": {
      const opts = [`harness: ${JSON.stringify(step.harness)}`];
      if (step["allowed-tools"]) opts.push(`allowedTools: ${JSON.stringify(step["allowed-tools"])}`);
      opts.push(`prompt: ${emitTemplate(step.prompt)}`);
      if (step.save && Object.keys(step.save).length > 0) {
        lines.push(`${ind}const __res = await ctx.agent({ ${opts.join(", ")} });`);
        emitSave(step.save, "__res", ind, lines);
      } else {
        lines.push(`${ind}await ctx.agent({ ${opts.join(", ")} });`);
      }
      emitOnDone(step.on_done, ind, lines);
      break;
    }
    case "shell": {
      const cmdExpr = step.args
        ? `{ command: ${emitTemplate(step.cmd)}, args: [${step.args.map((a) => emitTemplate(a)).join(", ")}] }`
        : emitTemplate(step.cmd);
      lines.push(`${ind}const __out = await ctx.shell(${cmdExpr});`);
      emitSave(step.save, "__out", ind, lines);
      emitOnDone(step.on_done, ind, lines);
      break;
    }
    case "http": {
      lines.push(`${ind}const __res = await ctx.http(${emitHttpReq(step.request, step.envelope)});`);
      emitSave(step.save, "__res", ind, lines);
      emitOnDone(step.on_done, ind, lines);
      break;
    }
    case "breakpoint": {
      const opts = [`ask: ${emitTemplate(step.ask)}`];
      if (step.strategy) opts.push(`strategy: ${JSON.stringify(step.strategy)}`);
      if (step.auto_approve_in) opts.push(`autoApproveIn: ${JSON.stringify(step.auto_approve_in)}`);
      lines.push(`${ind}await ctx.breakpoint({ ${opts.join(", ")} });`);
      break;
    }
    case "sleep": {
      if (step.for) lines.push(`${ind}await ctx.sleep(${JSON.stringify(step.for)});`);
      else lines.push(`${ind}await ctx.sleepUntil(() => (${emitGuard(step.until!)}));`);
      break;
    }
    case "reduce": {
      const alias = step.as ?? "item";
      lines.push(`${ind}for (const ${alias} of (${emitGuard(step.over)})) {`);
      lines.push(emitStepsStandalone(step.body, ind + "  ", gates));
      lines.push(`${ind}}`);
      break;
    }
  }
  return lines.join("\n");
}

function emitExitAction(action: ExitAction, ind: string): string {
  switch (action.kind) {
    case "shell":
      return `${ind}await ctx.shell(${emitTemplate(action.cmd ?? "")});`;
    case "http":
      return `${ind}await ctx.http(${action.request ? emitHttpReq(action.request, action.envelope) : "{}"});`;
    case "agent":
      return `${ind}await ctx.agent({ harness: ${JSON.stringify(action.harness ?? "llm")}, prompt: ${emitTemplate(action.prompt ?? "")} });`;
  }
}

/**
 * The module specifier the emitted `loop.mjs` imports the runtime from. Normally the published
 * `@loopyc/runtime` package; in `vendor` mode, a local single-file bundle the CLI emits alongside.
 */
function runtimeSpecifier(vendor: boolean): string {
  return vendor ? "./runtime.bundle.mjs" : "@loopyc/runtime";
}

function emitLoopFile(spec: LoopSpec, vendor = false): string {
  const initialState = Object.fromEntries(
    Object.entries(spec.state?.vars ?? {}).map(([k, d]) => [k, d.init])
  );
  const specMeta = {
    id: spec.id,
    meta: spec.meta,
    pattern: spec.pattern,
    target: "standalone",
    signal: spec.terminate.signal,
    caps: spec.caps,
    schedule: spec.schedule,
    retry: spec.retry,
    provenance: spec.provenance,
    observe: spec.observe,
  };

  const hasFingerprint = Boolean(spec.caps.no_progress);
  const hasOnExit = Boolean(spec.terminate.on_exit);

  const parts: string[] = [];
  parts.push("#!/usr/bin/env node");
  parts.push("// Generated by Monkey D Loopy (@loopyc/core). Do not edit by hand — edit the LoopSpec and recompile.");
  parts.push(`// loop: ${safeComment(spec.id)}  target: standalone  pattern: ${spec.pattern}`);
  parts.push("");
  parts.push(`import { createRuntime, __in } from ${JSON.stringify(runtimeSpecifier(vendor))};`);
  parts.push('import { pathToFileURL } from "node:url";');
  parts.push('import { realpathSync } from "node:fs";');
  parts.push("");
  parts.push(`const spec = ${JSON.stringify(specMeta, null, 2)};`);
  parts.push("");
  parts.push("export function initialState() {");
  parts.push(`  return ${JSON.stringify(initialState)};`);
  parts.push("}");
  parts.push("");
  parts.push("export function terminate(ctx) {");
  parts.push(`  ${CTX_DESTRUCTURE}`);
  parts.push(`  return (${emitGuard(spec.terminate.until)});`);
  parts.push("}");
  parts.push("");
  if (hasFingerprint) {
    parts.push("export function fingerprint(ctx) {");
    parts.push(`  ${CTX_DESTRUCTURE}`);
    parts.push(`  return String(${emitGuard(spec.caps.no_progress!.fingerprint)});`);
    parts.push("}");
    parts.push("");
  }
  const { byStep: gatesByStep, trailing: trailingGates } = groupGates(spec.gates);
  parts.push("export async function iterate(ctx) {");
  parts.push(`  ${CTX_DESTRUCTURE}`);
  parts.push(emitStepsStandalone(spec.body, "  ", gatesByStep));
  for (const g of trailingGates) parts.push(emitGate(g, "  "));
  parts.push("}");
  parts.push("");
  if (hasOnExit) {
    parts.push("export async function onExit(ctx) {");
    parts.push(`  ${CTX_DESTRUCTURE}`);
    parts.push(emitExitAction(spec.terminate.on_exit!, "  "));
    parts.push("}");
    parts.push("");
  }
  const cfg = [
    "  spec,",
    "  initialState,",
    "  iterate,",
    "  terminate,",
    hasFingerprint ? "  fingerprint," : null,
    hasOnExit ? "  onExit," : null,
    // NB: gates are lowered to inline ctx.breakpoint() calls in iterate() above — the runtime
    // does not consume a `gates` config, so passing one here would be a silent no-op.
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
  parts.push("export const runtime = createRuntime({");
  parts.push(cfg);
  parts.push("});");
  parts.push("");
  parts.push("// Self-references __in for the `in` operator in lowered expressions.");
  parts.push("void __in;");
  parts.push("");
  parts.push("// Run main() when invoked directly — symlink-robust (works through a bin symlink).");
  parts.push("const __entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : \"\";");
  parts.push("if (import.meta.url === __entry) {");
  parts.push("  await runtime.main(process.argv.slice(2));");
  parts.push("}");
  parts.push("");
  return parts.join("\n");
}

function emitPackageJson(spec: LoopSpec, vendor = false): string {
  const pkg = {
    name: `${spec.id}-loop`,
    version: spec.meta?.version ?? FACTORY_VERSION,
    private: true,
    type: "module",
    description: spec.meta?.description ?? `Generated loop: ${spec.id}`,
    bin: { [`${spec.id}-loop`]: "./loop.mjs" },
    scripts: {
      start: "node loop.mjs run",
      step: "node loop.mjs step",
      resume: "node loop.mjs resume",
      stop: "node loop.mjs stop",
      recover: "node loop.mjs recover",
      doctor: "node loop.mjs doctor",
    },
    // In vendor mode the runtime is bundled into runtime.bundle.mjs, so there are no deps to
    // install — the artifact runs with plain `node`, no npm install, empty node_modules.
    dependencies: vendor ? {} : { "@loopyc/runtime": `^${FACTORY_VERSION}` },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function emitReadme(spec: LoopSpec, vendor = false): string {
  const t = spec.terminate;
  const runBlock = vendor
    ? `\`\`\`bash
# Self-contained (compiled with --vendor): the runtime is bundled, no install needed.
node loop.mjs run           # run until termination or a cap is hit
node loop.mjs step          # advance exactly one iteration (for cron / Stop-hook / CI drivers)
node loop.mjs resume        # resume from the journal after a crash or pause
node loop.mjs resume --approve   # approve a cap-breakpoint pause and continue (resets that cap's budget)
node loop.mjs stop --reason "maintenance"   # stop after the next journal-safe boundary
node loop.mjs recover --retry --reason "verified safe"   # explicitly resolve an uncertain effect
node loop.mjs doctor        # preflight: journal dir writable, budget set, etc.
\`\`\``
    : `\`\`\`bash
npm install
npm start                   # run until termination or a cap is hit
npm run step                # advance exactly one iteration (for cron / Stop-hook / CI drivers)
npm run resume              # resume from the journal after a crash or pause
node loop.mjs resume --approve   # approve a cap-breakpoint pause and continue (resets that cap's budget)
npm run stop -- --reason "maintenance"   # stop after the next journal-safe boundary
npm run recover -- --retry --reason "verified safe"   # explicitly resolve an uncertain effect
npm run doctor              # preflight: journal dir writable, budget set, etc.
\`\`\``;
  return `# ${spec.meta?.name ?? spec.id}

> Generated by **Monkey D Loopy** from a LoopSpec. Edit the spec and recompile — do not hand-edit the generated loop.

${spec.meta?.description ?? ""}

- **Pattern:** \`${spec.pattern}\`
- **Termination:** \`${t.signal}\` — exits when \`${t.until}\`
- **Caps:** max_iterations=${spec.caps.max_iterations}${spec.caps.budget ? `, budget=${JSON.stringify(spec.caps.budget)}` : ""}
- **Schedule:** \`${spec.schedule?.mode ?? "manual"}\`${vendor ? "\n- **Vendored:** the runtime is bundled in `runtime.bundle.mjs` — zero-install." : ""}

## Run

${runBlock}

Every step is journaled under \`.loopy/runs/<runId>/\`. Graceful stop waits for a safe boundary.
If a forced kill lands between an effect's pending and done records, resume reports \`uncertain\`
and requires an explicit retry, assume-done result, or abort.

## Guarantees baked in

This loop **cannot run unbounded**: it has a required termination predicate and
mandatory caps (iterations${spec.caps.no_progress ? " + no-progress fingerprint" : ""}${spec.caps.budget ? " + token/$/wallclock budget" : ""}).
`;
}

function emitSkill(spec: LoopSpec): string {
  return `---
name: ${spec.id}
description: ${spec.meta?.description ?? `Run the ${spec.id} loop`}
---

# ${spec.meta?.name ?? spec.id} (agent surface)

This is a generated Monkey D Loopy loop. To run it on behalf of the user:

1. \`cd\` into this directory and \`npm install\` if needed.
2. Drive it one step at a time with \`node loop.mjs step\` (returns JSON: \`{ status, next }\`),
   or run to completion with \`node loop.mjs run\`.
3. Inspect progress via the journal under \`.loopy/runs/\`.

**Pattern:** ${spec.pattern}. **Exit when:** \`${spec.terminate.until}\` (${spec.terminate.signal}).
The loop enforces its own caps; never wrap it in another unbounded loop.
`;
}

function emitLock(spec: LoopSpec, vendor = false): string {
  const lock = {
    loop_id: spec.id,
    loopspec_version: spec.loopspec,
    factory_version: spec.provenance?.factory_version ?? FACTORY_VERSION,
    target: "standalone",
    vendor, // self-install mode — so `reprint` preserves zero-install instead of silently downgrading
    source: spec.provenance?.source,
    run_id: spec.provenance?.run_id,
    recipe: spec.provenance?.recipe,
    signal: spec.terminate.signal,
    caps: spec.caps,
  };
  return JSON.stringify(lock, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Scheduler trigger files — emitted ONLY for recurring schedule modes
// (cron / forever / watch). One-shot ("manual"/absent) loops get nothing extra.
//
// Every trigger runs `node loop.mjs step`: exactly ONE iteration per activation.
// That is the right granularity for a scheduled poll — the loop is crash-resumable
// and enforces its own caps, so a single durable step per fire composes safely with
// any host scheduler. Monkey D Loopy ships NO daemon; these are install-only files.
//
// Everything here is PURE: derived deterministically from the spec (no I/O, no clock).
// ---------------------------------------------------------------------------

/** Recurring modes get trigger files; "manual"/absent (one-shot) get nothing. */
function isRecurringSchedule(mode: ScheduleMode | undefined): boolean {
  return mode === "cron" || mode === "forever" || mode === "watch";
}

/** First `sleep` `for:` duration anywhere in the body — the loop's natural poll cadence. */
function firstSleepDuration(steps: Step[]): string | undefined {
  for (const s of steps) {
    if (s.kind === "sleep" && s.for) return s.for;
    if (s.kind === "reduce") {
      const inner = firstSleepDuration(s.body);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** Fallback cadence when neither an explicit cron nor a derivable sleep duration exists. */
const SCHEDULE_DEFAULT_CRON = "*/15 * * * *";

/** Map a duration ("5m","1h","1d") to a 5-field cron, or null if it can't be expressed cleanly. */
function cronFromDuration(dur: string): string | null {
  let ms: number;
  try {
    ms = parseDuration(dur);
  } catch {
    return null;
  }
  const minutes = ms / 60_000;
  if (!Number.isInteger(minutes) || minutes < 1) return null; // cron's floor is one minute
  if (minutes < 60) return `*/${minutes} * * * *`; // e.g. 5m → */5 * * * *
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours < 24) return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
  if (Number.isInteger(hours) && hours % 24 === 0) {
    const days = hours / 24;
    if (days === 1) return "0 0 * * *";
    // The day-of-month field is 1-31; a `*/N` step above 31 is out of range and is rejected by
    // GitHub Actions / strict cron parsers. Fall back to the default cron (mirrors the null cases above).
    if (days <= 31) return `0 0 */${days} * *`;
    return null;
  }
  return null;
}

interface DerivedCron {
  cron: string;
  /** Human note: where the cron came from (for headers/READMEs). */
  source: string;
}

/** Pick the cron that fires the loop: explicit schedule.cron > derived-from-sleep > default. */
function deriveCron(spec: LoopSpec): DerivedCron {
  if (spec.schedule?.cron) return { cron: spec.schedule.cron, source: "schedule.cron" };
  const dur = firstSleepDuration(spec.body);
  if (dur) {
    const c = cronFromDuration(dur);
    if (c) return { cron: c, source: `derived from the first sleep cadence (${dur})` };
  }
  return { cron: SCHEDULE_DEFAULT_CRON, source: "default — no cron or sleep cadence found, so every 15 minutes" };
}

/**
 * Result of translating a cron into a host scheduler expression. When `faithful` is false the
 * `value` is an every-15-min PLACEHOLDER and the emitter must warn LOUDLY rather than claim the
 * cron was honored — otherwise an intended weekly/N-day cadence would silently fire every 15 min.
 */
interface CronTranslation {
  value: string;
  faithful: boolean;
}

/** cron weekday (0/7 = Sun) → systemd day-name. */
const SYSTEMD_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Translate a cron day-of-week field (single / `a-b` range / `a,b,c` list) to systemd day names, or null. */
function dowToSystemd(dow: string): string | null {
  const name = (tok: string): string | null => {
    if (!/^\d+$/.test(tok)) return null;
    const n = Number(tok);
    return n >= 0 && n <= 7 ? SYSTEMD_DOW[n % 7]! : null; // 7 wraps to Sun
  };
  const range = /^(\d+)-(\d+)$/.exec(dow);
  if (range) {
    const a = name(range[1]!);
    const b = name(range[2]!);
    return a && b ? `${a}..${b}` : null;
  }
  if (dow.includes(",")) {
    const names = dow.split(",").map(name);
    return names.every((x): x is string => x !== null) ? names.join(",") : null;
  }
  return name(dow);
}

/** Translate a cron day-of-week field to launchd Weekday numbers (0/7 = Sun), or null. */
function dowToWeekdays(dow: string): number[] | null {
  const num = (tok: string): number | null => {
    if (!/^\d+$/.test(tok)) return null;
    const n = Number(tok);
    return n >= 0 && n <= 7 ? n : null;
  };
  const range = /^(\d+)-(\d+)$/.exec(dow);
  if (range) {
    const a = num(range[1]!);
    const b = num(range[2]!);
    if (a === null || b === null || a > b) return null;
    const out: number[] = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  if (dow.includes(",")) {
    const nums = dow.split(",").map(num);
    return nums.every((x): x is number => x !== null) ? nums : null;
  }
  const single = num(dow);
  return single === null ? null : [single];
}

/**
 * Best-effort cron → systemd OnCalendar. Translates the common minute/hour/day/week/day-of-month
 * shapes FAITHFULLY; for anything it cannot express it returns the every-15-min placeholder with
 * `faithful: false` so the caller warns instead of silently changing the cadence.
 */
function cronToOnCalendar(cron: string): CronTranslation {
  const placeholder: CronTranslation = { value: "*:0/15", faithful: false };
  const f = cron.trim().split(/\s+/);
  if (f.length < 5) return placeholder;
  const [minute, hour, dom, mon, dow] = f;
  const ok = (value: string): CronTranslation => ({ value, faithful: true });
  const allDate = dom === "*" && mon === "*" && dow === "*";
  const fixedTime = /^\d+$/.test(minute!) && /^\d+$/.test(hour!);
  const hhmm = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}:00`;

  // minute step, any hour: */N * * * *
  const stepMin = /^\*\/(\d+)$/.exec(minute!);
  if (allDate && stepMin && hour === "*") return ok(`*:0/${stepMin[1]}`);
  // top of every hour: 0 * * * *
  if (allDate && minute === "0" && hour === "*") return ok("hourly");
  // hour step at minute 0: 0 */N * * *
  const stepHour = /^\*\/(\d+)$/.exec(hour!);
  if (allDate && minute === "0" && stepHour) return ok(`*-*-* 0/${stepHour[1]}:00:00`);
  // fixed time daily: M H * * *
  if (allDate && fixedTime) return ok(`*-*-* ${hhmm}`);
  // day-of-week at a fixed time: M H * * D (single / range / list)
  if (mon === "*" && dom === "*" && dow !== "*" && fixedTime) {
    const days = dowToSystemd(dow!);
    if (days) return ok(`${days} *-*-* ${hhmm}`);
  }
  // day-of-month step at a fixed time: M H */N * * (N within 1-31)
  const stepDom = /^\*\/(\d+)$/.exec(dom!);
  if (dow === "*" && mon === "*" && stepDom && fixedTime) {
    const n = Number(stepDom[1]);
    if (n >= 1 && n <= 31) return ok(`*-*-01/${n} ${hhmm}`);
  }
  // fixed day-of-month at a fixed time: M H D * *
  if (dow === "*" && mon === "*" && /^\d+$/.test(dom!) && fixedTime) {
    const d = Number(dom);
    if (d >= 1 && d <= 31) return ok(`*-*-${String(d).padStart(2, "0")} ${hhmm}`);
  }
  return placeholder;
}

/**
 * Best-effort cron → launchd schedule XML (StartInterval seconds, or StartCalendarInterval).
 * Translates the same shapes as {@link cronToOnCalendar} EXCEPT day-of-month STEP — launchd's `Day`
 * key is a fixed day, not a step, so an "every N days" cron cannot be expressed and falls back with
 * `faithful: false`. Unhandled shapes get the every-15-min placeholder so the caller warns.
 */
function cronToLaunchd(cron: string, ind: string): CronTranslation {
  const interval = (sec: number): string =>
    `${ind}<key>StartInterval</key>\n${ind}<integer>${sec}</integer>`;
  const dictBody = (pairs: [string, number][], pad: string): string[] => [
    `${pad}<dict>`,
    ...pairs.map(([k, v]) => `${pad}  <key>${k}</key><integer>${v}</integer>`),
    `${pad}</dict>`,
  ];
  const calendar = (dicts: [string, number][][]): string =>
    dicts.length === 1
      ? [`${ind}<key>StartCalendarInterval</key>`, ...dictBody(dicts[0]!, ind)].join("\n")
      : [
          `${ind}<key>StartCalendarInterval</key>`,
          `${ind}<array>`,
          ...dicts.flatMap((d) => dictBody(d, `${ind}  `)),
          `${ind}</array>`,
        ].join("\n");

  const placeholder: CronTranslation = { value: interval(900), faithful: false };
  const f = cron.trim().split(/\s+/);
  if (f.length < 5) return placeholder;
  const [minute, hour, dom, mon, dow] = f;
  const ok = (value: string): CronTranslation => ({ value, faithful: true });
  const allDate = dom === "*" && mon === "*" && dow === "*";
  const fixedTime = /^\d+$/.test(minute!) && /^\d+$/.test(hour!);
  const hm: [string, number][] = [["Hour", Number(hour)], ["Minute", Number(minute)]];

  const stepMin = /^\*\/(\d+)$/.exec(minute!);
  if (allDate && stepMin && hour === "*") return ok(interval(Number(stepMin[1]) * 60));
  if (allDate && minute === "0" && hour === "*") return ok(interval(3600));
  const stepHour = /^\*\/(\d+)$/.exec(hour!);
  if (allDate && minute === "0" && stepHour) return ok(interval(Number(stepHour[1]) * 3600));
  // fixed time daily: M H * * *
  if (allDate && fixedTime) return ok(calendar([hm]));
  // day-of-week at a fixed time: M H * * D — one <dict> per weekday.
  if (mon === "*" && dom === "*" && dow !== "*" && fixedTime) {
    const wds = dowToWeekdays(dow!);
    if (wds) return ok(calendar(wds.map((wd): [string, number][] => [["Weekday", wd], ...hm])));
  }
  // fixed day-of-month at a fixed time: M H D * *
  if (dow === "*" && mon === "*" && /^\d+$/.test(dom!) && fixedTime) {
    const d = Number(dom);
    if (d >= 1 && d <= 31) return ok(calendar([[["Day", d], ...hm]]));
  }
  // day-of-month STEP (M H */N * *) is NOT expressible in launchd's fixed Day key — warn + placeholder.
  return placeholder;
}

/** Placeholder for the artifact's absolute path — unknown at compile time; the user fills it in. */
const SCHEDULE_PLACEHOLDER = "/path/to/loop";

/** The single load-bearing design note repeated in each trigger's header. */
const STEP_GRANULARITY_NOTE =
  "Each activation runs exactly ONE iteration (`node loop.mjs step`). The loop is crash-resumable " +
  "and enforces its own caps, so a single durable step per fire is the right granularity for a " +
  "scheduled poll — no long-lived daemon is needed or shipped.";

function emitScheduleFiles(spec: LoopSpec): PlannedFile[] {
  const id = spec.id;
  const mode = spec.schedule!.mode;
  const { cron, source } = deriveCron(spec);

  const crontab = [
    `# Crontab trigger for the "${safeComment(id)}" loop (schedule.mode: ${mode}).`,
    `# ${STEP_GRANULARITY_NOTE}`,
    `#`,
    `# Install:  run \`crontab -e\` and paste the line below.`,
    `# IMPORTANT: replace ${SCHEDULE_PLACEHOLDER} with the ABSOLUTE path to this artifact directory`,
    `#   (the folder containing loop.mjs). cron runs with a minimal environment, so use absolute`,
    `#   paths and make sure \`node\` is on PATH (or hard-code an absolute path to node).`,
    `# Cron source: ${source}`,
    `${cron} cd ${SCHEDULE_PLACEHOLDER} && node loop.mjs step >> loop.log 2>&1`,
    ``,
  ].join("\n");

  const service = [
    `[Unit]`,
    `Description=Monkey D Loopy — ${safeComment(id)} loop (one iteration per activation)`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `# Replace ${SCHEDULE_PLACEHOLDER} with the absolute path to this artifact (the dir with loop.mjs).`,
    `WorkingDirectory=${SCHEDULE_PLACEHOLDER}`,
    `# NOTE: 'systemctl --user' starts with a MINIMAL PATH that usually EXCLUDES nvm/homebrew node,`,
    `#   so '/usr/bin/env node' below may fail to find node. Either hard-code an absolute node path`,
    `#   in ExecStart (e.g. ExecStart=/opt/homebrew/bin/node loop.mjs step), or uncomment + edit the`,
    `#   Environment= line so PATH includes your node's bin dir.`,
    `# Environment=PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    `ExecStart=/usr/bin/env node loop.mjs step`,
    `StandardOutput=append:${SCHEDULE_PLACEHOLDER}/loop.log`,
    `StandardError=append:${SCHEDULE_PLACEHOLDER}/loop.log`,
    ``,
  ].join("\n");

  const onCal = cronToOnCalendar(cron);
  const timer = [
    `[Unit]`,
    `Description=Monkey D Loopy — ${safeComment(id)} schedule (fires ${id}.service on a cadence)`,
    ``,
    `[Timer]`,
    ...(onCal.faithful
      ? [`# OnCalendar derived from cron "${cron}" (${source}).`]
      : [
          `# WARNING: could not translate cron "${cron}" to a systemd OnCalendar expression.`,
          `# The OnCalendar below is an every-15-minutes PLACEHOLDER — EDIT IT to your intended`,
          `# cadence, or drive the loop from crontab.txt (which carries the real cron "${cron}").`,
        ]),
    `OnCalendar=${onCal.value}`,
    `Persistent=true`,
    `Unit=${id}.service`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");

  const launchd = cronToLaunchd(cron, "  ");
  const plist = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>com.loopy.${id}</string>`,
    `  <!-- NOTE: launchd starts with a MINIMAL PATH that usually EXCLUDES nvm/homebrew node, so -->`,
    `  <!-- '/usr/bin/env node' below may fail to find node. Either replace the env+node strings -->`,
    `  <!-- with an ABSOLUTE node path (e.g. <string>/opt/homebrew/bin/node</string><string>loop.mjs</string>), -->`,
    `  <!-- or add an EnvironmentVariables dict whose PATH key includes your node's bin dir. -->`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>/usr/bin/env</string>`,
    `    <string>node</string>`,
    `    <string>loop.mjs</string>`,
    `    <string>step</string>`,
    `  </array>`,
    `  <!-- Replace ${SCHEDULE_PLACEHOLDER} with the absolute path to this artifact (the dir with loop.mjs). -->`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${SCHEDULE_PLACEHOLDER}</string>`,
    ...(launchd.faithful
      ? [`  <!-- Schedule derived from cron "${cron}" (${source}). -->`]
      : [
          `  <!-- WARNING: could not translate cron "${cron}" to a launchd schedule. -->`,
          `  <!-- The schedule below is an every-15-minutes PLACEHOLDER — EDIT IT to your intended -->`,
          `  <!-- cadence, or drive the loop from crontab.txt (which carries the real cron "${cron}"). -->`,
        ]),
    launchd.value,
    `  <key>StandardOutPath</key>`,
    `  <string>${SCHEDULE_PLACEHOLDER}/loop.log</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${SCHEDULE_PLACEHOLDER}/loop.log</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");

  const ghActions = [
    `# GitHub Actions trigger for the "${safeComment(id)}" loop (best-effort).`,
    `# ${STEP_GRANULARITY_NOTE}`,
    `# Place this at .github/workflows/${id}.yml inside the repo that holds this artifact, and wire`,
    `# any inputs/secrets the loop needs (see the commented env: block). If the artifact isn't the`,
    `# repo root, set working-directory to the folder containing loop.mjs.`,
    `name: loopy-${id}`,
    `on:`,
    `  schedule:`,
    `    - cron: "${cron}"`,
    `  workflow_dispatch: {}`,
    `jobs:`,
    `  step:`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
    `      - uses: actions/setup-node@v4`,
    `        with:`,
    `          node-version: "22"`,
    `      - run: npm install`,
    `        # working-directory: path/to/loop   # uncomment if the artifact isn't the repo root`,
    `      # GH runners are ephemeral and .loopy/ is gitignored, so without this the journal is`,
    `      # thrown away every fire and the loop restarts at iteration 1 instead of resuming. The`,
    `      # unique key (run id + attempt) means the post-job ALWAYS saves the updated journal;`,
    `      # restore-keys falls back to the most recent prior journal so the next fire resumes.`,
    `      - name: Restore loop journal (.loopy) from the previous fire`,
    `        uses: actions/cache@v4`,
    `        with:`,
    `          path: .loopy`,
    `          # If the artifact isn't the repo root, prefix path with the loop dir (e.g. path/to/loop/.loopy).`,
    `          key: loopy-${id}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `          restore-keys: |`,
    `            loopy-${id}-`,
    `      - run: node loop.mjs step`,
    `        # working-directory: path/to/loop`,
    `        # env:`,
    `        #   EXAMPLE_SECRET: \${{ secrets.EXAMPLE_SECRET }}`,
    ``,
  ].join("\n");

  const readme = [
    `# Schedule triggers for \`${id}\``,
    ``,
    `> Generated by **Monkey D Loopy** because this loop's \`schedule.mode\` is \`${mode}\` (recurring).`,
    `> These are **install-only** trigger files — Monkey D Loopy ships **no daemon**. Pick the one for`,
    `> your host, point it at this artifact, and the host scheduler fires the loop on a cadence.`,
    ``,
    `**Cadence:** \`${cron}\`  (${source})`,
    ``,
    `## Why \`node loop.mjs step\` (one iteration per fire)`,
    ``,
    `Every trigger runs a single \`node loop.mjs step\` per activation — exactly ONE iteration. The loop`,
    `is crash-resumable and enforces its own caps (iterations / budget / no-progress), so one durable`,
    `step per scheduled fire is the correct, safe granularity for a poll. Do **not** call \`run\` (which`,
    `loops to termination) from a scheduler.`,
    ``,
    `## Files`,
    ``,
    `| File | Host | Install |`,
    `| --- | --- | --- |`,
    `| \`crontab.txt\` | any cron | \`crontab -e\`, paste the line (edit the path first) |`,
    `| \`${id}.service\` + \`${id}.timer\` | systemd (Linux) | copy to \`~/.config/systemd/user/\`, then \`systemctl --user enable --now ${id}.timer\` |`,
    `| \`${id}.plist\` | launchd (macOS) | copy to \`~/Library/LaunchAgents/\`, then \`launchctl load\` it |`,
    `| \`${id}.gh-actions.yml\` | GitHub Actions | move to \`.github/workflows/${id}.yml\`, wire secrets |`,
    ``,
    `Replace \`${SCHEDULE_PLACEHOLDER}\` in each file with the absolute path to this directory (the`,
    `folder containing \`loop.mjs\`). Tip: \`loopc schedule install <this-dir>\` prints the ready-to-paste`,
    `snippet for your current platform with the path already filled in.`,
    ``,
  ].join("\n");

  return [
    { relativePath: "schedule/crontab.txt", contents: crontab, kind: "asset" },
    { relativePath: `schedule/${id}.service`, contents: service, kind: "asset" },
    { relativePath: `schedule/${id}.timer`, contents: timer, kind: "asset" },
    { relativePath: `schedule/${id}.plist`, contents: plist, kind: "asset" },
    { relativePath: `schedule/${id}.gh-actions.yml`, contents: ghActions, kind: "asset" },
    { relativePath: "schedule/README.md", contents: readme, kind: "doc" },
  ];
}

export const standaloneAdapter: Adapter = {
  target: "standalone",
  plan(spec: LoopSpec, opts?: PlanOptions): PlanResult {
    const vendor = opts?.vendor ?? false;
    const emit = new Set(spec.target?.emit ?? ["cli", "skill", "doctor"]);
    const files: PlannedFile[] = [
      { relativePath: "loop.mjs", contents: emitLoopFile(spec, vendor), kind: "entry", executable: true },
      { relativePath: "package.json", contents: emitPackageJson(spec, vendor), kind: "config" },
      { relativePath: "README.md", contents: emitReadme(spec, vendor), kind: "doc" },
      { relativePath: "loop.lock", contents: emitLock(spec, vendor), kind: "provenance" },
      { relativePath: ".gitignore", contents: ".loopy/\nnode_modules/\n", kind: "config" },
    ];
    if (emit.has("skill")) {
      files.push({ relativePath: "SKILL.md", contents: emitSkill(spec), kind: "skill" });
    }
    // Recurring schedules (cron/forever/watch) get ready-to-install host trigger files.
    // One-shot ("manual"/absent) loops add nothing here.
    if (isRecurringSchedule(spec.schedule?.mode)) {
      files.push(...emitScheduleFiles(spec));
    }
    return { target: "standalone", files, warnings: capabilityWarnings(spec, "standalone") };
  },
};
