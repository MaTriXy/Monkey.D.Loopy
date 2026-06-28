import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getBlueprint } from "@loopy/core";
import { createServer } from "../src/server.js";

async function connected(): Promise<Client> {
  const server = createServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function firstText(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content[0]?.text ?? "";
}

describe("loopc-mcp", () => {
  it("exposes the factory tools", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      "get_loop_schema",
      "list_blueprints",
      "new_loop",
      "validate_loop",
      "verify_loop",
      "compile_loop",
      "run_loop",
      "inspect_run",
      "infer_loop_scaffold",
    ]) {
      expect(names, n).toContain(n);
    }
  });

  it("infer_loop_scaffold drafts a spec from a bash script", async () => {
    const client = await connected();
    const sh = 'while [ "$S" != "ok" ]; do curl -s "$U"; sleep 5; done';
    const res = await client.callTool({ name: "infer_loop_scaffold", arguments: { source: sh, filename: "watch.sh" } });
    const t = firstText(res);
    expect(t).toContain("pattern: poll-until");
    expect(t).toContain("kind: http");
  });

  it("get_loop_schema returns the authoring guide", async () => {
    const client = await connected();
    const res = await client.callTool({ name: "get_loop_schema", arguments: {} });
    expect(firstText(res)).toContain("LoopSpec");
  });

  it("validate_loop accepts a blueprint and rejects an unbounded loop", async () => {
    const client = await connected();
    const ok = await client.callTool({ name: "validate_loop", arguments: { yaml: getBlueprint("poll-until")!.yaml } });
    expect(ok.isError).toBeFalsy();
    const unbounded = 'loopspec: "0.1"\nid: x\npattern: react\nbody:\n  - { id: w, kind: shell, cmd: ":" }\n';
    const bad = await client.callTool({ name: "validate_loop", arguments: { yaml: unbounded } });
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain("terminate");
  });

  it("verify_loop returns a graded scorecard", async () => {
    const client = await connected();
    const res = await client.callTool({ name: "verify_loop", arguments: { yaml: getBlueprint("map-reduce")!.yaml } });
    expect(firstText(res)).toContain("Scorecard");
  });

  it("compile_loop returns planned files inline", async () => {
    const client = await connected();
    const res = await client.callTool({ name: "compile_loop", arguments: { yaml: getBlueprint("poll-until")!.yaml, target: "standalone" } });
    expect(firstText(res)).toContain("loop.mjs");
  });

  it("compile_loop target:all emits more than one target", async () => {
    const client = await connected();
    const res = await client.callTool({ name: "compile_loop", arguments: { yaml: getBlueprint("poll-until")!.yaml, target: "all" } });
    const t = firstText(res);
    expect(t).toContain("target: standalone");
    expect(t).toContain("target: n8n");
  });

  it("inspect_run reports state + events for a freshly run loop dir", async () => {
    const client = await connected();
    const yaml =
      'loopspec: "0.1"\nid: insp\npattern: react\nstate: { vars: { done: { type: boolean, init: false } } }\n' +
      "body:\n  - { id: w, kind: shell, cmd: \":\", on_done: { set: { done: true } } }\n" +
      'terminate: { signal: state-predicate, until: "${state.done == true}" }\ncaps: { max_iterations: 3 }\n';
    const run = await client.callTool({ name: "run_loop", arguments: { yaml, confirm: true } });
    const dir = firstText(run).match(/run dir: (\S+)/)?.[1];
    expect(dir).toBeTruthy();
    const res = await client.callTool({ name: "inspect_run", arguments: { dir: dir! } });
    const t = firstText(res);
    expect(t).toMatch(/events: \d+/);
    expect(t).toContain("latest state");
  });

  it("new_loop scaffolds from a blueprint with the given id", async () => {
    const client = await connected();
    const res = await client.callTool({ name: "new_loop", arguments: { id: "my-loop", blueprint: "react" } });
    expect(firstText(res)).toContain("id: my-loop");
  });

  it("run_loop refuses to execute without confirm:true", async () => {
    const client = await connected();
    const yaml =
      'loopspec: "0.1"\nid: r\npattern: react\nstate: { vars: { done: { type: boolean, init: false } } }\n' +
      "body:\n  - { id: w, kind: shell, cmd: \":\", on_done: { set: { done: true } } }\n" +
      'terminate: { signal: state-predicate, until: "${state.done == true}" }\ncaps: { max_iterations: 3 }\n';
    const res = await client.callTool({ name: "run_loop", arguments: { yaml } });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/confirm/i);
  });

  it("run_loop runs shell with a SCRUBBED env (secrets absent, PATH present)", async () => {
    process.env.MY_SECRET = "TOPSECRET123";
    try {
      const client = await connected();
      const probe =
        "node -e 'console.log(JSON.stringify({secret: process.env.MY_SECRET || null, hasPath: !!process.env.PATH, done: true}))'";
      const yaml =
        'loopspec: "0.1"\nid: envprobe\npattern: react\n' +
        "state: { vars: { secret: { type: json, init: null }, hasPath: { type: boolean, init: false }, done: { type: boolean, init: false } } }\n" +
        `body:\n  - { id: probe, kind: shell, cmd: ${JSON.stringify(probe)}, save: { secret: "$.secret", hasPath: "$.hasPath", done: "$.done" } }\n` +
        'terminate: { signal: state-predicate, until: "${state.done == true}" }\ncaps: { max_iterations: 3 }\n';
      const res = await client.callTool({ name: "run_loop", arguments: { yaml, confirm: true } });
      const t = firstText(res);
      expect(t).not.toContain("TOPSECRET123"); // secret was scrubbed from the shell env
      expect(t).toMatch(/"hasPath": true/); // PATH survived (allowlisted)
    } finally {
      delete process.env.MY_SECRET;
    }
  });

  it("run_loop: ${env.X} interpolation no longer leaks server secrets (expr env is scrubbed too)", async () => {
    process.env.MY_SECRET = "TOPSECRET-ENVREF-123";
    try {
      const client = await connected();
      const yaml =
        'loopspec: "0.1"\nid: envref\npattern: react\n' +
        "state: { vars: { out: { type: json, init: null }, done: { type: boolean, init: false } } }\n" +
        'body:\n  - { id: probe, kind: shell, cmd: "echo LEAKED=${env.MY_SECRET}", save: { out: "$.stdout" }, on_done: { set: { done: true } } }\n' +
        'terminate: { signal: state-predicate, until: "${state.done == true}" }\ncaps: { max_iterations: 3 }\n';
      const res = await client.callTool({ name: "run_loop", arguments: { yaml, confirm: true } });
      expect(firstText(res)).not.toContain("TOPSECRET-ENVREF-123");
    } finally {
      delete process.env.MY_SECRET;
    }
  });

  it("run_loop: a caller-supplied env value IS readable via ${env.X}", async () => {
    const client = await connected();
    const yaml =
      'loopspec: "0.1"\nid: envpass\npattern: react\n' +
      "state: { vars: { out: { type: json, init: null }, done: { type: boolean, init: false } } }\n" +
      'body:\n  - { id: probe, kind: shell, cmd: "echo GOT=${env.INJECTED}", save: { out: "$.stdout" }, on_done: { set: { done: true } } }\n' +
      'terminate: { signal: state-predicate, until: "${state.done == true}" }\ncaps: { max_iterations: 3 }\n';
    const res = await client.callTool({ name: "run_loop", arguments: { yaml, confirm: true, env: { INJECTED: "abc123xyz" } } });
    expect(firstText(res)).toContain("abc123xyz");
  });
});
