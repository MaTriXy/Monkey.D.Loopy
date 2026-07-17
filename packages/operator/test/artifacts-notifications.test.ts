import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopSpec } from "@loopyc/core";
import type { RunResult } from "@loopyc/runtime";
import { indexArtifacts, resolveIndexedArtifact } from "../src/artifacts.js";
import { NotificationDispatcher } from "../src/notifications.js";
import { OperatorRegistry, type LoopRegistration } from "../src/registry.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "loopy-products-")); }

const loop: LoopRegistration = {
  id: "products",
  path: "/tmp/products",
  target: "standalone",
  specHash: "abc123",
  installedAt: 1,
  schedulerAuthority: "host",
  concurrency: 1,
  missedRunPolicy: "latest",
  hostScheduleDetected: false,
};

const baseSpec = {
  loopspec: "0.1",
  id: "products",
  pattern: "react",
  body: [],
  terminate: { signal: "state-predicate", until: "${true}" },
  caps: { max_iterations: 1 },
} as unknown as LoopSpec;

const result: RunResult = { status: "completed", iteration: 1, state: { done: true } };

describe("secure artifact catalog", () => {
  it("indexes only allowlisted safe files and rejects symlink, MIME, HTML, secret, and malformed JSON cases", () => {
    const root = tmp();
    mkdirSync(join(root, "reports"));
    mkdirSync(join(root, "metrics"));
    mkdirSync(join(root, "images"));
    writeFileSync(join(root, "reports", "good.md"), "# verified\n");
    writeFileSync(join(root, "reports", "active.html"), "<script>alert(1)</script>");
    writeFileSync(join(root, "metrics", "good.json"), JSON.stringify({ value: 1 }));
    writeFileSync(join(root, "metrics", "broken.json"), "{nope");
    writeFileSync(join(root, "images", "fake.png"), "not a png");
    writeFileSync(join(root, ".env.production"), "TOKEN=secret");
    const outside = join(tmp(), "outside.md");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(root, "reports", "linked.md"));

    const index = indexArtifacts(root, {
      include: ["reports/**/*", "metrics/*.json", "images/*.png", ".env*"],
      exclude: [],
      max_files: 20,
      max_bytes: 10_000,
    }, "products");
    expect(index.files.map((file) => file.path)).toEqual(["metrics/good.json", "reports/good.md"]);
    expect(index.diagnostics.join("\n")).toMatch(/malformed|signature|symlink|active-content/);
    expect(index.files.every((file) => file.localUrl.startsWith("/api/v1/loops/products/artifacts/"))).toBe(true);
    expect(resolveIndexedArtifact(root, index, "reports/good.md")?.artifact.mime).toContain("markdown");
    expect(resolveIndexedArtifact(root, index, "../outside.md")).toBeUndefined();
    expect(resolveIndexedArtifact(root, index, "reports/linked.md")).toBeUndefined();
  });

  it("enforces file and byte ceilings deterministically", () => {
    const root = tmp();
    mkdirSync(join(root, "reports"));
    writeFileSync(join(root, "reports", "a.md"), "aaaa");
    writeFileSync(join(root, "reports", "b.md"), "bbbb");
    const index = indexArtifacts(root, { include: ["reports/*.md"], max_files: 1, max_bytes: 100 }, "products");
    expect(index.files.map((file) => file.path)).toEqual(["reports/a.md"]);
    expect(index.truncated).toBe(true);
  });
});

describe("generic webhook notifications", () => {
  it("makes zero external calls with zero channels", async () => {
    const registry = new OperatorRegistry(join(tmp(), "operator"));
    const fetchImpl = vi.fn<typeof fetch>();
    const dispatcher = new NotificationDispatcher(registry, { fetchImpl });
    const output = await dispatcher.dispatch(loop, { ...baseSpec, notify: { policy: "always", channels: [] } }, "run-1", result, { files: [], totalBytes: 0, truncated: false, diagnostics: [] });
    expect(output).toEqual({ attempted: 0, delivered: 0, skipped: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries with one idempotency key, deduplicates success, and never sends artifact contents", async () => {
    const registry = new OperatorRegistry(join(tmp(), "operator"));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      return new Response(null, { status: calls.length === 1 ? 503 : 204 });
    }) as typeof fetch;
    const dispatcher = new NotificationDispatcher(registry, {
      fetchImpl,
      delay: async () => undefined,
      env: { LOOPY_NOTIFY_OPS_URL: "https://hooks.example/loopy", LOOPY_NOTIFY_OPS_TOKEN: "top-secret-token" },
    });
    const artifacts = { files: [{ path: "reports/good.md", size: 9, mime: "text/markdown; charset=utf-8", sha256: "deadbeef", modifiedAt: 1, localUrl: "/api/v1/loops/products/artifacts/reports/good.md" }], totalBytes: 9, truncated: false, diagnostics: [] };
    const spec = { ...baseSpec, notify: { policy: "on-change" as const, channels: ["ops"] } };
    await expect(dispatcher.dispatch(loop, spec, "run-1", result, artifacts)).resolves.toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get("Idempotency-Key")).toBe(new Headers(calls[1]!.init.headers).get("Idempotency-Key"));
    expect(String(calls[0]!.init.body)).not.toContain("# verified");
    await expect(dispatcher.dispatch(loop, spec, "run-1", result, artifacts)).resolves.toMatchObject({ attempted: 0, skipped: 1 });
    expect(calls).toHaveLength(2);
    expect(statSync(registry.paths.notifications).mode & 0o777).toBe(0o600);
    expect(readFileSync(registry.paths.audit, "utf8")).not.toContain("top-secret-token");
  });

  it("suppresses a repeated failure streak after the configured threshold", async () => {
    const registry = new OperatorRegistry(join(tmp(), "operator"));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
    const dispatcher = new NotificationDispatcher(registry, {
      fetchImpl,
      delay: async () => undefined,
      env: { LOOPY_NOTIFY_OPS_URL: "https://hooks.example/loopy" },
      maxAttempts: 1,
      suppressAfter: 2,
      suppressionMs: 60_000,
      now: () => 1_700_000_000_000,
    });
    const spec = { ...baseSpec, notify: { policy: "always" as const, channels: ["ops"] } };
    const empty = { files: [], totalBytes: 0, truncated: false, diagnostics: [] };
    await dispatcher.dispatch(loop, spec, "run-1", result, empty);
    await dispatcher.dispatch(loop, spec, "run-2", result, empty);
    await expect(dispatcher.dispatch(loop, spec, "run-3", result, empty)).resolves.toMatchObject({ attempted: 0, skipped: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
