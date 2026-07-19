import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Journal, type JournalEvent, type RunStatus } from "@loopyc/runtime";

export const OPERATOR_API_VERSION = "1";
export const JOURNAL_SCHEMA_VERSION = 1;

export type RunIntegrity =
  | "verified"
  | "torn-tail"
  | "corrupt"
  | "truncated"
  | "locked"
  | "version-skew"
  | "missing";

export type RunHealth = "healthy" | "attention" | "error";

export interface RunTimelineItem {
  seq: number;
  ts: number;
  type: JournalEvent["type"];
  summary: string;
  data: Record<string, unknown>;
}

export interface RunReadModel {
  apiVersion: string;
  loopId?: string;
  runId: string;
  status: RunStatus | "unknown";
  health: RunHealth;
  integrity: RunIntegrity;
  integrityDetail?: string;
  iteration: number;
  state: Record<string, unknown>;
  tokens: number;
  usd: number;
  wakeAt?: number;
  pendingCap?: string;
  uncertainEffect?: { iteration: number; seq: number; kind: string; identity: string };
  stopRequest?: Record<string, unknown>;
  eventCount: number;
  updatedAt?: number;
  source: {
    events: string;
    state: string;
    meta: string;
    lock: string;
  };
  timeline: RunTimelineItem[];
}

interface RunMeta {
  schemaVersion?: number;
  runId?: string;
  loopId?: string;
  status?: RunStatus;
  iteration?: number;
  tokens?: number;
  usd?: number;
  updatedAt?: number;
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function eventSummary(event: JournalEvent): string {
  switch (event.type) {
    case "run_start": return `run started for ${String(event.data.loopId ?? "unknown loop")}`;
    case "effect": return `${String(event.data.kind ?? "effect")} ${String(event.data.status ?? "recorded")}`;
    case "iteration_snapshot": return `iteration ${String(event.data.iteration)} committed`;
    case "terminated": return "termination predicate satisfied";
    case "cap": return `${String(event.data.reason)} cap → ${String(event.data.action)}`;
    case "cap_cleared": return `${String(event.data.reason)} cap approved`;
    case "effect_recovery": return `uncertain effect ${String(event.data.action)}`;
    case "stop_requested": return "graceful stop acknowledged";
    case "stop_cleared": return "stopped run resumed";
    case "observer": return `completion observer ${String(event.data.status ?? "recorded")}`;
    case "failed": return `failed: ${String(event.data.error ?? "unknown error")}`;
    case "parked": return `sleeping until ${String(event.data.wakeAt)}`;
  }
}

function derive(events: JournalEvent[], meta: RunMeta): Omit<RunReadModel, "apiVersion" | "runId" | "health" | "integrity" | "source" | "timeline" | "eventCount"> {
  let loopId = meta.loopId;
  let status: RunReadModel["status"] = "unknown";
  let iteration = 0;
  let state: Record<string, unknown> = {};
  let tokens = 0;
  let usd = 0;
  let wakeAt: number | undefined;
  let pendingCap: string | undefined;
  let uncertainEffect: RunReadModel["uncertainEffect"];
  let stopRequest: Record<string, unknown> | undefined;

  for (const event of events) {
    if (event.type === "run_start") {
      loopId = String(event.data.loopId ?? loopId ?? "") || undefined;
      state = structuredClone((event.data.baseState ?? {}) as Record<string, unknown>);
      status = "waiting";
    } else if (event.type === "effect") {
      const usage = event.data.usage as { tokens?: number; usd?: number } | undefined;
      if (event.data.status === "done") {
        tokens += usage?.tokens ?? 0;
        usd += usage?.usd ?? 0;
        if (uncertainEffect && uncertainEffect.iteration === event.data.iteration && uncertainEffect.seq === event.data.seq) uncertainEffect = undefined;
      } else if (event.data.status === "pending") {
        uncertainEffect = {
          iteration: Number(event.data.iteration),
          seq: Number(event.data.seq),
          kind: String(event.data.kind),
          identity: String(event.data.identity),
        };
      }
    } else if (event.type === "effect_recovery") {
      uncertainEffect = undefined;
      if (event.data.action === "abort") status = "stopped";
    } else if (event.type === "iteration_snapshot") {
      iteration = Number(event.data.iteration) + 1;
      state = structuredClone((event.data.state ?? {}) as Record<string, unknown>);
      status = "waiting";
    } else if (event.type === "terminated") {
      status = "completed";
    } else if (event.type === "failed") {
      status = uncertainEffect ? "uncertain" : "failed";
    } else if (event.type === "cap") {
      pendingCap = String(event.data.reason);
      status = event.data.action === "fail" ? "failed" : event.data.action === "exit-clean" ? "stopped" : "paused";
    } else if (event.type === "cap_cleared") {
      pendingCap = undefined;
      status = "waiting";
    } else if (event.type === "stop_requested") {
      stopRequest = (event.data.request ?? {}) as Record<string, unknown>;
      status = "stopped";
    } else if (event.type === "stop_cleared") {
      stopRequest = undefined;
      status = "waiting";
    } else if (event.type === "parked") {
      wakeAt = Number(event.data.wakeAt);
      status = "waiting";
    }
  }
  if (uncertainEffect) status = "uncertain";
  if (status === "unknown" && meta.status) status = meta.status;
  return {
    loopId,
    status,
    iteration: Math.max(iteration, meta.iteration ?? 0),
    state,
    tokens: Math.max(tokens, meta.tokens ?? 0),
    usd: Math.max(usd, meta.usd ?? 0),
    wakeAt,
    pendingCap,
    uncertainEffect,
    stopRequest,
    updatedAt: meta.updatedAt ?? events.at(-1)?.ts,
  };
}

/** Read and verify a run without acquiring its lock or mutating any file. */
export function readRun(baseCwd: string, runId = "default", key?: string): RunReadModel {
  const dir = join(baseCwd, ".loopy", "runs", runId);
  const source = {
    events: join(dir, "events.jsonl"),
    state: join(dir, "state.json"),
    meta: join(dir, "meta.json"),
    lock: join(dir, "lock"),
  };
  const rawMeta = readJson(source.meta) as RunMeta | undefined;
  const meta = rawMeta ?? {};
  if (!existsSync(source.events)) {
    return {
      apiVersion: OPERATOR_API_VERSION, runId, status: "unknown", health: "error", integrity: "missing",
      integrityDetail: "events.jsonl does not exist", iteration: 0, state: {}, tokens: 0, usd: 0,
      eventCount: 0, source, timeline: [],
    };
  }

  let events: JournalEvent[] = [];
  let integrity: RunIntegrity = "verified";
  let integrityDetail: string | undefined;
  try {
    events = new Journal(baseCwd, runId, key).load();
    const raw = readFileSync(source.events, "utf8");
    if (raw.length > 0 && !raw.endsWith("\n")) {
      integrity = "torn-tail";
      integrityDetail = "the final journal line was not fully committed and was ignored";
    }
  } catch (error) {
    const message = (error as Error).message;
    integrity = message.includes("truncated") ? "truncated" : "corrupt";
    integrityDetail = message;
  }

  if (meta.schemaVersion != null && meta.schemaVersion > JOURNAL_SCHEMA_VERSION) {
    const detail = `journal schema ${meta.schemaVersion} is newer than supported ${JOURNAL_SCHEMA_VERSION}; read-only view`;
    if (integrity === "verified" || integrity === "torn-tail") {
      integrity = "version-skew";
      integrityDetail = detail;
    } else {
      integrityDetail = `${integrityDetail}; ${detail}`;
    }
  }
  if (existsSync(source.lock)) {
    const pid = Number(readFileSync(source.lock, "utf8").trim());
    if (processAlive(pid)) {
      const detail = `run lock is held by pid ${pid}`;
      if (integrity === "verified") {
        integrity = "locked";
        integrityDetail = detail;
      } else {
        integrityDetail = `${integrityDetail}; ${detail}`;
      }
    }
  }

  const derived = derive(events, meta);
  const health: RunHealth = integrity === "corrupt" || integrity === "truncated"
    ? "error"
    : integrity !== "verified" || derived.status === "uncertain" || derived.status === "failed" || derived.status === "paused"
      ? "attention"
      : "healthy";
  return {
    apiVersion: OPERATOR_API_VERSION,
    runId,
    ...derived,
    health,
    integrity,
    ...(integrityDetail ? { integrityDetail } : {}),
    eventCount: events.length,
    source,
    timeline: events.map((event) => ({ seq: event.seq, ts: event.ts, type: event.type, summary: eventSummary(event), data: event.data })),
  };
}

/** Discover all journal runs under one standalone artifact without rewriting them. */
export function listRuns(baseCwd: string, key?: string): RunReadModel[] {
  const runsDir = join(baseCwd, ".loopy", "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRun(baseCwd, entry.name, key))
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}
