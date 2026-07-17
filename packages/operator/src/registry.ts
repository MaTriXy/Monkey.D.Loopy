import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const REGISTRY_SCHEMA_VERSION = 1;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SchedulerAuthority = "host" | "operator";
export type MissedRunPolicy = "latest" | "skip";

export interface LoopRegistration {
  id: string;
  path: string;
  target: string;
  specHash: string;
  installedAt: number;
  schedulerAuthority: SchedulerAuthority;
  concurrency: 1;
  missedRunPolicy: MissedRunPolicy;
  hostScheduleDetected: boolean;
}

export interface OperatorRegistryFile {
  schemaVersion: number;
  loops: LoopRegistration[];
}

export interface OperatorPaths {
  root: string;
  registry: string;
  config: string;
  token: string;
  pid: string;
  audit: string;
  lock: string;
  scheduler: string;
}

export interface OperatorConfigFile {
  schemaVersion: 1;
  port: number;
}

export interface OperatorAuditEvent {
  version: 1;
  ts: number;
  actor: string;
  surface: string;
  action: string;
  outcome: "accepted" | "completed" | "rejected" | "failed";
  loopId?: string;
  runId?: string;
  specHash?: string;
  detail?: Record<string, unknown>;
}

export function operatorPaths(root = process.env.LOOPY_OPERATOR_HOME ?? join(homedir(), ".loopy", "operator")): OperatorPaths {
  const absolute = resolve(root);
  return {
    root: absolute,
    registry: join(absolute, "registry.json"),
    config: join(absolute, "config.json"),
    token: join(absolute, "token"),
    pid: join(absolute, "operator.pid"),
    audit: join(absolute, "operator-events.jsonl"),
    lock: join(absolute, "registry.lock"),
    scheduler: join(absolute, "scheduler.json"),
  };
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class OperatorRegistry {
  readonly paths: OperatorPaths;

  constructor(root?: string) {
    this.paths = operatorPaths(root);
    ensurePrivateDir(this.paths.root);
  }

  load(): OperatorRegistryFile {
    if (!existsSync(this.paths.registry)) return { schemaVersion: REGISTRY_SCHEMA_VERSION, loops: [] };
    const parsed = JSON.parse(readFileSync(this.paths.registry, "utf8")) as OperatorRegistryFile;
    if (!Number.isInteger(parsed.schemaVersion)) throw new Error("operator registry has no schemaVersion");
    if (parsed.schemaVersion > REGISTRY_SCHEMA_VERSION) {
      throw new Error(`operator registry schema ${parsed.schemaVersion} is newer than supported ${REGISTRY_SCHEMA_VERSION}; refusing mutation`);
    }
    if (parsed.schemaVersion < REGISTRY_SCHEMA_VERSION) {
      throw new Error(`operator registry schema ${parsed.schemaVersion} requires explicit migration to ${REGISTRY_SCHEMA_VERSION}`);
    }
    if (!Array.isArray(parsed.loops)) throw new Error("operator registry loops must be an array");
    return parsed;
  }

  list(): LoopRegistration[] {
    return [...this.load().loops].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get(id: string): LoopRegistration | undefined {
    return this.load().loops.find((loop) => loop.id === id);
  }

  withLock<T>(operation: () => T): T {
    if (existsSync(this.paths.lock)) {
      const owner = Number(readFileSync(this.paths.lock, "utf8").trim());
      if (processAlive(owner)) throw new Error(`operator registry is locked by pid ${owner}`);
      unlinkSync(this.paths.lock);
    }
    writeFileSync(this.paths.lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
    try { return operation(); } finally { unlinkSync(this.paths.lock); }
  }

  appendAudit(event: Omit<OperatorAuditEvent, "version" | "ts"> & { ts?: number }): OperatorAuditEvent {
    const complete: OperatorAuditEvent = { version: 1, ts: event.ts ?? Date.now(), ...event };
    appendFileSync(this.paths.audit, `${JSON.stringify(complete)}\n`, { mode: 0o600 });
    chmodSync(this.paths.audit, 0o600);
    return complete;
  }

  readPort(fallback = 3210): number {
    if (!existsSync(this.paths.config)) return fallback;
    const parsed = JSON.parse(readFileSync(this.paths.config, "utf8")) as Partial<OperatorConfigFile>;
    if (parsed.schemaVersion !== 1 || !Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65535) {
      throw new Error("operator config is invalid; remove it or restore a schemaVersion 1 config with a valid port");
    }
    chmodSync(this.paths.config, 0o600);
    return parsed.port!;
  }

  writePort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid operator port '${port}'`);
    atomicJson(this.paths.config, { schemaVersion: 1, port } satisfies OperatorConfigFile);
  }

  install(artifactPath: string, options: { id?: string; schedulerAuthority?: SchedulerAuthority } = {}): LoopRegistration {
    const path = realpathSync(resolve(artifactPath));
    if (!statSync(path).isDirectory()) throw new Error("operator install requires an artifact directory");
    const lockPath = join(path, "loop.lock");
    if (!existsSync(lockPath)) throw new Error(`artifact has no loop.lock: ${lockPath}`);
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { loop_id?: string; target?: string };
    const id = options.id ?? lock.loop_id ?? basename(path);
    if (!ID_RE.test(id)) throw new Error(`invalid loop id '${id}'`);
    const sourcePath = join(path, "loop.source.yaml");
    const specHash = hashFile(existsSync(sourcePath) ? sourcePath : lockPath);
    const hostScheduleDetected = existsSync(join(path, "schedule"));
    const authority = options.schedulerAuthority ?? "host";
    if (authority === "operator" && hostScheduleDetected) {
      throw new Error("host schedule files detected; explicit scheduler handoff is required before operator scheduling can be enabled");
    }
    const registration: LoopRegistration = {
      id,
      path,
      target: lock.target ?? "unknown",
      specHash,
      installedAt: Date.now(),
      schedulerAuthority: authority,
      concurrency: 1,
      missedRunPolicy: "latest",
      hostScheduleDetected,
    };
    this.withLock(() => {
      const registry = this.load();
      const existing = registry.loops.find((loop) => loop.id === id);
      if (existing && existing.path !== path) throw new Error(`loop id '${id}' is already registered to ${existing.path}`);
      registry.loops = [...registry.loops.filter((loop) => loop.id !== id), registration]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      atomicJson(this.paths.registry, registry);
    });
    this.appendAudit({ actor: "local-user", surface: "cli", action: "loop.install", outcome: "completed", loopId: id, specHash, detail: { path, target: registration.target, schedulerAuthority: authority } });
    return registration;
  }

  handoff(id: string, to: SchedulerAuthority, input: { actor: string; surface: string; reason: string }): LoopRegistration {
    if (!input.reason?.trim()) throw new Error("scheduler handoff requires a non-empty reason");
    const updated = this.withLock(() => {
      const registry = this.load();
      const loop = registry.loops.find((candidate) => candidate.id === id);
      if (!loop) throw new Error(`loop '${id}' is not installed`);
      if (loop.schedulerAuthority === to) throw new Error(`scheduler authority for '${id}' is already '${to}'`);
      const next = { ...loop, schedulerAuthority: to };
      registry.loops = registry.loops.map((candidate) => candidate.id === id ? next : candidate);
      atomicJson(this.paths.registry, registry);
      return next;
    });
    this.appendAudit({ actor: input.actor, surface: input.surface, action: "scheduler.handoff", outcome: "completed", loopId: id, specHash: updated.specHash, detail: { to, reason: input.reason.trim(), hostScheduleDetected: updated.hostScheduleDetected } });
    return updated;
  }

  setPolicy(id: string, input: { missedRunPolicy?: MissedRunPolicy; actor: string; surface: string; reason: string }): LoopRegistration {
    if (!input.reason?.trim()) throw new Error("policy change requires a non-empty reason");
    const updated = this.withLock(() => {
      const registry = this.load();
      const loop = registry.loops.find((candidate) => candidate.id === id);
      if (!loop) throw new Error(`loop '${id}' is not installed`);
      const next = { ...loop, missedRunPolicy: input.missedRunPolicy ?? loop.missedRunPolicy, concurrency: 1 as const };
      registry.loops = registry.loops.map((candidate) => candidate.id === id ? next : candidate);
      atomicJson(this.paths.registry, registry);
      return next;
    });
    this.appendAudit({ actor: input.actor, surface: input.surface, action: "loop.policy", outcome: "completed", loopId: id, specHash: updated.specHash, detail: { missedRunPolicy: updated.missedRunPolicy, concurrency: 1, reason: input.reason.trim() } });
    return updated;
  }

  ensureToken(): string {
    if (existsSync(this.paths.token)) {
      chmodSync(this.paths.token, 0o600);
      return readFileSync(this.paths.token, "utf8").trim();
    }
    const token = randomBytes(32).toString("base64url");
    writeFileSync(this.paths.token, `${token}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(this.paths.token, 0o600);
    return token;
  }
}
