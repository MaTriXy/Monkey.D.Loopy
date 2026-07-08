import { describe, expect, it } from "vitest";
import { getBlueprint, loadSpecFromYaml, planLoopExport, processRaw } from "../src/index.js";
import type { LoopSpec } from "../src/index.js";

function deployWatchSpec(): LoopSpec {
  const r = loadSpecFromYaml(getBlueprint("poll-until")!.yaml);
  expect(r.validation!.ok).toBe(true);
  return r.spec!;
}

type HttpEnv = { status: number; ok: boolean; headers: Record<string, string>; body: unknown };

/**
 * Eval the spec-independent babysitter RUNTIME_HELPERS out of an emitted process.mjs so the
 * __httpEnv envelope reassembly can be exercised against real curl -w writeouts (the helpers are a
 * constant, so any spec yields the same block).
 */
function babysitterHelpers(): { __httpEnv: (raw: string) => HttpEnv } {
  const proc = planLoopExport(deployWatchSpec(), "babysitter").files.find((f) => f.relativePath === "process.mjs")!.contents;
  const helpers = proc.slice(proc.indexOf("function __in("), proc.indexOf("const __shellTask"));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${helpers}\nreturn { __httpEnv, __tryJson, __curl, __sq, __jsonpath, __in };`)();
}

describe("standalone adapter", () => {
  const spec = deployWatchSpec();
  const plan = planLoopExport(spec, "standalone");
  const fileMap = new Map(plan.files.map((f) => [f.relativePath, f.contents]));

  it("emits a complete runnable Node project", () => {
    for (const f of ["loop.mjs", "package.json", "README.md", "loop.lock", ".gitignore", "SKILL.md"]) {
      expect(fileMap.has(f), `missing ${f}`).toBe(true);
    }
  });

  it("lowers termination, steps, caps and durable sleep into the entry", () => {
    const loop = fileMap.get("loop.mjs")!;
    expect(loop).toContain('import { createRuntime, __in } from "@loopyc/runtime";');
    expect(loop).toContain("return ((state?.status === \"green\"));"); // terminate (null-safe nav)
    expect(loop).toContain("await ctx.http("); // http step
    expect(loop).toContain('await ctx.sleep("5m");'); // durable sleep
    expect(loop).toContain("export function fingerprint(ctx)"); // no_progress present
    expect(loop).toContain("export async function onExit(ctx)"); // on_exit present
    expect(loop).toContain("\"max_iterations\": 288"); // caps embedded
  });

  it("marks the entry executable", () => {
    expect(plan.files.find((f) => f.relativePath === "loop.mjs")!.executable).toBe(true);
  });

  it("is deterministic (pure planner)", () => {
    const again = planLoopExport(spec, "standalone");
    expect(again.files).toEqual(plan.files);
  });

  it("matches the golden snapshot", () => {
    expect(fileMap.get("loop.mjs")).toMatchSnapshot();
  });
});

describe("standalone vendor mode (zero-install bundle)", () => {
  const spec = deployWatchSpec();

  it("default (no opts) imports @loopyc/runtime and keeps the dependency", () => {
    const files = new Map(planLoopExport(spec, "standalone").files.map((f) => [f.relativePath, f.contents]));
    expect(files.get("loop.mjs")).toContain('import { createRuntime, __in } from "@loopyc/runtime";');
    expect(files.get("loop.mjs")).not.toContain("runtime.bundle.mjs");
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@loopyc/runtime"]).toBeDefined();
  });

  it("vendor:true imports the local bundle and drops the @loopyc/runtime dependency", () => {
    const files = new Map(planLoopExport(spec, "standalone", { vendor: true }).files.map((f) => [f.relativePath, f.contents]));
    expect(files.get("loop.mjs")).toContain('import { createRuntime, __in } from "./runtime.bundle.mjs";');
    expect(files.get("loop.mjs")).not.toContain("@loopyc/runtime");
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.dependencies["@loopyc/runtime"]).toBeUndefined();
    expect(pkg.dependencies).toEqual({});
    // The planner is pure: it rewrites the import + drops the dep but cannot emit the bundle itself.
    expect(files.has("runtime.bundle.mjs")).toBe(false);
  });

  it("vendor changes only the runtime import, package deps, the lock vendor flag, and the README run steps", () => {
    const base = new Map(planLoopExport(spec, "standalone").files.map((f) => [f.relativePath, f.contents]));
    const vend = new Map(planLoopExport(spec, "standalone", { vendor: true }).files.map((f) => [f.relativePath, f.contents]));
    expect([...vend.keys()].sort()).toEqual([...base.keys()].sort());
    // loop.mjs/package.json carry the import+dep change; loop.lock records vendor:true (so reprint
    // preserves zero-install); README.md swaps `npm install` for the `node loop.mjs` run steps.
    const expectedChanged = new Set(["loop.mjs", "package.json", "loop.lock", "README.md"]);
    for (const [name, contents] of vend) {
      if (expectedChanged.has(name)) continue;
      expect(contents, `${name} should be byte-identical in vendor mode`).toBe(base.get(name));
    }
    expect(JSON.parse(vend.get("loop.lock")!).vendor).toBe(true);
    expect(JSON.parse(base.get("loop.lock")!).vendor).toBe(false);
    expect(vend.get("README.md")).not.toContain("npm install");
  });

  it("is deterministic in vendor mode", () => {
    const a = planLoopExport(spec, "standalone", { vendor: true });
    const b = planLoopExport(spec, "standalone", { vendor: true });
    expect(b.files).toEqual(a.files);
  });
});

describe("standalone scheduler trigger files", () => {
  function scheduledCronSpec(): LoopSpec {
    const r = processRaw({
      loopspec: "0.1",
      id: "sched-cron",
      pattern: "poll-until",
      state: { vars: { done: { type: "boolean", init: false } } },
      body: [{ id: "check", kind: "shell", cmd: "echo hi", on_done: { set: { done: true } } }],
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      caps: { max_iterations: 3 },
      schedule: { mode: "cron", cron: "*/5 * * * *" },
    });
    expect(r.validation!.ok).toBe(true);
    return r.spec!;
  }

  it("emits a schedule/ dir with every platform trigger, all carrying the cron + step granularity", () => {
    const files = new Map(planLoopExport(scheduledCronSpec(), "standalone").files.map((f) => [f.relativePath, f.contents]));
    for (const f of [
      "schedule/crontab.txt",
      "schedule/sched-cron.service",
      "schedule/sched-cron.timer",
      "schedule/sched-cron.plist",
      "schedule/sched-cron.gh-actions.yml",
      "schedule/README.md",
    ]) {
      expect(files.has(f), `missing ${f}`).toBe(true);
    }
    expect(files.get("schedule/crontab.txt")).toContain("*/5 * * * *");
    expect(files.get("schedule/crontab.txt")).toContain("node loop.mjs step");
    expect(files.get("schedule/sched-cron.gh-actions.yml")).toContain('cron: "*/5 * * * *"');
    expect(files.get("schedule/sched-cron.timer")).toContain("OnCalendar=*:0/5");
    expect(files.get("schedule/sched-cron.plist")).toContain("<key>StartInterval</key>");
    expect(files.get("schedule/sched-cron.plist")).toContain("<integer>300</integer>"); // 5m
    expect(files.get("schedule/README.md")).toContain("install-only");
  });

  it("derives a cron from the first sleep cadence when the schedule has none (forever/watch)", () => {
    // poll-until blueprint: mode forever, a 5m sleep → */5 * * * *
    const files = new Map(planLoopExport(deployWatchSpec(), "standalone").files.map((f) => [f.relativePath, f.contents]));
    expect(files.has("schedule/deploy-watch.timer")).toBe(true);
    expect(files.get("schedule/crontab.txt")).toContain("*/5 * * * *");
    expect(files.get("schedule/crontab.txt")).toContain("derived from the first sleep cadence (5m)");
  });

  it("emits NO schedule/ dir for a one-shot (manual/absent) schedule", () => {
    const r = processRaw({
      loopspec: "0.1",
      id: "noplan",
      pattern: "react",
      state: { vars: { done: { type: "boolean", init: false } } },
      body: [{ id: "w", kind: "shell", cmd: ":", on_done: { set: { done: true } } }],
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      caps: { max_iterations: 3 },
    });
    expect(r.validation!.ok).toBe(true);
    const files = planLoopExport(r.spec!, "standalone").files;
    expect(files.some((f) => f.relativePath.startsWith("schedule/"))).toBe(false);
  });

  it("is deterministic with schedule files included", () => {
    const a = planLoopExport(scheduledCronSpec(), "standalone");
    const b = planLoopExport(scheduledCronSpec(), "standalone");
    expect(b.files).toEqual(a.files);
  });

  /** Build the schedule file map for an arbitrary schedule (and optional body), id "s". */
  function scheduleFiles(schedule: Record<string, unknown>, body?: unknown[]): Map<string, string> {
    const r = processRaw({
      loopspec: "0.1",
      id: "s",
      pattern: "poll-until",
      state: { vars: { done: { type: "boolean", init: false } } },
      body: body ?? [{ id: "check", kind: "shell", cmd: "echo hi", on_done: { set: { done: true } } }],
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      caps: { max_iterations: 3 },
      schedule,
    });
    expect(r.validation!.ok, JSON.stringify(r.validation?.errors)).toBe(true);
    return new Map(planLoopExport(r.spec!, "standalone").files.map((f) => [f.relativePath, f.contents]));
  }

  it("translates a weekly cron FAITHFULLY to systemd OnCalendar + launchd Weekday (not every-15-min)", () => {
    const files = scheduleFiles({ mode: "cron", cron: "0 9 * * 1" });
    const timer = files.get("schedule/s.timer")!;
    expect(timer).toContain("OnCalendar=Mon *-*-* 09:00:00");
    expect(timer).not.toContain("OnCalendar=*:0/15");
    expect(timer).not.toContain("WARNING");
    const plist = files.get("schedule/s.plist")!;
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Weekday</key><integer>1</integer>");
    expect(plist).toContain("<key>Hour</key><integer>9</integer>");
    expect(plist).not.toContain("<key>StartInterval</key>");
    expect(plist).not.toContain("WARNING");
  });

  it("translates a weekday RANGE to a systemd Mon..Fri + a launchd <array> of weekday dicts", () => {
    const files = scheduleFiles({ mode: "cron", cron: "0 9 * * 1-5" });
    expect(files.get("schedule/s.timer")).toContain("OnCalendar=Mon..Fri *-*-* 09:00:00");
    const plist = files.get("schedule/s.plist")!;
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<array>");
    expect(plist).toContain("<key>Weekday</key><integer>1</integer>");
    expect(plist).toContain("<key>Weekday</key><integer>5</integer>");
  });

  it("translates a fixed daily time FAITHFULLY (no silent every-15-min fallback)", () => {
    const files = scheduleFiles({ mode: "cron", cron: "30 6 * * *" });
    expect(files.get("schedule/s.timer")).toContain("OnCalendar=*-*-* 06:30:00");
    const plist = files.get("schedule/s.plist")!;
    expect(plist).toContain("<key>Hour</key><integer>6</integer>");
    expect(plist).toContain("<key>Minute</key><integer>30</integer>");
  });

  it("cronFromDuration: a 2-day sleep yields a day-of-month step cron, faithfully translated for systemd", () => {
    const body = [
      { id: "check", kind: "shell", cmd: "echo hi", on_done: { set: { done: true } } },
      { id: "nap", kind: "sleep", for: "2d" },
    ];
    const files = scheduleFiles({ mode: "forever" }, body);
    // crontab + gh-actions carry the real day-step cron...
    expect(files.get("schedule/crontab.txt")).toContain("0 0 */2 * *");
    expect(files.get("schedule/s.gh-actions.yml")).toContain('cron: "0 0 */2 * *"');
    // ...systemd expresses the day step faithfully...
    expect(files.get("schedule/s.timer")).toContain("OnCalendar=*-*-01/2 00:00:00");
    expect(files.get("schedule/s.timer")).not.toContain("WARNING");
    // ...but launchd cannot express a day STEP, so it must warn loudly + use the placeholder.
    const plist = files.get("schedule/s.plist")!;
    expect(plist).toContain("WARNING: could not translate cron");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>900</integer>");
  });

  it("cronFromDuration: a >=32-day sleep is out of the 1-31 day field range, so it falls back to the default cron", () => {
    const body = [
      { id: "check", kind: "shell", cmd: "echo hi", on_done: { set: { done: true } } },
      { id: "nap", kind: "sleep", for: "40d" },
    ];
    const files = scheduleFiles({ mode: "forever" }, body);
    const crontab = files.get("schedule/crontab.txt")!;
    expect(crontab).toContain("*/15 * * * *"); // default — NOT an invalid */40 day-of-month
    expect(crontab).not.toContain("*/40");
    expect(crontab).toContain("default — no cron or sleep cadence found");
  });

  it("fails LOUD (no false header) for a cron it cannot faithfully translate to systemd/launchd", () => {
    const files = scheduleFiles({ mode: "cron", cron: "*/15 9 * * *" });
    const timer = files.get("schedule/s.timer")!;
    expect(timer).toContain('WARNING: could not translate cron "*/15 9 * * *" to a systemd OnCalendar');
    expect(timer).toContain("PLACEHOLDER");
    expect(timer).toContain("OnCalendar=*:0/15");
    expect(timer).not.toContain("OnCalendar derived from cron"); // never claims it was honored
    const plist = files.get("schedule/s.plist")!;
    expect(plist).toContain('WARNING: could not translate cron "*/15 9 * * *" to a launchd');
    expect(plist).not.toContain("Schedule derived from cron");
    // crontab + gh-actions still carry the real cron.
    expect(files.get("schedule/crontab.txt")).toContain("*/15 9 * * *");
    expect(files.get("schedule/s.gh-actions.yml")).toContain('cron: "*/15 9 * * *"');
  });

  it("gh-actions persists the .loopy journal across fires via actions/cache (so it resumes, not restarts)", () => {
    const yml = scheduleFiles({ mode: "cron", cron: "*/5 * * * *" }).get("schedule/s.gh-actions.yml")!;
    expect(yml).toContain("uses: actions/cache@v4");
    expect(yml).toContain("path: .loopy");
    expect(yml).toContain("key: loopy-s-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(yml).toContain("restore-keys:");
    expect(yml).toContain("loopy-s-");
    // the cache step is wrapped around the durable run step (restore before it runs).
    expect(yml.indexOf("actions/cache@v4")).toBeLessThan(yml.indexOf("- run: node loop.mjs step"));
  });

  it("warns about the launchd/systemd minimal-PATH 'env node' gotcha in the .plist and .service", () => {
    const files = scheduleFiles({ mode: "cron", cron: "*/5 * * * *" });
    const service = files.get("schedule/s.service")!;
    expect(service).toContain("PATH");
    expect(service).toContain("Environment=PATH=");
    const plist = files.get("schedule/s.plist")!;
    expect(plist.toLowerCase()).toContain("path");
    expect(plist).toContain("node");
  });
});

describe("babysitter adapter", () => {
  const spec = deployWatchSpec();
  const plan = planLoopExport(spec, "babysitter");
  const fileMap = new Map(plan.files.map((f) => [f.relativePath, f.contents]));

  it("emits a durable process file", () => {
    expect(fileMap.has("process.mjs")).toBe(true);
    expect(fileMap.has("babysitter.json")).toBe(true);
    const proc = fileMap.get("process.mjs")!;
    expect(proc).toContain("export async function process(inputs, ctx)");
    expect(proc).toContain('import { defineTask } from "@a5c-ai/babysitter-sdk";'); // real SDK
    expect(proc).toContain('defineTask("loopy-shell"');
    expect(proc).toContain("while (!((state?.status === \"green\")))");
    expect(proc).toContain("await ctx.task(__shellTask,"); // DefinedTask, not inline
    expect(proc).toContain("__curl("); // http lowered to curl
    expect(proc).toContain("ctx.now().getTime()"); // sleepUntil takes a timestamp
    expect(proc).toContain("const MAX_ITERATIONS = 288;");
    expect(fileMap.get("package.json")).toContain("@a5c-ai/babysitter-sdk"); // installable
  });

  it("warns honestly about soft/unsupported capabilities", () => {
    const joined = plan.warnings.join(" | ");
    expect(joined).toContain("http-native");
    expect(joined).toContain("token-budget");
  });

  it("matches the golden snapshot", () => {
    expect(fileMap.get("process.mjs")).toMatchSnapshot();
  });
});

describe("shell argv form codegen", () => {
  const raw = {
    loopspec: "0.1",
    id: "argv",
    pattern: "react",
    inputs: { x: { type: "string" } },
    state: { vars: { done: { type: "boolean", init: false } } },
    body: [
      { id: "w", kind: "shell", cmd: "git", args: ["status", "${inputs.x}"], on_done: { set: { done: true } } },
    ],
    terminate: { signal: "state-predicate", until: "${state.done == true}" },
    caps: { max_iterations: 3 },
  };

  it("standalone lowers shell args to the {command, args} (execFile) form", () => {
    const r = processRaw(raw);
    expect(r.validation!.ok).toBe(true);
    const loop = planLoopExport(r.spec!, "standalone").files.find((f) => f.relativePath === "loop.mjs")!.contents;
    expect(loop).toContain("ctx.shell({ command:");
    expect(loop).toContain("args: [");
  });
});

describe("http envelope (opt-in status/headers/body)", () => {
  function envSpec(envelope: boolean): LoopSpec {
    const r = processRaw({
      loopspec: "0.1",
      id: "env",
      pattern: "poll-until",
      state: { vars: { code: { type: "int", init: 0 }, done: { type: "boolean", init: false } } },
      body: [
        {
          id: "check",
          kind: "http",
          request: { method: "GET", url: "https://api.example/health" },
          ...(envelope ? { envelope: true } : {}),
          save: { code: "$.status", done: "$.body.ready" },
        },
      ],
      terminate: { signal: "state-predicate", until: "${state.done == true}" },
      caps: { max_iterations: 3 },
    });
    expect(r.validation!.ok).toBe(true);
    return r.spec!;
  }

  it("standalone threads `envelope: true` into the ctx.http arg when opted in", () => {
    const loop = planLoopExport(envSpec(true), "standalone").files.find((f) => f.relativePath === "loop.mjs")!.contents;
    expect(loop).toContain("await ctx.http({ method: \"GET\", url: `https://api.example/health`, envelope: true });");
    expect(loop).toContain("state[\"code\"] = ctx.jsonpath(__res, \"$.status\");");
  });

  it("standalone default (no envelope) is unchanged — body-direct, no envelope flag", () => {
    const loop = planLoopExport(envSpec(false), "standalone").files.find((f) => f.relativePath === "loop.mjs")!.contents;
    expect(loop).toContain("await ctx.http({ method: \"GET\", url: `https://api.example/health` });");
    expect(loop).not.toContain("envelope: true");
  });

  it("babysitter rebuilds the envelope via __httpEnv + a -w sentinel when opted in", () => {
    const proc = planLoopExport(envSpec(true), "babysitter").files.find((f) => f.relativePath === "process.mjs")!.contents;
    expect(proc).toContain("function __httpEnv(raw)");
    expect(proc).toContain("__LOOPY_HTTP__%{http_code}__LOOPY_SEP__%{header_json}");
    expect(proc).toContain("const __res = __httpEnv(await ctx.task(__shellTask,");
    expect(proc).toContain("envelope: true");
  });

  it("babysitter default (no envelope) does not wrap in __httpEnv", () => {
    const proc = planLoopExport(envSpec(false), "babysitter").files.find((f) => f.relativePath === "process.mjs")!.contents;
    expect(proc).toContain("const __res = await ctx.task(__shellTask,");
    expect(proc).not.toContain("__httpEnv(await");
  });
});

describe("babysitter __httpEnv envelope parity + robustness (audit)", () => {
  it("normalizes curl header_json (mixed-case keys, array values) to execHttp's lowercase joined-string shape", () => {
    const { __httpEnv } = babysitterHelpers();
    // representative curl -w writeout: body + sentinel + %{header_json} (ORIGINAL-case keys, ARRAY values)
    const headerJson = JSON.stringify({ "Content-Type": ["application/json"], "Set-Cookie": ["a=1", "b=2"], "X-Trace": ["abc"] });
    const env = __httpEnv('{"state":"green"}__LOOPY_HTTP__200__LOOPY_SEP__' + headerJson);
    expect(env.status).toBe(200);
    expect(env.ok).toBe(true);
    expect(env.body).toEqual({ state: "green" });
    // identical to execHttp's res.headers.forEach shape: lowercase keys, comma-joined STRING values
    expect(env.headers["content-type"]).toBe("application/json");
    expect(env.headers["set-cookie"]).toBe("a=1, b=2");
    expect(env.headers["x-trace"]).toBe("abc");
    expect(env.headers["Content-Type"]).toBeUndefined(); // the original-case key is gone (lowercased)
    // so `save: { ct: "$.headers.content-type" }` reads a string under babysitter, as it does standalone
    expect(typeof env.headers["content-type"]).toBe("string");
  });

  it("recovers status/headers/body even when the body or a header value contains the literal sentinel", () => {
    const { __httpEnv } = babysitterHelpers();
    // the literal sentinel substring appears in BOTH the body and a header value, but never as a
    // well-formed MARK<digits>SEP — a bare lastIndexOf would land inside the header JSON and break.
    const body = JSON.stringify({ note: "contains __LOOPY_HTTP__ and __LOOPY_SEP__ literally" });
    const headerJson = JSON.stringify({ "X-Echo": ["saw __LOOPY_HTTP__ here"] });
    const env = __httpEnv(body + "__LOOPY_HTTP__503__LOOPY_SEP__" + headerJson);
    expect(env.status).toBe(503);
    expect(env.ok).toBe(false);
    expect(env.body).toEqual({ note: "contains __LOOPY_HTTP__ and __LOOPY_SEP__ literally" });
    expect(env.headers["x-echo"]).toBe("saw __LOOPY_HTTP__ here");
  });

  it("a well-formed sentinel inside the body does not hijack the split (the LAST match — the real writeout — wins)", () => {
    const { __httpEnv } = babysitterHelpers();
    const body = "__LOOPY_HTTP__999__LOOPY_SEP__ fake-sentinel-in-body";
    const env = __httpEnv(body + "__LOOPY_HTTP__204__LOOPY_SEP__" + JSON.stringify({ "X-Ok": ["yes"] }));
    expect(env.status).toBe(204);
    expect(env.body).toBe(body); // non-JSON body recovered verbatim, the fake sentinel left intact
    expect(env.headers["x-ok"]).toBe("yes");
  });

  it("on_exit http carries NO -w envelope sentinel (the result is discarded, so envelope is pure garbage)", () => {
    const r = processRaw({
      loopspec: "0.1",
      id: "exit-http",
      pattern: "poll-until",
      state: { vars: { done: { type: "boolean", init: false } } },
      body: [{ id: "check", kind: "shell", cmd: "echo hi", on_done: { set: { done: true } } }],
      terminate: {
        signal: "state-predicate",
        until: "${state.done == true}",
        // envelope:true requested, but on_exit has no `save` so it must NOT emit a sentinel
        on_exit: { kind: "http", request: { method: "POST", url: "https://api.example/notify" }, envelope: true },
      },
      caps: { max_iterations: 3 },
    });
    expect(r.validation!.ok, JSON.stringify(r.validation?.errors)).toBe(true);
    const proc = planLoopExport(r.spec!, "babysitter").files.find((f) => f.relativePath === "process.mjs")!.contents;
    // the on_exit curl is emitted...
    expect(proc).toContain('command: __curl({ method: "POST", url: `https://api.example/notify` })');
    // ...with NO envelope flag, so __curl never appends the -w status/header sentinel for it.
    expect(proc).not.toContain('url: `https://api.example/notify`, envelope: true');
  });
});

describe("claude-code (prose) adapter", () => {
  const spec = deployWatchSpec();
  const plan = planLoopExport(spec, "claude-code");
  const fileMap = new Map(plan.files.map((f) => [f.relativePath, f.contents]));

  it("emits a prose execution guide + provenance", () => {
    expect(fileMap.has("deploy-watch.loop.md")).toBe(true);
    expect(fileMap.has("loop.lock")).toBe(true);
    const md = fileMap.get("deploy-watch.loop.md")!;
    expect(md).toContain("execution guide");
    expect(md).toContain("Exit when:");
    expect(md).toContain("```mermaid"); // self-documenting flow
    expect(md).toContain("**check**"); // a step rendered as prose
    expect(md).toContain("at most **288** iterations");
  });

  it("honestly warns that enforcement is soft (no journal/replay)", () => {
    const joined = plan.warnings.join(" | ");
    expect(joined).toContain("journal");
  });
});

describe("claude-native adapter", () => {
  const spec = deployWatchSpec();
  const plan = planLoopExport(spec, "claude-native");
  const fileMap = new Map(plan.files.map((f) => [f.relativePath, f.contents]));

  it("emits an installable Claude Code project skill", () => {
    expect(fileMap.has(".claude/skills/deploy-watch/SKILL.md")).toBe(true);
    expect(fileMap.has(".claude/skills/deploy-watch/reference/loopspec.json")).toBe(true);
    expect(fileMap.has(".claude/skills/deploy-watch/scripts/run-standalone.mjs")).toBe(true);
    expect(fileMap.has(".claude/skills/deploy-watch/loop.lock")).toBe(true);
    expect(fileMap.has("README.md")).toBe(true);
    expect(fileMap.has("loop.lock")).toBe(true);
  });

  it("makes the slash skill manual-only and embeds the loop contract", () => {
    const skill = fileMap.get(".claude/skills/deploy-watch/SKILL.md")!;
    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).toContain("/deploy-watch");
    expect(skill).toContain("node \"${CLAUDE_SKILL_DIR}/scripts/run-standalone.mjs\" <command> '<inputs-json>'");
    expect(skill).toContain("Exit when: `${state.status == 'green'}`");
    expect(skill).toContain("max_iterations=288");
    expect(skill).toContain("append a short entry to `.loopy/claude-native/deploy-watch/journal.md`");
  });

  it("bundles a hybrid runner that finds a sibling standalone artifact", () => {
    const runner = fileMap.get(".claude/skills/deploy-watch/scripts/run-standalone.mjs")!;
    expect(runner).toContain("LOOPY_ARTIFACT_DIR");
    expect(runner).toContain("loop.mjs");
    expect(runner).toContain("writeFileSync(join(dir, \"inputs.json\")");
    expect(runner).toContain('command === "inspect"');
    expect(runner).toContain('command === "approve" ? "resume" : command');
    expect(plan.files.find((f) => f.relativePath.endsWith("run-standalone.mjs"))!.executable).toBe(true);
  });

  it("keeps the full normalized LoopSpec available for audit", () => {
    const embedded = JSON.parse(fileMap.get(".claude/skills/deploy-watch/reference/loopspec.json")!);
    expect(embedded.id).toBe("deploy-watch");
    expect(embedded.pattern).toBe("poll-until");
    expect(embedded.terminate.until).toBe("${state.status == 'green'}");
  });

  it("warns that guarantees are soft unless delegated to standalone", () => {
    const joined = plan.warnings.join(" | ");
    expect(joined).toContain("journal");
    expect(joined).toContain("token-budget");
    expect(joined).toContain("http-native");
  });
});

describe("n8n adapter", () => {
  const spec = deployWatchSpec();
  const plan = planLoopExport(spec, "n8n");
  const fileMap = new Map(plan.files.map((f) => [f.relativePath, f.contents]));

  it("emits an importable workflow JSON + README", () => {
    expect(fileMap.has("deploy-watch.n8n.json")).toBe(true);
    expect(fileMap.has("README.md")).toBe(true);
    const wf = JSON.parse(fileMap.get("deploy-watch.n8n.json")!);
    expect(Array.isArray(wf.nodes)).toBe(true);
    expect(wf.nodes.some((n: { type: string }) => n.type === "n8n-nodes-base.httpRequest")).toBe(true);
    expect(wf.connections).toBeDefined();
    expect(wf.name).toBe("deploy-watch");
  });

  it("warns that it is a best-effort scaffold", () => {
    const joined = plan.warnings.join(" | ");
    expect(joined).toContain("no-progress");
  });

  it("lowers agent/http/sleep/breakpoint to REAL nodes (no noOp placeholders)", () => {
    const wf = JSON.parse(fileMap.get("deploy-watch.n8n.json")!);
    const types = wf.nodes.map((n: { type: string }) => n.type);
    expect(types).not.toContain("n8n-nodes-base.noOp");
    // poll-until has an http check, an agent triage, and a sleep
    expect(types.filter((t: string) => t === "n8n-nodes-base.httpRequest").length).toBeGreaterThanOrEqual(2); // http step + agent step
    expect(types).toContain("n8n-nodes-base.wait"); // sleep
  });

  it("the agent node is a configured OpenAI-compatible httpRequest", () => {
    const wf = JSON.parse(fileMap.get("deploy-watch.n8n.json")!);
    const agent = wf.nodes.find((n: { name: string }) => n.name === "triage");
    expect(agent.type).toBe("n8n-nodes-base.httpRequest");
    expect(JSON.stringify(agent.parameters)).toContain("/chat/completions");
    expect(JSON.stringify(agent.parameters)).toContain("LOOPY_LLM_API_KEY");
  });

  it("the exit? IF node carries a real lowered condition (not empty)", () => {
    const wf = JSON.parse(fileMap.get("deploy-watch.n8n.json")!);
    const ifNode = wf.nodes.find((n: { name: string }) => n.name === "exit?");
    expect(ifNode.parameters.conditions.conditions.length).toBeGreaterThan(0);
    expect(JSON.stringify(ifNode.parameters.conditions)).toContain("$json.status");
  });
});

describe("gate enforcement (lowered to inline breakpoints)", () => {
  const r = processRaw({
    loopspec: "0.1",
    id: "gated",
    pattern: "react",
    state: { vars: { done: { type: "boolean", init: false } } },
    body: [
      { id: "plan", kind: "agent", harness: "claude-code", prompt: "plan it" },
      { id: "apply", kind: "shell", cmd: "echo apply", on_done: { set: { done: true } } },
    ],
    gates: [
      { after: "plan", when: "${state.done == false}", ask: "Approve the plan before applying?" },
      { ask: "Sign off this iteration?" },
    ],
    terminate: { signal: "state-predicate", until: "${state.done == true}" },
    caps: { max_iterations: 5 },
  });
  const spec = r.spec!;

  it("validates", () => expect(r.validation!.ok).toBe(true));

  it("standalone emits a guarded breakpoint after the gated step + a trailing gate", () => {
    const files = new Map(planLoopExport(spec, "standalone").files.map((f) => [f.relativePath, f.contents]));
    const loop = files.get("loop.mjs")!;
    expect(loop).toContain("Approve the plan before applying?");
    expect(loop).toContain("await ctx.breakpoint(");
    expect(loop).toContain("Sign off this iteration?"); // trailing (after-less) gate
    // the gate's `when` is honored
    expect(loop).toMatch(/if \(\(state\?\.done === false\)\) \{\s*await ctx\.breakpoint/);
  });

  it("babysitter emits the gate as a ctx.breakpoint too (no longer silently dropped)", () => {
    const files = new Map(planLoopExport(spec, "babysitter").files.map((f) => [f.relativePath, f.contents]));
    const proc = [...files.values()].join("\n");
    expect(proc).toContain("Approve the plan before applying?");
    expect(proc).toContain("await ctx.breakpoint(");
  });
});

describe("n8n adapter — http headers/body + reduce wiring", () => {
  const r = processRaw({
    loopspec: "0.1",
    id: "nred",
    pattern: "map-reduce",
    state: { vars: { done: { type: "boolean", init: false }, acc: { type: "list", init: [] } } },
    inputs: { items: { type: "list", required: true }, token: { type: "string", required: true } },
    body: [
      {
        id: "post",
        kind: "http",
        request: { method: "POST", url: "https://api.example/ingest", headers: { authorization: "Bearer ${inputs.token}" }, body: '{"k":1}' },
      },
      {
        id: "fan",
        kind: "reduce",
        over: "${inputs.items}",
        body: [{ id: "work", kind: "shell", cmd: "echo ${item}", on_done: { set: { done: true } } }],
      },
    ],
    terminate: { signal: "state-predicate", until: "${state.done == true}" },
    caps: { max_iterations: 50 },
  });
  const spec = r.spec!;
  const plan = planLoopExport(spec, "n8n");
  const wf = JSON.parse(plan.files.find((f) => f.relativePath.endsWith(".n8n.json"))!.contents);

  it("validates", () => expect(r.validation!.ok).toBe(true));

  it("http node carries headers and a JSON body", () => {
    const post = wf.nodes.find((n: { name: string }) => n.name === "post");
    expect(post.parameters.sendHeaders).toBe(true);
    expect(JSON.stringify(post.parameters.headerParameters)).toContain("authorization");
    expect(post.parameters.sendBody).toBe(true);
    expect(post.parameters.jsonBody).toContain('"k":1');
  });

  it("reduce becomes a SplitInBatches node with its body emitted and looped back", () => {
    const fan = wf.nodes.find((n: { name: string }) => n.name === "fan");
    expect(fan.type).toBe("n8n-nodes-base.splitInBatches");
    const work = wf.nodes.find((n: { name: string }) => n.name === "work");
    expect(work).toBeDefined(); // body node emitted (was dropped before)
    // SplitInBatches loop output → body; body → back to SplitInBatches
    expect(JSON.stringify(wf.connections["fan"])).toContain("work");
    expect(JSON.stringify(wf.connections["work"])).toContain("fan");
  });
});
