import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "@loopyc/runtime";
import { OperatorRegistry } from "../src/registry.js";
import { OperatorRunController } from "../src/controller.js";
import { createOperatorServer, type OperatorServerHandle } from "../src/server.js";
import { runOperatorCli } from "../src/cli.js";

const tmp = () => mkdtempSync(join(tmpdir(), "loopy-operator-server-"));
const servers: OperatorServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => undefined)));
});

function artifact(root: string, withSchedule = false): string {
  const path = join(root, "artifact");
  mkdirSync(path, { recursive: true });
  const yaml = `loopspec: "0.1"
id: fixture
pattern: react
state: { vars: { done: { type: boolean, init: false } } }
body:
  - { id: finish, kind: agent, harness: internal, prompt: finish, on_done: { set: { done: true } } }
terminate: { signal: state-predicate, until: "\${state.done == true}" }
caps: { max_iterations: 3, no_progress: { fingerprint: "\${state.done}", max_repeats: 2 }, budget: { tokens: 100, usd: 1, wallclock: 1h }, on_cap_exceeded: exit-clean }
${withSchedule ? 'schedule: { mode: cron, cron: "0 9 * * *" }' : 'schedule: { mode: manual }'}
artifacts: { include: ["output/report.md"], max_files: 10, max_bytes: 1000000 }
notify: { policy: on-change, channels: [] }
observe: { trace: journal }
`;
  writeFileSync(join(path, "loop.source.yaml"), yaml);
  writeFileSync(join(path, "loop.lock"), JSON.stringify({ loop_id: "fixture", target: "standalone" }));
  mkdirSync(join(path, "output"));
  writeFileSync(join(path, "output", "report.md"), "# safe report\n");
  if (withSchedule) mkdirSync(join(path, "schedule"));
  const journal = new Journal(path, "default");
  journal.load();
  journal.append("run_start", { loopId: "fixture", baseState: { done: false } }, 1);
  journal.append("iteration_snapshot", { iteration: 0, state: { done: true }, fp: "true" }, 2);
  journal.append("terminated", { iteration: 1 }, 3);
  journal.writeState({ done: true }, { status: "completed", loopId: "fixture", iteration: 1, updatedAt: 3 });
  return path;
}

describe("operator registry", () => {
  it("imports an artifact without mutation and creates owner-only registry/token files", () => {
    const root = tmp();
    const path = artifact(root);
    const before = readFileSync(join(path, "loop.lock"), "utf8");
    const registry = new OperatorRegistry(join(root, "operator"));
    const installed = registry.install(path);
    const token = registry.ensureToken();
    registry.writePort(4321);
    expect(installed).toMatchObject({ id: "fixture", schedulerAuthority: "host", concurrency: 1, missedRunPolicy: "latest" });
    expect(token.length).toBeGreaterThan(30);
    expect(readFileSync(join(path, "loop.lock"), "utf8")).toBe(before);
    expect(statSync(registry.paths.root).mode & 0o777).toBe(0o700);
    expect(statSync(registry.paths.registry).mode & 0o777).toBe(0o600);
    expect(statSync(registry.paths.token).mode & 0o777).toBe(0o600);
    expect(registry.readPort()).toBe(4321);
    expect(statSync(registry.paths.config).mode & 0o777).toBe(0o600);
  });

  it("refuses operator scheduling when host trigger files exist", () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    expect(() => registry.install(artifact(root, true), { schedulerAuthority: "operator" })).toThrow(/handoff/);
  });

  it("exposes install/list/status through the foreground-safe CLI", async () => {
    const root = tmp();
    const path = artifact(root);
    const previous = process.env.LOOPY_OPERATOR_HOME;
    process.env.LOOPY_OPERATOR_HOME = join(root, "operator-cli");
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => void lines.push(values.join(" ")));
    try {
      expect(await runOperatorCli(["install", path])).toBe(0);
      expect(await runOperatorCli(["list"])).toBe(0);
      expect(await runOperatorCli(["status"])).toBe(1);
      expect(lines.join("\n")).toContain("fixture");
      expect(lines.join("\n")).toContain("operator stopped");
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.LOOPY_OPERATOR_HOME;
      else process.env.LOOPY_OPERATOR_HOME = previous;
    }
  });

  it("proposes, approves, and rolls back an isolated revision through the CLI", async () => {
    const root = tmp();
    const path = artifact(root);
    const original = readFileSync(join(path, "loop.source.yaml"), "utf8");
    const candidatePath = join(root, "candidate.yaml");
    const candidateYaml = original.replace("prompt: finish", "prompt: finish carefully");
    writeFileSync(candidatePath, candidateYaml);
    const previous = process.env.LOOPY_OPERATOR_HOME;
    process.env.LOOPY_OPERATOR_HOME = join(root, "operator-cli-evolution");
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values) => void lines.push(values.join(" ")));
    try {
      expect(await runOperatorCli(["install", path])).toBe(0);
      expect(await runOperatorCli(["evolve", "propose", "fixture", candidatePath, "--actor", "cli-user"])).toBe(0);
      const candidateId = lines.find((line) => line.startsWith("candidate-"))?.split("\t")[0];
      expect(candidateId).toBeTruthy();
      expect(readFileSync(join(path, "loop.source.yaml"), "utf8")).toBe(original);
      expect(await runOperatorCli(["evolve", "approve", "fixture", candidateId!, "--actor", "cli-user", "--reason", "reviewed"])).toBe(0);
      expect(readFileSync(join(path, "loop.source.yaml"), "utf8")).toBe(candidateYaml);
      expect(await runOperatorCli(["evolve", "rollback", "fixture", "--actor", "cli-user", "--reason", "restore"])).toBe(0);
      expect(readFileSync(join(path, "loop.source.yaml"), "utf8")).toBe(original);
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.LOOPY_OPERATOR_HOME;
      else process.env.LOOPY_OPERATOR_HOME = previous;
    }
  });
});

describe("loopback API and control center security", () => {
  it("requires auth on reads, denies cross-origin access, caps bodies, and serves the token-bootstrapped UI", async () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(artifact(root));
    const handle = createOperatorServer({ registry, token: "test-token-0123456789", port: 0 });
    servers.push(handle);
    const address = await handle.start();

    expect((await fetch(`${address.url}/api/v1/health`)).status).toBe(401);
    const auth = { Authorization: `Bearer ${handle.token}` };
    const health = await fetch(`${address.url}/api/v1/health`, { headers: auth });
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBeNull();

    expect((await fetch(`${address.url}/api/v1/loops`, { headers: { ...auth, Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${address.url}/api/v1/loops`, { method: "POST", headers: auth, body: "x".repeat(65_537) })).status).toBe(413);

    const loops = await fetch(`${address.url}/api/v1/loops`, { headers: auth });
    const payload = await loops.json() as { loops: Array<{ id: string; score: number; grounding: string; runs: unknown[] }> };
    expect(payload.loops[0]).toMatchObject({ id: "fixture", grounding: "structural" });
    expect(payload.loops[0]!.score).toBeGreaterThanOrEqual(90);
    expect(payload.loops[0]!.runs).toHaveLength(1);

    const artifacts = await fetch(`${address.url}/api/v1/loops/fixture/artifacts`, { headers: auth });
    expect(artifacts.status).toBe(200);
    expect((await artifacts.json() as { artifacts: { files: Array<{ path: string }> } }).artifacts.files).toEqual([expect.objectContaining({ path: "output/report.md" })]);
    const report = await fetch(`${address.url}/api/v1/loops/fixture/artifacts/output/report.md`, { headers: auth });
    expect(report.headers.get("content-type")).toContain("text/markdown");
    expect(await report.text()).toBe("# safe report\n");
    expect((await fetch(`${address.url}/api/v1/loops/fixture/artifacts/../loop.source.yaml`, { headers: auth })).status).toBe(404);

    const bootstrap = await fetch(`${address.url}/?token=${handle.token}`, { redirect: "manual" });
    expect(bootstrap.status).toBe(302);
    const cookie = bootstrap.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const ui = await fetch(address.url, { headers: { Cookie: cookie.split(";")[0]! } });
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("Monkey D Loopy");
    expect((await fetch(`${address.url}/../../etc/passwd`, { headers: auth })).status).toBe(404);
  });

  it("refuses non-loopback bind addresses", () => {
    expect(() => createOperatorServer({ host: "0.0.0.0", token: "x", registry: new OperatorRegistry(tmp()) })).toThrow(/loopback/);
  });

  it("requires authenticated same-origin POST and performs explicit scheduler handoff", async () => {
    const root = tmp();
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(artifact(root, true));
    const controller = new OperatorRunController({
      registry,
      runtimeOptions: () => ({ agentHarnesses: { internal: async () => ({ text: "done" }) } }),
    });
    const handle = createOperatorServer({ registry, controller, token: "test-token-0123456789", port: 0 });
    servers.push(handle);
    const address = await handle.start();
    const body = JSON.stringify({ to: "operator", actor: "browser-user", reason: "disabled host timer" });
    expect((await fetch(`${address.url}/api/v1/loops/fixture/handoff`, { method: "POST", body })).status).toBe(401);
    expect((await fetch(`${address.url}/api/v1/loops/fixture/handoff`, { method: "POST", headers: { Authorization: `Bearer ${handle.token}`, Origin: "https://evil.example", "Content-Type": "application/json" }, body })).status).toBe(403);
    const response = await fetch(`${address.url}/api/v1/loops/fixture/handoff`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.token}`, Origin: address.url, "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(registry.get("fixture")?.schedulerAuthority).toBe("operator");
    expect(handle.controller.readState().loops.fixture?.nextDueAt).toBeTypeOf("number");
    expect(readFileSync(registry.paths.audit, "utf8")).toContain('"action":"scheduler.handoff"');

    const dispatch = await fetch(`${address.url}/api/v1/loops/fixture/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.token}`, Origin: address.url, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "step", runId: "api-step", actor: "browser-user" }),
    });
    expect(dispatch.status).toBe(202);
    await vi.waitFor(() => expect(handle.controller.readState().loops.fixture?.lastOutcome).toBe("waiting"));
    expect(readFileSync(registry.paths.audit, "utf8")).toContain('"runId":"api-step"');
  });

  it("keeps evolution isolated until an authenticated decision and supports exact rollback through the API", async () => {
    const root = tmp();
    const path = artifact(root);
    const original = readFileSync(join(path, "loop.source.yaml"), "utf8");
    const candidateYaml = original.replace("prompt: finish", "prompt: finish carefully");
    const registry = new OperatorRegistry(join(root, "operator"));
    registry.install(path);
    const handle = createOperatorServer({ registry, token: "test-token-0123456789", port: 0 });
    servers.push(handle);
    const address = await handle.start();
    const headers = { Authorization: `Bearer ${handle.token}`, Origin: address.url, "Content-Type": "application/json" };

    const proposal = await fetch(`${address.url}/api/v1/loops/fixture/evolution/candidates`, {
      method: "POST", headers, body: JSON.stringify({ yaml: candidateYaml, actor: "browser-user" }),
    });
    expect(proposal.status).toBe(201);
    const proposed = (await proposal.json() as { candidate: { id: string; status: string; gates: unknown[] } }).candidate;
    expect(proposed).toMatchObject({ status: "candidate", gates: [] });
    expect(readFileSync(join(path, "loop.source.yaml"), "utf8")).toBe(original);

    const reasonless = await fetch(`${address.url}/api/v1/loops/fixture/evolution/candidates/${proposed.id}/actions`, {
      method: "POST", headers, body: JSON.stringify({ action: "activate", actor: "browser-user" }),
    });
    expect(reasonless.status).toBe(409);
    expect(readFileSync(join(path, "loop.source.yaml"), "utf8")).toBe(original);

    const revisions = await fetch(`${address.url}/api/v1/loops/fixture/evolution/candidates`, { headers: { Authorization: `Bearer ${handle.token}` } });
    expect((await revisions.json() as { candidates: Array<{ id: string }> }).candidates).toEqual([expect.objectContaining({ id: proposed.id })]);

    const activation = await fetch(`${address.url}/api/v1/loops/fixture/evolution/candidates/${proposed.id}/actions`, {
      method: "POST", headers, body: JSON.stringify({ action: "activate", actor: "browser-user", reason: "reviewed deterministic diff", waivers: [] }),
    });
    expect(activation.status).toBe(200);
    expect(readFileSync(join(path, "loop.source.yaml"), "utf8")).toBe(candidateYaml);

    const rollback = await fetch(`${address.url}/api/v1/loops/fixture/evolution/rollback`, {
      method: "POST", headers, body: JSON.stringify({ actor: "browser-user", reason: "restore known-good bytes" }),
    });
    expect(rollback.status).toBe(200);
    expect(readFileSync(join(path, "loop.source.yaml"), "utf8")).toBe(original);
    expect(readFileSync(registry.paths.audit, "utf8")).toContain('"action":"evolution.rollback"');
  });
});
