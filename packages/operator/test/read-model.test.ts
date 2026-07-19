import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "@loopyc/runtime";
import { listRuns, readRun } from "../src/read-model.js";

const tmp = () => mkdtempSync(join(tmpdir(), "loopy-operator-read-"));

function completed(base: string, runId = "default", count = 1): Journal {
  const journal = new Journal(base, runId);
  journal.load();
  journal.append("run_start", { loopId: "fixture", baseState: { n: 0 } }, 1);
  for (let i = 0; i < count; i++) {
    journal.append("iteration_snapshot", { iteration: i, state: { n: i + 1 }, fp: String(i + 1) }, i + 2);
  }
  journal.append("terminated", { iteration: count }, count + 2);
  journal.append("observer", { event: "completed", status: "done" }, count + 3);
  journal.writeState({ n: count }, { schemaVersion: 1, runId, loopId: "fixture", status: "completed", iteration: count, tokens: 0, usd: 0, updatedAt: count + 2 });
  return journal;
}

describe("journal-derived operator read model", () => {
  it("matches a normal terminal runtime journal and exposes source paths", () => {
    const base = tmp();
    completed(base, "r1", 2);
    const model = readRun(base, "r1");
    expect(model).toMatchObject({ loopId: "fixture", runId: "r1", status: "completed", health: "healthy", integrity: "verified", iteration: 2, state: { n: 2 }, eventCount: 5 });
    expect(model.timeline.at(-1)?.summary).toContain("completion observer done");
    expect(model.source.events).toContain("events.jsonl");
  });

  it("marks an unresolved write-ahead effect uncertain, never healthy", () => {
    const base = tmp();
    const journal = new Journal(base, "u");
    journal.load();
    journal.append("run_start", { loopId: "fixture", baseState: {} }, 1);
    journal.append("effect", { iteration: 0, seq: 0, kind: "http", identity: "x", status: "pending" }, 2);
    journal.writeState({}, { status: "uncertain", iteration: 0 });
    expect(readRun(base, "u")).toMatchObject({ status: "uncertain", health: "attention", uncertainEffect: { kind: "http" } });
  });

  it("distinguishes torn tail, corruption, truncation, active lock, and newer schema", () => {
    const torn = tmp();
    completed(torn);
    appendFileSync(join(torn, ".loopy/runs/default/events.jsonl"), "{\"partial\":");
    expect(readRun(torn).integrity).toBe("torn-tail");

    const corrupt = tmp();
    completed(corrupt, "c", 2);
    const cPath = join(corrupt, ".loopy/runs/c/events.jsonl");
    const cLines = readFileSync(cPath, "utf8").trimEnd().split("\n");
    cLines[1] = cLines[1]!.replace('"n":1', '"n":9');
    writeFileSync(cPath, `${cLines.join("\n")}\n`);
    expect(readRun(corrupt, "c").integrity).toBe("corrupt");

    const truncated = tmp();
    completed(truncated, "t", 2);
    const tPath = join(truncated, ".loopy/runs/t/events.jsonl");
    writeFileSync(tPath, `${readFileSync(tPath, "utf8").trimEnd().split("\n").slice(0, 2).join("\n")}\n`);
    expect(readRun(truncated, "t").integrity).toBe("truncated");

    const locked = tmp();
    completed(locked, "l");
    writeFileSync(join(locked, ".loopy/runs/l/lock"), String(process.pid));
    expect(readRun(locked, "l")).toMatchObject({ integrity: "locked", health: "attention" });

    const skew = tmp();
    const journal = completed(skew, "s");
    journal.writeState({ n: 1 }, { schemaVersion: 999, status: "completed" });
    expect(readRun(skew, "s")).toMatchObject({ integrity: "version-skew", health: "attention" });
  });

  it("discovers runs deterministically and reads 100 loops / 10,000 events under two seconds", () => {
    const base = tmp();
    for (let i = 0; i < 100; i++) completed(base, `run-${String(i).padStart(3, "0")}`, 98);
    const start = performance.now();
    const runs = listRuns(base);
    const elapsed = performance.now() - start;
    expect(runs).toHaveLength(100);
    expect(runs[0]?.runId).toBe("run-000");
    expect(runs.every((run) => run.status === "completed")).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});
