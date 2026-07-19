/**
 * Event-sourced journal: append-one-line-per-event with a chained sha256 checksum,
 * plus a derived state-cache snapshot. This is the durability spine — any run can be
 * replayed/resumed from it. By default the chained checksum is a plain sha256 — accidental
 * corruption / bit-rot and truncation are detectable (corruption-evident). Set an external
 * key via `LOOPY_JOURNAL_KEY` (or the constructor) and the chain becomes a keyed HMAC →
 * tamper-evident: an editor without the key cannot forge it, and the SAME key is required to
 * load/resume.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";

export type JournalEventType =
  | "run_start"
  | "effect"
  | "iteration_snapshot"
  | "terminated"
  | "cap"
  | "cap_cleared"
  | "effect_recovery"
  | "stop_requested"
  | "stop_cleared"
  | "observer"
  | "failed"
  | "parked";

export interface JournalEvent {
  seq: number;
  type: JournalEventType;
  /** Monotonic timestamp (ms). Recorded for observability; never used for replay logic. */
  ts: number;
  data: Record<string, unknown>;
  /** sha256 over { seq, type, data, prev } — chained to the previous event's checksum. */
  checksum: string;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? // code-unit ordering (NOT localeCompare) so checksums are locale-independent
        Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

function hashEvent(seq: number, type: string, data: unknown, prev: string, key?: string): string {
  const payload = canonical({ seq, type, data, prev });
  // With an external key → HMAC (tamper-evident). Without → chained sha256 (corruption-evident).
  return key ? createHmac("sha256", key).update(payload).digest("hex") : createHash("sha256").update(payload).digest("hex");
}

export class Journal {
  readonly dir: string;
  private readonly eventsPath: string;
  private readonly statePath: string;
  private readonly metaPath: string;
  private events: JournalEvent[] = [];
  private lastChecksum = "";
  /** External HMAC key for tamper-evidence; the SAME key is required to load/resume. */
  private readonly key?: string;

  constructor(baseCwd: string, runId: string, key?: string) {
    this.dir = join(baseCwd, ".loopy", "runs", runId);
    this.eventsPath = join(this.dir, "events.jsonl");
    this.statePath = join(this.dir, "state.json");
    this.metaPath = join(this.dir, "meta.json");
    this.key = key ?? process.env.LOOPY_JOURNAL_KEY;
  }

  exists(): boolean {
    return existsSync(this.eventsPath);
  }

  /**
   * Load and verify the chained checksums. A torn/partial LAST line (crash mid-append)
   * is tolerated — dropped as an uncommitted tail. Corruption on any earlier line, or a
   * journal shorter than the last committed meta count, throws.
   */
  load(): JournalEvent[] {
    if (!this.exists()) {
      this.events = [];
      this.lastChecksum = "";
      return [];
    }
    const lines = readFileSync(this.eventsPath, "utf8").split("\n").filter((l) => l.trim());
    const events: JournalEvent[] = [];
    let prev = "";
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      let ev: JournalEvent;
      try {
        ev = JSON.parse(lines[i]!) as JournalEvent;
      } catch (e) {
        if (isLast) break; // torn tail from a crash mid-append — drop it
        throw new Error(`journal corruption at line ${i}: ${(e as Error).message}`);
      }
      const expected = hashEvent(ev.seq, ev.type, ev.data, prev, this.key);
      if (ev.checksum !== expected) {
        if (isLast) break; // last line written but checksum incomplete — torn tail
        throw new Error(`journal corruption at seq ${ev.seq}: checksum mismatch`);
      }
      prev = ev.checksum;
      events.push(ev);
    }
    // completeness: detect truncation beyond a single torn tail using the committed count.
    const committed = this.readCommittedCount();
    if (committed != null && events.length < committed) {
      throw new Error(`journal truncated: have ${events.length} events but meta committed ${committed}`);
    }
    this.events = events;
    this.lastChecksum = prev;
    return events;
  }

  private readCommittedCount(): number | null {
    if (!existsSync(this.metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, "utf8")) as { eventCount?: number };
      return typeof meta.eventCount === "number" ? meta.eventCount : null;
    } catch {
      return null;
    }
  }

  append(type: JournalEventType, data: Record<string, unknown>, ts: number): JournalEvent {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const seq = this.events.length;
    const checksum = hashEvent(seq, type, data, this.lastChecksum, this.key);
    const ev: JournalEvent = { seq, type, ts, data, checksum };
    appendFileSync(this.eventsPath, JSON.stringify(ev) + "\n");
    this.events.push(ev);
    this.lastChecksum = checksum;
    return ev;
  }

  all(): readonly JournalEvent[] {
    return this.events;
  }

  /** Write the derived state cache + run metadata (debuggable, git-friendly). */
  writeState(state: unknown, meta: Record<string, unknown>): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    // eventCount/lastChecksum let load() detect truncation beyond a single torn tail.
    const full = { ...meta, eventCount: this.events.length, lastChecksum: this.lastChecksum };
    writeFileSync(this.metaPath, JSON.stringify(full, null, 2));
  }
}
