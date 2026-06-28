import { describe, expect, it } from "vitest";
import { detectKind, extractFactPack, inferScaffold } from "../src/index.js";

describe("FactPack extraction", () => {
  it("infers a poll-until from a bash polling script (curl + sleep + while)", () => {
    const sh = `#!/bin/bash
API_TOKEN=abc
while [ "$STATUS" != "green" ]; do
  STATUS=$(curl -s "$STATUS_URL")
  sleep 30
done
echo done`;
    expect(detectKind("watch.sh", sh)).toBe("bash");
    const fp = extractFactPack(sh, "bash");
    expect(fp.candidatePattern).toBe("poll-until");
    expect(fp.steps.some((s) => s.kind === "http")).toBe(true); // curl
    expect(fp.sleepHint).toBe("30s"); // bare seconds normalized to a valid duration
    expect(fp.terminateHint).toContain("green");
    expect(fp.inputs).toContain("STATUS_URL");
    expect(fp.secretsFlagged).toContain("API_TOKEN");
  });

  it("infers from a JS while-loop with fetch + setInterval (real AST)", () => {
    const js = `let done = false;
while (!done) {
  const r = await fetch(process.env.HEALTH_URL);
  if (r.ok) done = true;
}
setInterval(() => {}, 5000);`;
    expect(detectKind("poll.mjs", js)).toBe("js");
    const fp = extractFactPack(js, "js");
    expect(fp.steps.some((s) => s.kind === "http")).toBe(true); // fetch
    expect(fp.terminateHint).toContain("done"); // from the while condition
    expect(fp.inputs).toContain("HEALTH_URL");
    expect(fp.candidatePattern).toBe("poll-until"); // setInterval
  });

  it("reconstructs state + steps from a .loopy journal", () => {
    const events = [
      { seq: 0, type: "run_start", ts: 1, data: { loopId: "j", baseState: { n: 0, status: "pending" } }, checksum: "" },
      { seq: 1, type: "effect", ts: 1, data: { iteration: 0, seq: 0, kind: "shell", cmd: "echo hi" }, checksum: "" },
      { seq: 2, type: "effect", ts: 1, data: { iteration: 0, seq: 1, kind: "agent", harness: "claude-code" }, checksum: "" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(detectKind("events.jsonl", events)).toBe("journal");
    const fp = extractFactPack(events, "journal");
    expect(fp.state).toEqual(expect.arrayContaining(["n", "status"]));
    expect(fp.steps.some((s) => s.kind === "shell")).toBe(true);
    expect(fp.steps.some((s) => s.kind === "agent")).toBe(true);
    expect(fp.notes.join(" ")).toMatch(/termination predicate/i);
  });

  it("does not drop commands that begin with a shell keyword (find/docker/ifconfig)", () => {
    const sh = `#!/bin/bash
while true; do
  find /tmp -name '*.log'
  docker ps
  ifconfig eth0
done`;
    const fp = extractFactPack(sh, "bash");
    const details = fp.steps.map((s) => s.detail).join(" | ");
    expect(details).toContain("find /tmp");
    expect(details).toContain("docker ps");
    expect(details).toContain("ifconfig");
  });

  it("detects https.get / https.request (not just http.get)", () => {
    const js = `import https from "node:https";\nwhile (!done) { https.get(process.env.URL); }`;
    const fp = extractFactPack(js, "js");
    expect(fp.steps.some((s) => s.kind === "http")).toBe(true);
  });

  it("secret flagging avoids false positives (tokens/secretary/MAX_TOKENS) and catches real ones", () => {
    const src = `const tokens = 3; const numTokens = 5; const secretarySalary = 1; const MAX_TOKENS = 9;
const AWS_SECRET_ACCESS_KEY = "x"; const PRIVATE_KEY = "y"; const PASSPHRASE = "z"; const apiKey = "a"; const accessToken = "b";`;
    const flagged = extractFactPack(src, "js").secretsFlagged;
    expect(flagged).toEqual(expect.arrayContaining(["AWS_SECRET_ACCESS_KEY", "PRIVATE_KEY", "PASSPHRASE", "apiKey", "accessToken"]));
    expect(flagged).not.toContain("tokens");
    expect(flagged).not.toContain("numTokens");
    expect(flagged).not.toContain("secretarySalary");
    expect(flagged).not.toContain("MAX_TOKENS");
  });

  it("does not report loop counters / locals as required inputs", () => {
    const sh = `#!/bin/bash
count=0
for host in a b c; do
  curl -s "$ENDPOINT/$host"
  count=$((count+1))
done`;
    const fp = extractFactPack(sh, "bash");
    expect(fp.inputs).toContain("ENDPOINT");
    expect(fp.inputs).not.toContain("count");
    expect(fp.inputs).not.toContain("host");
  });

  it("journal: preserves http kind and tolerates a torn final line", () => {
    const lines = [
      JSON.stringify({ seq: 0, type: "run_start", ts: 1, data: { loopId: "j", baseState: { status: "pending" } } }),
      JSON.stringify({ seq: 1, type: "effect", ts: 1, data: { iteration: 0, seq: 0, kind: "http", url: "https://api/health" } }),
      '{"seq":2,"type":"effect","ts":1,"data":{"iteration":0,"seq":1,"kind":"age', // crash-truncated tail
    ].join("\n");
    const fp = extractFactPack(lines, "journal");
    expect(fp.steps.some((s) => s.kind === "http")).toBe(true); // was coerced to shell before
    expect(fp.notes.join(" ")).toMatch(/torn|truncat|unparseable/i);
  });

  it("produces a draft scaffold with the inferred pattern + a secret warning", () => {
    const sh = `API_KEY=zzz\nwhile true; do curl -s "$U"; sleep 5; done`;
    const { draftYaml, kind } = inferScaffold("poller.sh", sh);
    expect(kind).toBe("bash");
    expect(draftYaml).toContain("pattern: poll-until");
    expect(draftYaml).toContain("kind: http");
    expect(draftYaml).toContain("possible secrets");
    expect(draftYaml).toMatch(/REVIEW before use/);
  });
});
