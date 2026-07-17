import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LoopSpec } from "@loopyc/core";
import type { RunResult } from "@loopyc/runtime";
import type { ArtifactIndex } from "./artifacts.js";
import { OperatorRegistry, type LoopRegistration } from "./registry.js";

export interface NotificationDeliveryState {
  signature?: string;
  idempotencyKey?: string;
  deliveredAt?: number;
  failureStreak: number;
  suppressedUntil?: number;
  inFlight?: string;
  inFlightAt?: number;
}

export interface NotificationStateFile {
  schemaVersion: 1;
  deliveries: Record<string, NotificationDeliveryState>;
}

export interface NotificationResult {
  attempted: number;
  delivered: number;
  skipped: number;
  failed: number;
}

export interface NotificationDispatcherOptions {
  registry: OperatorRegistry;
  fetchImpl?: typeof fetch;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
  maxAttempts?: number;
  timeoutMs?: number;
  suppressAfter?: number;
  suppressionMs?: number;
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function stateKey(loopId: string, channel: string): string { return `${loopId}:${channel}`; }
function channelKey(channel: string): string { return channel.toUpperCase().replace(/[^A-Z0-9]/g, "_"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export class NotificationDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly suppressAfter: number;
  private readonly suppressionMs: number;

  constructor(readonly registry: OperatorRegistry, options: Omit<NotificationDispatcherOptions, "registry"> = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.env = options.env ?? process.env;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.suppressAfter = options.suppressAfter ?? 5;
    this.suppressionMs = options.suppressionMs ?? 15 * 60_000;
  }

  readState(): NotificationStateFile {
    if (!existsSync(this.registry.paths.notifications)) return { schemaVersion: 1, deliveries: {} };
    const parsed = JSON.parse(readFileSync(this.registry.paths.notifications, "utf8")) as NotificationStateFile;
    if (parsed.schemaVersion !== 1 || !parsed.deliveries || typeof parsed.deliveries !== "object") {
      throw new Error(`unsupported notification state schema '${String(parsed.schemaVersion)}'; explicit migration required`);
    }
    return parsed;
  }

  private reserve(key: string, signature: string, idempotencyKey: string, policy: string): "send" | "dedupe" | "suppressed" | "in-flight" {
    return this.registry.withLock(() => {
      const state = this.readState();
      const current = state.deliveries[key] ?? { failureStreak: 0 };
      const now = this.now();
      if (current.suppressedUntil && current.suppressedUntil > now) return "suppressed";
      if (current.idempotencyKey === idempotencyKey && current.deliveredAt) return "dedupe";
      if (policy === "on-change" && current.signature === signature && current.deliveredAt) return "dedupe";
      if (current.inFlight === idempotencyKey && current.inFlightAt && now - current.inFlightAt < 5 * 60_000) return "in-flight";
      state.deliveries[key] = { ...current, inFlight: idempotencyKey, inFlightAt: now };
      atomicJson(this.registry.paths.notifications, state);
      return "send";
    });
  }

  private complete(key: string, update: (current: NotificationDeliveryState) => NotificationDeliveryState): NotificationDeliveryState {
    return this.registry.withLock(() => {
      const state = this.readState();
      const next = update(state.deliveries[key] ?? { failureStreak: 0 });
      delete next.inFlight;
      delete next.inFlightAt;
      state.deliveries[key] = next;
      atomicJson(this.registry.paths.notifications, state);
      return next;
    });
  }

  async dispatch(loop: LoopRegistration, spec: LoopSpec, runId: string, result: RunResult, artifacts: ArtifactIndex): Promise<NotificationResult> {
    const output: NotificationResult = { attempted: 0, delivered: 0, skipped: 0, failed: 0 };
    const notify = spec.notify;
    if (!notify || notify.policy === "never" || notify.channels.length === 0) return output;
    if (notify.policy === "on-failure" && !["failed", "uncertain"].includes(result.status)) return output;

    const signature = hash(JSON.stringify({ status: result.status, iteration: result.iteration, state: result.state, artifacts: artifacts.files.map((file) => [file.path, file.sha256]) }));
    for (const channel of notify.channels) {
      const envKey = channelKey(channel);
      const configured = this.env[`LOOPY_NOTIFY_${envKey}_URL`];
      if (!configured) {
        output.skipped++;
        this.registry.appendAudit({ actor: "operator", surface: "scheduler", action: "notification.delivery", outcome: "rejected", loopId: loop.id, runId, specHash: loop.specHash, detail: { channel, reason: `LOOPY_NOTIFY_${envKey}_URL is not configured` } });
        continue;
      }
      let url: URL;
      try { url = new URL(configured); } catch { url = new URL("about:blank"); }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
        output.skipped++;
        this.registry.appendAudit({ actor: "operator", surface: "scheduler", action: "notification.delivery", outcome: "rejected", loopId: loop.id, runId, specHash: loop.specHash, detail: { channel, reason: "channel URL must be credential-free http(s)" } });
        continue;
      }
      const idempotencyKey = hash(`${loop.id}\n${runId}\n${channel}\n${signature}`);
      const key = stateKey(loop.id, channel);
      const reservation = this.reserve(key, signature, idempotencyKey, notify.policy);
      if (reservation !== "send") { output.skipped++; continue; }
      output.attempted++;

      const payload: Record<string, unknown> = {
        version: 1,
        loop: { id: loop.id, specHash: loop.specHash },
        run: { id: runId, status: result.status, iteration: result.iteration, reason: result.reason?.slice(0, 500) },
        artifacts: artifacts.files.slice(0, 50).map(({ path, size, mime, sha256, localUrl }) => ({ path, size, mime, sha256, localUrl })),
      };
      while (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024 && (payload.artifacts as unknown[]).length > 0) (payload.artifacts as unknown[]).pop();
      const token = this.env[`LOOPY_NOTIFY_${envKey}_TOKEN`];
      let delivered = false;
      let lastStatus: number | undefined;
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          const response = await this.fetchImpl(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
              "User-Agent": "Monkey-D-Loopy-Operator/1",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          lastStatus = response.status;
          if (response.ok) { delivered = true; break; }
          if (![408, 425, 429].includes(response.status) && response.status < 500) break;
        } catch (error) { lastError = (error as Error).message.slice(0, 300); }
        if (attempt < this.maxAttempts) await this.delay(250 * 2 ** (attempt - 1));
      }

      if (delivered) {
        output.delivered++;
        this.complete(key, () => ({ signature, idempotencyKey, deliveredAt: this.now(), failureStreak: 0 }));
        this.registry.appendAudit({ actor: "operator", surface: "scheduler", action: "notification.delivery", outcome: "completed", loopId: loop.id, runId, specHash: loop.specHash, detail: { channel, idempotencyKey, status: lastStatus } });
      } else {
        output.failed++;
        const failed = this.complete(key, (current) => {
          const failureStreak = (current.failureStreak ?? 0) + 1;
          return { ...current, failureStreak, suppressedUntil: failureStreak >= this.suppressAfter ? this.now() + this.suppressionMs : undefined };
        });
        this.registry.appendAudit({ actor: "operator", surface: "scheduler", action: "notification.delivery", outcome: "failed", loopId: loop.id, runId, specHash: loop.specHash, detail: { channel, idempotencyKey, status: lastStatus, error: lastError, failureStreak: failed.failureStreak, suppressedUntil: failed.suppressedUntil } });
      }
    }
    return output;
  }
}
