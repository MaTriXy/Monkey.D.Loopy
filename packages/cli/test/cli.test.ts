import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBlueprint } from "@loopyc/core";
import { run } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "loopc-"));
const POLL = getBlueprint("poll-until")!.yaml;
const UNBOUNDED = 'loopspec: "0.1"\nid: x\npattern: react\nbody:\n  - { id: w, kind: shell, cmd: ":" }\n';
// A tiny bounded shell loop: runs `echo hi` once, saves it, then terminates (out != null).
const TINY_SHELL = [
  'loopspec: "0.1"',
  "id: tiny",
  "meta: { name: tiny, description: one-shot }",
  "pattern: loop-until-dry",
  "state:",
  "  store: journal",
  "  vars:",
  "    out: { type: json, init: null }",
  "body:",
  "  - id: run",
  "    kind: shell",
  '    cmd: "echo hi"',
  '    save: { out: "$" }',
  "terminate:",
  "  signal: state-predicate",
  '  until: "${state.out != null}"',
  "caps:",
  "  max_iterations: 5",
  "  budget: { tokens: 200000, usd: 5.0, wallclock: 1h }",
  "  on_cap_exceeded: breakpoint",
  "",
].join("\n");

/** Capture console.log output while running a command. */
async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
  try {
    const code = await run(argv);
    return { code, out: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

describe("loopc run() — dispatch + commands", () => {
  it("validate: 0 for a valid spec, 1 for an unbounded one", async () => {
    const d = tmp();
    const good = join(d, "g.yaml");
    writeFileSync(good, POLL);
    expect(await run(["validate", good])).toBe(0);
    const bad = join(d, "b.yaml");
    writeFileSync(bad, UNBOUNDED);
    expect(await run(["validate", bad])).toBe(1);
  });

  it("compile: writes target files + an embedded loop.source.yaml", async () => {
    const d = tmp();
    const f = join(d, "s.yaml");
    writeFileSync(f, POLL);
    const out = join(d, "out");
    expect(await run(["compile", f, "--target", "standalone", "--out", out])).toBe(0);
    expect(existsSync(join(out, "standalone", "loop.mjs"))).toBe(true);
    expect(existsSync(join(out, "standalone", "loop.source.yaml"))).toBe(true);
  });

  it("new --from-shell requires --until, and the result validates", async () => {
    const d = tmp();
    expect(await run(["new", "p", "--from-shell", "echo hi", "--out", join(d, "p.yaml")])).toBe(1);
    expect(await run(["new", "p", "--from-shell", "echo hi", "--until", "${state.out != null}", "--out", join(d, "p2.yaml")])).toBe(0);
    expect(await run(["validate", join(d, "p2.yaml")])).toBe(0);
  });

  it("quickstart proves, runs, journals, and vendors a safe first loop without overwriting", async () => {
    const d = join(tmp(), "first-loop");
    const result = await capture(["quickstart", d]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("first loop complete");
    expect(result.out).toContain("Scorecard: 100/100");
    expect(result.out).toContain("signal: oracle · grounding: external");
    expect(result.out).toContain("completed hook");
    expect(existsSync(join(d, "hello-loopy.loop.yaml"))).toBe(true);
    expect(existsSync(join(d, "verify-fixtures.json"))).toBe(true);
    expect(existsSync(join(d, "run", ".loopy", "runs", "default", "events.jsonl"))).toBe(true);
    const yaml = readFileSync(join(d, "hello-loopy.loop.yaml"), "utf8");
    expect(yaml).toContain("signal: oracle");
    expect(yaml).toContain('save: { done: "$.done", out: "$" }');
    const events = readFileSync(join(d, "run", ".loopy", "runs", "default", "events.jsonl"), "utf8");
    expect(events).toContain('"type":"observer"');
    expect(events).toContain('"event":"completed","status":"done"');
    expect(existsSync(join(d, "artifact", "standalone", "runtime.bundle.mjs"))).toBe(true);
    const artifact = join(d, "artifact", "standalone");
    const artifactRun = spawnSync(process.execPath, ["loop.mjs", "run"], { cwd: artifact, encoding: "utf8" });
    expect(artifactRun.status, artifactRun.stderr).toBe(0);
    expect(JSON.parse(artifactRun.stdout)).toMatchObject({ status: "completed", state: { done: true } });
    const artifactEvents = readFileSync(join(artifact, ".loopy", "runs", "default", "events.jsonl"), "utf8");
    expect(artifactEvents).toContain('"type":"observer"');
    expect(artifactEvents).toContain('"event":"completed","status":"done"');
    expect(await run(["quickstart", d])).toBe(1);
  });

  it("rejects malformed or unknown verification fixture data", async () => {
    const d = tmp();
    const spec = join(d, "tiny.yaml");
    writeFileSync(spec, TINY_SHELL);
    const malformed = join(d, "malformed.json");
    writeFileSync(malformed, "{");
    await expect(run(["verify", spec, "--fixtures", malformed])).rejects.toThrow("invalid verification fixture JSON");
    const unknown = join(d, "unknown.json");
    writeFileSync(unknown, JSON.stringify({ filesystem: { done: true } }));
    await expect(run(["score", spec, "--fixtures", unknown])).rejects.toThrow("unknown verification fixture key");
  });

  it("lists and instantiates verified recipes with provenance in every target lock", async () => {
    const listed = await capture(["recipes"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("repo-health-doctor");
    expect(listed.out).toContain("market-signal-monitor");

    const d = tmp();
    const source = join(d, "health.yaml");
    expect(await run(["new", "health-check", "--recipe", "repo-health-doctor", "--out", source])).toBe(0);
    expect(await run(["validate", source])).toBe(0);
    const yaml = readFileSync(source, "utf8");
    expect(yaml).toContain("name: repo-health-doctor");
    expect(yaml).toContain('version: "1"');

    const out = join(d, "out");
    expect(await run(["compile", source, "--target", "all", "--out", out])).toBe(0);
    for (const target of ["standalone", "babysitter", "claude-code", "claude-native", "n8n"]) {
      const lock = JSON.parse(readFileSync(join(out, target, "loop.lock"), "utf8"));
      expect(lock.recipe).toEqual({ name: "repo-health-doctor", version: "1" });
      expect(lock.artifacts.include).toContain("output/repo-health.md");
      expect(lock.notify).toEqual({ policy: "on-change", channels: [] });
    }
  });

  it("rejects unknown and conflicting recipe scaffolds", async () => {
    expect(await run(["new", "x", "--recipe", "missing"])).toBe(1);
    expect(await run(["new", "x", "--recipe", "repo-health-doctor", "--blueprint", "react"])).toBe(1);
  });

  it("reprint: recompiles from loop.source.yaml; errors without it", async () => {
    const d = tmp();
    const f = join(d, "s.yaml");
    writeFileSync(f, POLL);
    const out = join(d, "out");
    await run(["compile", f, "--target", "standalone", "--out", out]);
    expect(await run(["reprint", join(out, "standalone")])).toBe(0);
    expect(await run(["reprint", d])).toBe(1); // no loop.source.yaml in d
  });

  it("targets → 0; unknown command → 1", async () => {
    expect(await run(["targets"])).toBe(0);
    expect(await run(["bogus"])).toBe(1);
  });

  it("reports the synchronized factory version", async () => {
    const { code, out } = await capture(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("0.7.0");
  });

  it("run: a tiny valid shell loop completes and writes a .loopy journal in the out dir", async () => {
    const d = tmp();
    const f = join(d, "tiny.yaml");
    writeFileSync(f, TINY_SHELL);
    const out = join(d, "run");
    const { code, out: log } = await capture(["run", f, "--out", out]);
    expect(code).toBe(0);
    expect(log).toContain("status:    completed");
    expect(existsSync(join(out, ".loopy", "runs", "default", "events.jsonl"))).toBe(true);
  });

  it("run: refuses an invalid (unbounded) spec — exits non-zero, writes no journal", async () => {
    const d = tmp();
    const f = join(d, "bad.yaml");
    writeFileSync(f, UNBOUNDED);
    const out = join(d, "run");
    expect(await run(["run", f, "--out", out])).toBe(1);
    expect(existsSync(join(out, ".loopy"))).toBe(false);
  });

  it("inspect: reports status, events, and state from a produced run dir", async () => {
    const d = tmp();
    const f = join(d, "tiny.yaml");
    writeFileSync(f, TINY_SHELL);
    const out = join(d, "run");
    await run(["run", f, "--out", out]);
    const { code, out: log } = await capture(["inspect", out]);
    expect(code).toBe(0);
    expect(log).toContain("status: completed");
    expect(log).toMatch(/events: \d+/);
    expect(log).toContain("latest state:");
    expect(log).toContain("terminated");
  });

  it("inspect: errors on a dir with no journal", async () => {
    expect(await run(["inspect", tmp()])).toBe(1);
  });

  it("schedule install: prints platform-appropriate trigger guidance for a scheduled artifact", async () => {
    const d = tmp();
    const f = join(d, "s.yaml");
    writeFileSync(f, POLL); // poll-until → schedule.mode forever → emits schedule/
    const out = join(d, "out");
    await run(["compile", f, "--target", "standalone", "--out", out]);
    const std = join(out, "standalone");
    expect(existsSync(join(std, "schedule"))).toBe(true);
    const { code, out: log } = await capture(["schedule", "install", std]);
    expect(code).toBe(0);
    expect(log).toContain("node loop.mjs step");
    expect(log).toContain("*/5 * * * *"); // cron derived from the 5m sleep
    expect(log).toContain("gh-actions"); // CI option mentioned
    if (process.platform === "darwin") expect(log).toContain("launchctl");
    else if (process.platform === "linux") expect(log).toContain("systemctl");
    else expect(log).toContain("crontab");
  });

  it("schedule install: errors (exit non-zero) when the artifact has no schedule/ dir", async () => {
    expect(await run(["schedule", "install", tmp()])).toBe(1);
    expect(await run(["schedule"])).toBe(1); // missing subcommand/dir
  });

  it("compile --vendor: rejected for any non-standalone target (exit non-zero)", async () => {
    const d = tmp();
    const f = join(d, "tiny.yaml");
    writeFileSync(f, TINY_SHELL);
    expect(await run(["compile", f, "--target", "babysitter", "--out", join(d, "o"), "--vendor"])).toBe(1);
    expect(await run(["compile", f, "--target", "all", "--out", join(d, "o2"), "--vendor"])).toBe(1);
  });
});

// The load-bearing proof: a --vendor artifact is truly self-contained — it runs with plain
// `node`, an EMPTY node_modules, and NO npm install.
describe("loopc compile --vendor — zero-install standalone artifact", () => {
  it("bundles the runtime and runs `node loop.mjs run` to completion with no node_modules", async () => {
    const d = tmp();
    const f = join(d, "tiny.yaml");
    writeFileSync(f, TINY_SHELL);
    const out = join(d, "out");

    expect(await run(["compile", f, "--target", "standalone", "--out", out, "--vendor"])).toBe(0);
    const std = join(out, "standalone");

    // The vendored bundle exists and the entry imports it locally (not the bare package).
    expect(existsSync(join(std, "runtime.bundle.mjs"))).toBe(true);
    expect(readFileSync(join(std, "loop.mjs"), "utf8")).toContain('from "./runtime.bundle.mjs"');

    // package.json carries NO @loopyc/runtime dependency (it's vendored).
    const pkg = JSON.parse(readFileSync(join(std, "package.json"), "utf8"));
    expect(pkg.dependencies["@loopyc/runtime"]).toBeUndefined();

    // Nothing was installed — there is no node_modules to lean on.
    expect(existsSync(join(std, "node_modules"))).toBe(false);

    // Actually run it with plain node from the artifact dir; a terminating shell loop exits 0.
    const r = spawnSync(process.execPath, ["loop.mjs", "run"], {
      cwd: std,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('"status":"completed"');
  });

  it("reprint PRESERVES the vendored, zero-install property (does not silently de-vendor)", async () => {
    const d = tmp();
    const f = join(d, "tiny.yaml");
    writeFileSync(f, TINY_SHELL);
    const out = join(d, "out");
    expect(await run(["compile", f, "--target", "standalone", "--out", out, "--vendor"])).toBe(0);
    const std = join(out, "standalone");

    // reprint in place — must keep the local bundle import + dropped dep + regenerate the bundle.
    expect(await run(["reprint", std])).toBe(0);
    expect(readFileSync(join(std, "loop.mjs"), "utf8")).toContain('from "./runtime.bundle.mjs"');
    expect(readFileSync(join(std, "loop.mjs"), "utf8")).not.toContain('"@loopyc/runtime"');
    expect(JSON.parse(readFileSync(join(std, "package.json"), "utf8")).dependencies["@loopyc/runtime"]).toBeUndefined();
    expect(existsSync(join(std, "runtime.bundle.mjs"))).toBe(true);
    expect(JSON.parse(readFileSync(join(std, "loop.lock"), "utf8")).vendor).toBe(true);

    // and it STILL runs with no node_modules after the reprint.
    const r = spawnSync(process.execPath, ["loop.mjs", "run"], { cwd: std, encoding: "utf8", timeout: 60_000 });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('"status":"completed"');
  });
});
