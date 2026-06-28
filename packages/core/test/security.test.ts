import { describe, expect, it } from "vitest";
import { evaluate, parseExpr, parseInterpolations, planLoopExport, processRaw } from "../src/index.js";
import type { LoopSpec } from "../src/index.js";

function codes(raw: unknown): string[] {
  const r = processRaw(raw);
  if (r.parseErrors) return [`parse:${r.parseErrors.length}`];
  return r.validation!.errors.map((e) => e.code);
}

const base = {
  loopspec: "0.1",
  id: "t",
  pattern: "react",
  state: { vars: { done: { type: "boolean", init: false } } },
  body: [{ id: "w", kind: "agent", harness: "claude-code", prompt: "do", on_done: { set: { done: true } } }],
  terminate: { signal: "state-predicate", until: "${state.done == true}" },
  caps: { max_iterations: 5 },
};

describe("injection gates (names flow into generated code)", () => {
  it("rejects a loop id containing a newline", () => {
    expect(codes({ ...base, id: "t\nrequire('x')" })).toContain("bad-id");
  });

  it("rejects a step id containing a newline", () => {
    const raw = { ...base, body: [{ ...base.body[0], id: "w\n}();danger;{" }] };
    expect(codes(raw)).toContain("bad-id");
  });

  it("rejects a non-identifier state var name", () => {
    const raw = {
      ...base,
      state: { vars: { "x; danger()": { type: "boolean", init: false }, done: { type: "boolean", init: false } } },
    };
    expect(codes(raw)).toContain("bad-name");
  });

  it("rejects a non-identifier reduce alias", () => {
    const raw = {
      ...base,
      state: { vars: { done: { type: "boolean", init: false }, items: { type: "json", init: [] } } },
      body: [
        { id: "r", kind: "reduce", over: "${state.items}", as: "i of [0]) { danger() } for (const j", body: [] },
        { id: "w", kind: "agent", harness: "claude-code", prompt: "do", on_done: { set: { done: true } } },
      ],
    };
    expect(codes(raw)).toContain("bad-alias");
  });

  it("never lets a state-var name become code in generated output (bracket access)", () => {
    const r = processRaw(base);
    expect(r.validation!.ok).toBe(true);
    const plan = planLoopExport(r.spec!, "standalone");
    const loop = plan.files.find((f) => f.relativePath === "loop.mjs")!.contents;
    expect(loop).toContain('state["done"] = '); // write uses bracket + JSON-stringified key
  });
});

describe("on_done.append (map-reduce accumulation)", () => {
  it("requires the append target to be a list", () => {
    const raw = {
      ...base,
      state: { vars: { done: { type: "boolean", init: false }, acc: { type: "int", init: 0 } } },
      body: [{ id: "w", kind: "shell", cmd: ":", on_done: { append: { acc: 1 }, set: { done: true } } }],
    };
    expect(codes(raw)).toContain("bad-binding");
  });

  it("accepts append into a list var and lowers to .push()", () => {
    const raw = {
      ...base,
      state: { vars: { done: { type: "boolean", init: false }, acc: { type: "list", init: [] } } },
      body: [{ id: "w", kind: "shell", cmd: ":", on_done: { append: { acc: "x" }, set: { done: true } } }],
    };
    const r = processRaw(raw);
    expect(r.validation!.ok).toBe(true);
    const loop = planLoopExport(r.spec! as LoopSpec, "standalone").files.find((f) => f.relativePath === "loop.mjs")!.contents;
    expect(loop).toContain('state["acc"].push(');
  });
});

describe("agent steps can capture output via save", () => {
  it("lowers agent save to a captured result + extraction", () => {
    const raw = {
      ...base,
      body: [
        { id: "a", kind: "agent", harness: "claude-code", prompt: "decide", save: { done: "$.done" } },
      ],
    };
    const r = processRaw(raw);
    expect(r.validation!.ok).toBe(true);
    const loop = planLoopExport(r.spec! as LoopSpec, "standalone").files.find((f) => f.relativePath === "loop.mjs")!.contents;
    expect(loop).toContain("const __res = await ctx.agent(");
    expect(loop).toContain('state["done"] = ctx.jsonpath(__res, "$.done");');
  });
});

describe("expression engine fixes", () => {
  it("&&/|| return operands (matching generated JS), with short-circuit", () => {
    expect(evaluate(parseExpr("'a' || 'b'"), {})).toBe("a");
    expect(evaluate(parseExpr("0 || 'x'"), {})).toBe("x");
    expect(evaluate(parseExpr("'a' && 'b'"), {})).toBe("b");
    expect(evaluate(parseExpr("0 && 'b'"), {})).toBe(0);
  });

  it("decodes string escapes (\\n -> newline)", () => {
    expect(evaluate(parseExpr("'a\\nb'"), {})).toBe("a\nb");
  });

  it("does not miscount braces inside string literals", () => {
    const segs = parseInterpolations("${ inputs.x == 'a}b' }");
    expect(segs.length).toBe(1);
    expect(segs[0]!.kind).toBe("expr");
  });
});

describe("babysitter http→curl lowering is shell-safe", () => {
  it("uses POSIX single-quoting, not JSON.stringify", () => {
    const raw = {
      ...base,
      inputs: { url: { type: "string", required: true } },
      state: { vars: { done: { type: "boolean", init: false }, body: { type: "json", init: null } } },
      body: [
        { id: "f", kind: "http", request: { method: "GET", url: "${inputs.url}" }, save: { body: "$.x" } },
        { id: "w", kind: "shell", cmd: ":", on_done: { set: { done: true } } },
      ],
    };
    const r = processRaw(raw);
    expect(r.validation!.ok).toBe(true);
    const proc = planLoopExport(r.spec! as LoopSpec, "babysitter").files.find((f) => f.relativePath === "process.mjs")!.contents;
    expect(proc).toContain("function __sq(s)");
    expect(proc).toContain("__curl(");
    expect(proc).not.toContain("JSON.stringify(k + ");
  });
});
