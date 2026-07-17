import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "@loopyc/runtime";
import { OperatorRegistry } from "../src/registry.js";
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
observe: { trace: journal }
`;
  writeFileSync(join(path, "loop.source.yaml"), yaml);
  writeFileSync(join(path, "loop.lock"), JSON.stringify({ loop_id: "fixture", target: "standalone" }));
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
});
