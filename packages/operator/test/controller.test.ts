import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorRunController, OperatorScheduler, nextCronOccurrence } from "../src/controller.js";
import { OperatorRegistry } from "../src/registry.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "loopy-controller-")); }

function runnableArtifact(root: string, schedule = "manual"): string {
  const path = join(root, "artifact");
  mkdirSync(path, { recursive: true });
  const cron = schedule === "cron" ? `, cron: "*/5 * * * *"` : "";
  writeFileSync(join(path, "loop.source.yaml"), `loopspec: "0.1"
id: controlled
pattern: react
state: { vars: { done: { type: boolean, init: false } } }
body:
  - id: finish
    kind: shell
    cmd: finish
    on_done: { set: { done: true } }
terminate: { signal: state-predicate, until: "\${state.done == true}" }
caps: { max_iterations: 3, no_progress: { fingerprint: "\${state.done}", max_repeats: 2 }, budget: { tokens: 100, usd: 1, wallclock: 1h }, on_cap_exceeded: exit-clean }
schedule: { mode: ${schedule}${cron} }
observe: { trace: journal }
`);
  writeFileSync(join(path, "loop.lock"), JSON.stringify({ loop_id: "controlled", target: "standalone" }));
  if (schedule !== "manual") mkdirSync(join(path, "schedule"));
  return path;
}

function sleepingArtifact(root: string): string {
  const path = join(root, "sleeping");
  mkdirSync(join(path, "schedule"), { recursive: true });
  writeFileSync(join(path, "loop.source.yaml"), `loopspec: "0.1"
id: sleeping
pattern: react
body:
  - { id: wait, kind: sleep, for: 5m }
terminate: { signal: state-predicate, until: "\${iteration >= 2}" }
caps: { max_iterations: 3, no_progress: { fingerprint: "\${iteration}", max_repeats: 2 }, budget: { wallclock: 1h }, on_cap_exceeded: exit-clean }
schedule: { mode: forever }
observe: { trace: journal }
`);
  writeFileSync(join(path, "loop.lock"), JSON.stringify({ loop_id: "sleeping", target: "standalone" }));
  return path;
}

describe("operator run controller", () => {
  it("prevents duplicate active runs, persists claims, and audits attributable outcomes", async () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(runnableArtifact(root));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const controller = new OperatorRunController({
      registry,
      now: () => 1_700_000_000_000,
      runtimeOptions: () => ({ effects: { shell: async () => { await blocked; return {}; } } }),
    });

    const first = controller.execute("controlled", "run", { actor: "alice", surface: "api", runId: "run-one", reason: "manual check" });
    expect(controller.readState().loops.controlled?.active).toMatchObject({ runId: "run-one", pid: process.pid });
    expect(() => controller.execute("controlled", "step", { actor: "bob", surface: "api", runId: "run-two" })).toThrow(/already has active run/);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed", iteration: 1 });
    expect(controller.readState().loops.controlled?.active).toBeUndefined();
    expect(statSync(registry.paths.scheduler).mode & 0o777).toBe(0o600);

    const audit = readFileSync(registry.paths.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: "alice", surface: "api", action: "run.run", outcome: "accepted", loopId: "controlled", runId: "run-one" }),
      expect.objectContaining({ actor: "alice", surface: "api", action: "run.run", outcome: "completed", specHash: expect.any(String) }),
    ]));
  });

  it("journals a graceful stop and resumes without poisoning the run", async () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(runnableArtifact(root));
    const controller = new OperatorRunController({ registry, runtimeOptions: () => ({ effects: { shell: async () => ({}) } }) });
    await expect(controller.execute("controlled", "step", { actor: "alice", surface: "cli", runId: "durable" })).resolves.toMatchObject({ status: "waiting" });
    controller.requestStop("controlled", { actor: "alice", surface: "cli", runId: "durable", reason: "maintenance", action: "pause" });
    await expect(controller.execute("controlled", "resume", { actor: "alice", surface: "cli", runId: "durable", reason: "maintenance complete" })).resolves.toMatchObject({ status: "completed" });
    const events = readFileSync(join(registry.get("controlled")!.path, ".loopy", "runs", "durable", "events.jsonl"), "utf8");
    expect(events).toContain('"type":"stop_requested"');
    expect(events).toContain('"type":"stop_cleared"');
    expect(events).toContain('"type":"terminated"');
  });

  it("recovers stale claims and preserves schedule state across controller restart", () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(runnableArtifact(root, "cron"));
    writeFileSync(registry.paths.scheduler, JSON.stringify({ schemaVersion: 1, loops: { controlled: { nextDueAt: 1234, active: { pid: 999_999_999, runId: "stale", action: "step", startedAt: 1 } } } }));
    const recovered = new OperatorRunController({ registry });
    expect(recovered.readState().loops.controlled).toMatchObject({ nextDueAt: 1234, lastOutcome: "failed" });
    expect(recovered.readState().loops.controlled?.active).toBeUndefined();
    const restarted = new OperatorRunController({ registry });
    expect(restarted.readState().loops.controlled?.nextDueAt).toBe(1234);
  });
});

describe("operator scheduler", () => {
  it("requires explicit host-to-operator handoff and persists the next cron fire", () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(runnableArtifact(root, "cron"));
    const now = new Date(2026, 0, 2, 10, 1, 30).getTime();
    const controller = new OperatorRunController({ registry, now: () => now });
    const scheduler = new OperatorScheduler(controller, 1_000, () => now);
    const scheduled = scheduler.enable("controlled");
    registry.handoff("controlled", "operator", { actor: "alice", surface: "cli", reason: "disabled host timer" });
    expect(registry.get("controlled")?.schedulerAuthority).toBe("operator");
    expect(scheduled.nextDueAt).toBe(new Date(2026, 0, 2, 10, 5, 0).getTime());
    expect(new OperatorRunController({ registry }).readState().loops.controlled?.nextDueAt).toBe(scheduled.nextDueAt);
  });

  it("computes validated five- and six-field cron occurrences", () => {
    const base = new Date(2026, 0, 2, 10, 1, 30).getTime();
    expect(nextCronOccurrence("*/5 * * * *", base)).toBe(new Date(2026, 0, 2, 10, 5, 0).getTime());
    expect(nextCronOccurrence("*/10 * * * * *", base)).toBe(new Date(2026, 0, 2, 10, 1, 40).getTime());
    expect(() => nextCronOccurrence("*/0 * * * *", base)).toThrow(/cron step/);
  });

  it("retains only the newest missed invocation while a loop is active", async () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(runnableArtifact(root, "forever"));
    let now = 1_700_000_000_000;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const controller = new OperatorRunController({ registry, now: () => now, runtimeOptions: () => ({ effects: { shell: async () => { await blocked; return {}; } } }) });
    const scheduler = new OperatorScheduler(controller, 1_000, () => now);
    scheduler.enable("controlled");
    registry.handoff("controlled", "operator", { actor: "alice", surface: "cli", reason: "host trigger disabled" });
    scheduler.tick(now);
    await vi.waitFor(() => expect(controller.isActive("controlled")).toBe(true));
    now += 60_000;
    scheduler.tick(now);
    const firstMissed = controller.readState().loops.controlled?.pendingDueAt;
    now += 60_000;
    scheduler.tick(now);
    expect(controller.readState().loops.controlled?.pendingDueAt).toBeGreaterThan(firstMissed!);
    release();
    await vi.waitFor(() => expect(controller.isActive("controlled")).toBe(false));
  });

  it("persists a durable sleep wake time across controller restart", async () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(sleepingArtifact(root));
    const now = 1_700_000_000_000;
    const controller = new OperatorRunController({ registry, now: () => now, runtimeOptions: () => ({ now: () => now, maxBlockMs: 0 }) });
    const scheduler = new OperatorScheduler(controller, 1_000, () => now);
    scheduler.enable("sleeping");
    registry.handoff("sleeping", "operator", { actor: "alice", surface: "cli", reason: "host trigger disabled" });
    scheduler.tick(now);
    await vi.waitFor(() => expect(controller.isActive("sleeping")).toBe(false));
    await vi.waitFor(() => expect(controller.readState().loops.sleeping?.nextDueAt).toBe(now + 300_000));
    expect(new OperatorRunController({ registry }).readState().loops.sleeping?.nextDueAt).toBe(now + 300_000);
  });
});
