import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatComplete, createRuntime, execHttp, execShell, resolveLlm, unwrapClaudeResult, unwrapAgentText, builtinHarnesses, BUILTIN_HARNESS_NAMES, Journal, priceUsd, normalizeModel, isCostMeterable, type RuntimeConfig } from "../src/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loopy-rt-"));
}

const num = (v: unknown): number => v as number;

describe("execution", () => {
  it("runs iterations until the termination predicate holds", async () => {
    const config: RuntimeConfig = {
      spec: { id: "tick", caps: { max_iterations: 10, on_cap_exceeded: "exit-clean" }, signal: "state-predicate" },
      initialState: () => ({ n: 0 }),
      terminate: (ctx) => num(ctx.state.n) >= 3,
      iterate: async (ctx) => {
        await ctx.shell("bump");
        ctx.state.n = num(ctx.state.n) + 1;
      },
    };
    const cwd = tmp();
    const rt = createRuntime(config, { cwd, now: () => 1000, effects: { shell: async () => ({ ok: true }) as unknown } });
    const r = await rt.run();
    expect(r.status).toBe("completed");
    expect(r.state.n).toBe(3);
    expect(existsSync(join(cwd, ".loopy", "runs", "default", "events.jsonl"))).toBe(true);
    expect(existsSync(join(cwd, ".loopy", "runs", "default", "state.json"))).toBe(true);
  });
});

describe("crash-resume with idempotent effect replay", () => {
  it("resumes from the journal and does NOT re-execute completed effects", async () => {
    let shellCalls = 0;
    const shell = async () => {
      shellCalls++;
      return { ok: true } as unknown;
    };
    const config: RuntimeConfig = {
      spec: { id: "resumable", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" }, signal: "state-predicate" },
      initialState: () => ({ n: 0 }),
      terminate: (ctx) => num(ctx.state.n) >= 1,
      iterate: async (ctx) => {
        await ctx.shell("side-effect"); // seq 0 — must run exactly once across the crash
        await ctx.sleep("5m"); // seq 1 — parks (5m > maxBlockMs:0)
        ctx.state.n = num(ctx.state.n) + 1;
      },
    };
    const cwd = tmp();

    // First process: runs the shell effect, then parks on the durable sleep.
    const a = createRuntime(config, { cwd, now: () => 1000, maxBlockMs: 0, effects: { shell } });
    const r1 = await a.run();
    expect(r1.status).toBe("waiting");
    expect(r1.wakeAt).toBe(1000 + 300_000);
    expect(shellCalls).toBe(1);

    // Second process (simulated restart) after the wake time: replays the shell from
    // the journal (no re-exec), the sleep resolves, the iteration completes.
    const b = createRuntime(config, { cwd, now: () => 1000 + 300_001, maxBlockMs: 0, effects: { shell } });
    const r2 = await b.run();
    expect(r2.status).toBe("completed");
    expect(r2.state.n).toBe(1);
    expect(shellCalls).toBe(1); // <-- the side effect ran exactly once despite the restart
  });
});

describe("cap enforcement", () => {
  it("stops on max_iterations (exit-clean)", async () => {
    const config: RuntimeConfig = {
      spec: { id: "capped", caps: { max_iterations: 3, on_cap_exceeded: "exit-clean" }, signal: "state-predicate" },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        ctx.state.n = num(ctx.state.n) + 1;
      },
    };
    const r = await createRuntime(config, { cwd: tmp(), now: () => 1 }).run();
    expect(r.status).toBe("stopped");
    expect(r.reason).toBe("max_iterations");
    expect(r.state.n).toBe(3);
  });

  it("stops on a no-progress fingerprint", async () => {
    const config: RuntimeConfig = {
      spec: {
        id: "thrash",
        caps: { max_iterations: 100, no_progress: { fingerprint: "x", max_repeats: 2 }, on_cap_exceeded: "exit-clean" },
        signal: "state-predicate",
      },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      fingerprint: () => "constant", // never changes → thrash
      iterate: async () => {},
    };
    const r = await createRuntime(config, { cwd: tmp(), now: () => 1 }).run();
    expect(r.status).toBe("stopped");
    expect(r.reason).toBe("no_progress");
  });

  it("stops on a token budget (failing closed)", async () => {
    const config: RuntimeConfig = {
      spec: { id: "pricey", caps: { max_iterations: 100, budget: { tokens: 150 }, on_cap_exceeded: "fail" }, signal: "self-assess" },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        await ctx.agent({ harness: "internal", prompt: "work" });
      },
    };
    const r = await createRuntime(config, {
      cwd: tmp(),
      now: () => 1,
      agentHarnesses: { internal: async () => ({ usage: { tokens: 100 } }) },
    }).run();
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("token-budget");
  });
});

describe("durability hardening (from the M1 review)", () => {
  it("fails LOUD on an uncertain effect (crashed between begin and result)", async () => {
    const cwd = tmp();
    // hand-craft a journal with a write-ahead 'pending' shell effect and NO result.
    const j = new Journal(cwd, "default");
    j.load();
    j.append("run_start", { loopId: "u", baseState: { n: 0 } }, 1);
    j.append(
      "effect",
      { iteration: 0, seq: 0, kind: "shell", identity: JSON.stringify({ cmd: "crashy" }), status: "pending", cmd: "crashy" },
      1
    );
    const config: RuntimeConfig = {
      spec: { id: "u", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        await ctx.shell("crashy");
        ctx.state.n = 1;
      },
    };
    const r = await createRuntime(config, { cwd, now: () => 2, effects: { shell: async () => ({ ok: true }) as unknown } }).run();
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/outcome is unknown/);
  });

  it("fails LOUD on a non-deterministic replay (effect kind diverges)", async () => {
    const cwd = tmp();
    const configA: RuntimeConfig = {
      spec: { id: "nd", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        await ctx.shell("a");
        await ctx.sleep("5m"); // park, leaving iteration 0 incomplete but journaled
      },
    };
    const a = await createRuntime(configA, { cwd, now: () => 1, maxBlockMs: 0, effects: { shell: async () => ({}) as unknown } }).run();
    expect(a.status).toBe("waiting");

    // resume with a config that emits a DIFFERENT effect kind at seq 0
    const configB: RuntimeConfig = {
      ...configA,
      iterate: async (ctx) => {
        await ctx.http({ method: "GET", url: "x" });
      },
    };
    const b = await createRuntime(configB, { cwd, now: () => 2, maxBlockMs: 0, effects: { http: async () => ({}) as unknown } }).run();
    expect(b.status).toBe("failed");
    expect(b.reason).toMatch(/non-deterministic/);
  });

  it("human breakpoints fail CLOSED by default and resume on approval", async () => {
    const cwd = tmp();
    const config: RuntimeConfig = {
      spec: { id: "gate", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: (ctx) => num(ctx.state.n) >= 1,
      iterate: async (ctx) => {
        await ctx.breakpoint({ ask: "proceed?" });
        ctx.state.n = num(ctx.state.n) + 1;
      },
    };
    const paused = await createRuntime(config, { cwd, now: () => 1 }).run();
    expect(paused.status).toBe("paused");

    const approved = await createRuntime(config, { cwd, now: () => 2, autoApprove: true }).run();
    expect(approved.status).toBe("completed");
    expect(approved.state.n).toBe(1);
  });

  it("HMAC-keyed journals are tamper/key-evident (wrong key fails to load)", () => {
    const cwd = tmp();
    const a = new Journal(cwd, "default", "secret-A");
    a.load();
    a.append("run_start", { loopId: "k", baseState: { n: 0 } }, 1);
    a.append("iteration_snapshot", { iteration: 0, state: { n: 1 } }, 1);
    // same key → loads fine
    expect(new Journal(cwd, "default", "secret-A").load().length).toBe(2);
    // different key (e.g. an editor who lacks the secret) → verification throws
    expect(() => new Journal(cwd, "default", "secret-B").load()).toThrow(/corruption|mismatch/i);
  });

  it("tolerates a torn final journal line (crash mid-append)", () => {
    const cwd = tmp();
    const j = new Journal(cwd, "default");
    j.load();
    j.append("run_start", { loopId: "t", baseState: { n: 0 } }, 1);
    j.append("iteration_snapshot", { iteration: 0, state: { n: 1 } }, 1);
    appendFileSync(join(cwd, ".loopy", "runs", "default", "events.jsonl"), '{"seq":2,"type":"effe');
    const events = new Journal(cwd, "default").load();
    expect(events.length).toBe(2); // the torn tail is dropped, the valid prefix survives
  });
});

describe("effect retry (transient resilience)", () => {
  it("retries a transient effect failure and succeeds", async () => {
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return { ok: true } as unknown;
    };
    const config: RuntimeConfig = {
      spec: { id: "retry", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: (ctx) => num(ctx.state.n) >= 1,
      iterate: async (ctx) => {
        await ctx.shell("flaky");
        ctx.state.n = 1;
      },
    };
    const r = await createRuntime(config, {
      cwd: tmp(),
      now: () => 1,
      effectRetries: 3,
      delay: () => Promise.resolve(), // instant backoff
      effects: { shell: flaky },
    }).run();
    expect(r.status).toBe("completed");
    expect(attempts).toBe(3); // failed twice, succeeded on the third
  });

  it("fails after exhausting retries", async () => {
    const always = async () => {
      throw new Error("down");
    };
    const config: RuntimeConfig = {
      spec: { id: "retry-fail", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        await ctx.shell("x");
      },
    };
    const r = await createRuntime(config, {
      cwd: tmp(),
      now: () => 1,
      effectRetries: 2,
      delay: () => Promise.resolve(),
      effects: { shell: always },
    }).run();
    expect(r.status).toBe("failed");
  });
});

describe("scrubbed shell env", () => {
  it("passes effectEnv through to the shell effect", async () => {
    let seenEnv: Record<string, string> | undefined;
    const config: RuntimeConfig = {
      spec: { id: "env", caps: { max_iterations: 3, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: (ctx) => num(ctx.state.n) >= 1,
      iterate: async (ctx) => {
        await ctx.shell("echo");
        ctx.state.n = 1;
      },
    };
    await createRuntime(config, {
      cwd: tmp(),
      now: () => 1,
      effectEnv: { PATH: "/usr/bin" },
      effects: {
        shell: async (_cmd, _timeoutMs, _cwd, env) => {
          seenEnv = env;
          return {};
        },
      },
    }).run();
    expect(seenEnv).toEqual({ PATH: "/usr/bin" });
  });
});

describe("cap-breakpoint resume parity", () => {
  it("pauses on a cap-breakpoint and resumes (resetting the budget) only when approved", async () => {
    const config: RuntimeConfig = {
      spec: { id: "capbp", caps: { max_iterations: 2, on_cap_exceeded: "breakpoint" } },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        ctx.state.n = num(ctx.state.n) + 1;
      },
    };
    const cwd = tmp();
    const opts = { cwd, now: () => 1 };

    const a = await createRuntime(config, opts).run();
    expect(a.status).toBe("paused");
    expect(a.reason).toBe("max_iterations");
    expect(a.state.n).toBe(2);

    // re-run WITHOUT approval → still paused, no progress
    const b = await createRuntime(config, opts).run();
    expect(b.status).toBe("paused");
    expect(b.state.n).toBe(2);

    // resume WITH approval → budget resets, runs another window, caps again
    const c = await createRuntime(config, { ...opts, approveCaps: true }).run();
    expect(c.status).toBe("paused");
    expect(c.state.n).toBe(4);
    expect(c.iteration).toBe(4);
  });
});

describe("provider-agnostic LLM (no vendor lock)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LOOPY_LLM_API_KEY;
    delete process.env.LOOPY_LLM_BASE_URL;
    delete process.env.LOOPY_LLM_MODEL;
    delete process.env.LOOPY_LLM_HEADERS;
    delete process.env.LOOPY_LLM_STREAM;
  });

  it("resolveLlm surfaces OpenRouter attribution headers (HTTP-Referer + X-Title)", () => {
    const cfg = resolveLlm({ OPENROUTER_API_KEY: "r" });
    expect(cfg?.baseUrl).toContain("openrouter.ai");
    expect(cfg?.headers).toMatchObject({ "HTTP-Referer": expect.any(String), "X-Title": "Monkey D Loopy" });
    // a plain provider (no defaults) surfaces no headers
    expect(resolveLlm({ OPENAI_API_KEY: "o" })?.headers).toBeUndefined();
  });

  it("chatComplete merges provider defaults + LOOPY_LLM_HEADERS (authorization not overridable)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.LOOPY_LLM_HEADERS = JSON.stringify({ "X-Custom": "abc", authorization: "Bearer HACK" });
    await chatComplete(
      { baseUrl: "http://x/v1", apiKey: "real", model: "m", headers: { "HTTP-Referer": "https://app", "X-Title": "T" } },
      "s",
      "u"
    );
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("abc"); // from LOOPY_LLM_HEADERS
    expect(headers["HTTP-Referer"]).toBe("https://app"); // from provider defaults
    expect(headers.authorization).toBe("Bearer real"); // base wins; the env override is dropped
    expect(headers["content-type"]).toBe("application/json");
  });

  it("chatComplete streams SSE deltas into the full text when opts.stream is set", async () => {
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}\n\n',
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await chatComplete({ baseUrl: "http://x/v1", apiKey: "k", model: "gpt-4o-mini" }, "s", "u", { stream: true });
    expect(r.text).toBe("Hello!"); // accumulated across delta chunks
    expect(r.usage?.usd).toBeCloseTo(0.75, 6); // usage from the final chunk → priced like the non-stream path
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.stream).toBe(true);
  });

  it("chatComplete falls back to a JSON parse when a provider ignores stream:true (no SSE data: lines)", async () => {
    // res.ok, stream:true requested, but the provider/proxy replies with a normal JSON completion
    // (no `data:` lines). Must recover the real text + usage instead of silently returning empty.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: "real text" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await chatComplete({ baseUrl: "http://x/v1", apiKey: "k", model: "m" }, "s", "u", { stream: true });
    expect(r.text).toBe("real text");
    expect(r.usage).toEqual({ tokens: 5 }); // unknown model → tokens only, exactly like the non-stream path
  });

  it("buildHeaders: keyless endpoints omit Authorization (a key still wins over a LOOPY_LLM_HEADERS auth)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // 1) keyless local endpoint → NO authorization header (never a literal `Bearer ` with an empty token)
    await chatComplete({ baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3" }, "s", "u");
    let headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");

    // 2) keyless + a user-supplied non-Bearer auth via LOOPY_LLM_HEADERS → it stands alone
    process.env.LOOPY_LLM_HEADERS = JSON.stringify({ authorization: "Basic abc" });
    await chatComplete({ baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3" }, "s", "u");
    headers = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Basic abc");

    // 3) WITH a key, a LOOPY_LLM_HEADERS authorization is still NOT overridable — the base Bearer wins
    await chatComplete({ baseUrl: "http://x/v1", apiKey: "real", model: "m" }, "s", "u");
    headers = (fetchMock.mock.calls[2]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer real");
  });

  it("the llm harness streams when LOOPY_LLM_STREAM is truthy (drives chatComplete's SSE path)", async () => {
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"{\\"done\\":true}"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.LOOPY_LLM_API_KEY = "k";
    process.env.LOOPY_LLM_BASE_URL = "http://x/v1";
    process.env.LOOPY_LLM_MODEL = "gpt-4o-mini";
    process.env.LOOPY_LLM_STREAM = "1";
    const config: RuntimeConfig = {
      spec: { id: "stream-harness", caps: { max_iterations: 3, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ done: false }),
      terminate: (c) => c.state.done === true,
      iterate: async (c) => {
        const r = await c.agent({ harness: "llm", prompt: "done?" });
        c.state.done = c.jsonpath(r, "$.done");
      },
    };
    const res = await createRuntime(config, { cwd: tmp(), now: () => 1 }).run();
    expect(res.status).toBe("completed"); // streamed SSE deltas parsed back into the structured result
    expect(res.state.done).toBe(true);
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.stream).toBe(true); // the harness actually opted the request into streaming
  });

  it("resolveLlm prefers explicit LOOPY_LLM_*, else any provider key, else null", () => {
    expect(resolveLlm({ LOOPY_LLM_API_KEY: "k", LOOPY_LLM_BASE_URL: "http://x/v1/", LOOPY_LLM_MODEL: "m" })).toEqual({
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "m",
    });
    expect(resolveLlm({ OPENAI_API_KEY: "o" })).toMatchObject({ baseUrl: "https://api.openai.com/v1", apiKey: "o" });
    expect(resolveLlm({ ANTHROPIC_API_KEY: "a" })).toMatchObject({ baseUrl: "https://api.anthropic.com/v1", apiKey: "a" });
    expect(resolveLlm({ GEMINI_API_KEY: "g" })?.baseUrl).toContain("generativelanguage");
    expect(resolveLlm({})).toBeNull();
  });

  it("chatComplete posts OpenAI-compatible /chat/completions and parses the response", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), {
          status: 200,
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await chatComplete({ baseUrl: "http://x/v1", apiKey: "k", model: "m" }, "sys", "usr");
    expect(r.text).toBe("hi");
    expect(r.usage).toEqual({ tokens: 5 });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/v1/chat/completions");
  });

  it("the 'llm' agent harness runs against any OpenAI-compatible endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"done":true}' } }] }), { status: 200 }))
    );
    process.env.LOOPY_LLM_API_KEY = "k";
    process.env.LOOPY_LLM_BASE_URL = "http://x/v1";
    process.env.LOOPY_LLM_MODEL = "m";
    const config: RuntimeConfig = {
      spec: { id: "llm", caps: { max_iterations: 3, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ done: false }),
      terminate: (c) => c.state.done === true,
      iterate: async (c) => {
        const r = await c.agent({ harness: "llm", prompt: "done?" });
        c.state.done = c.jsonpath(r, "$.done");
      },
    };
    const res = await createRuntime(config, { cwd: tmp(), now: () => 1 }).run();
    expect(res.status).toBe("completed");
    expect(res.state.done).toBe(true);
  });
});

describe("effect + doctor coverage (audit wave 8)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("execHttp returns parsed JSON for a JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ state: "green" }), { status: 200 })));
    const r = await execHttp({ method: "GET", url: "http://x" });
    expect(r).toEqual({ state: "green" });
  });

  it("execHttp returns { status, raw } for a non-JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 503 })));
    const r = (await execHttp({ method: "GET", url: "http://x" })) as { status: number; raw: string };
    expect(r.status).toBe(503);
    expect(r.raw).toBe("not json");
  });

  it("execHttp envelope: JSON response → { status, ok, headers, body }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ state: "red" }), { status: 503, headers: { "content-type": "application/json" } }))
    );
    const r = (await execHttp({ method: "GET", url: "http://x", envelope: true })) as {
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      body: { state: string };
    };
    expect(r.status).toBe(503);
    expect(r.ok).toBe(false);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.body).toEqual({ state: "red" });
  });

  it("execHttp envelope: non-JSON response → body is the raw text (no { raw } wrapper)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("plain ok", { status: 200 })));
    const r = (await execHttp({ method: "GET", url: "http://x", envelope: true })) as {
      status: number;
      ok: boolean;
      body: unknown;
    };
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.body).toBe("plain ok");
  });

  it("doctor() passes for a writable run dir", async () => {
    const config: RuntimeConfig = {
      spec: { id: "doc", caps: { max_iterations: 5, budget: { tokens: 100 } }, signal: "state-predicate" },
      initialState: () => ({}),
      terminate: () => true,
      iterate: async () => {},
    };
    const ok = await createRuntime(config, { cwd: tmp() }).doctor();
    expect(ok).toBe(true);
  });
});

describe("durability fixes (audit wave 7)", () => {
  it("fails LOUD when a sleep replay slot diverges to a different kind", async () => {
    const cwd = tmp();
    const configA: RuntimeConfig = {
      spec: { id: "ndsleep", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        await ctx.agent({ harness: "internal", prompt: "x" }); // seq 0 = agent
        await ctx.sleep("5m"); // park, leaving iteration 0 journaled-but-incomplete
      },
    };
    const a = await createRuntime(configA, { cwd, now: () => 1, maxBlockMs: 0 }).run();
    expect(a.status).toBe("waiting");

    // resume with a body whose seq 0 is now a SLEEP (diverges from the journaled agent)
    const configB: RuntimeConfig = {
      ...configA,
      iterate: async (ctx) => {
        await ctx.sleep("1ms");
      },
    };
    const b = await createRuntime(configB, { cwd, now: () => 2, maxBlockMs: 0 }).run();
    expect(b.status).toBe("failed");
    expect(b.reason).toMatch(/non-deterministic/);
  });

  it("writes the real runId (not a hardcoded 'default') into meta.json", async () => {
    const cwd = tmp();
    const config: RuntimeConfig = {
      spec: { id: "rid", caps: { max_iterations: 2, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ done: false }),
      terminate: (c) => c.state.done === true,
      iterate: async (c) => {
        c.state.done = true;
      },
    };
    await createRuntime(config, { cwd, runId: "run-42", now: () => 1 }).run();
    const meta = JSON.parse(readFileSync(join(cwd, ".loopy/runs/run-42/meta.json"), "utf8"));
    expect(meta.runId).toBe("run-42");
  });

  it("detects journal truncation mid-run via the per-iteration committed count", async () => {
    const cwd = tmp();
    const config: RuntimeConfig = {
      spec: { id: "trunc", caps: { max_iterations: 100, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ n: 0 }),
      terminate: (c) => num(c.state.n) >= 5,
      iterate: async (c) => {
        c.state.n = num(c.state.n) + 1;
      },
    };
    // run a few iterations, then park via a long sleep so the run yields with a current meta.
    const driver: RuntimeConfig = {
      ...config,
      terminate: () => false,
      iterate: async (c) => {
        c.state.n = num(c.state.n) + 1;
        if (num(c.state.n) >= 3) await c.sleep("10m");
      },
    };
    const a = await createRuntime(driver, { cwd, now: () => 1, maxBlockMs: 0 }).run();
    expect(a.status).toBe("waiting"); // parked, meta.eventCount is now current

    // physically truncate the events log below the committed count
    const eventsPath = join(cwd, ".loopy/runs/default/events.jsonl");
    const lines = readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim());
    writeFileSync(eventsPath, lines.slice(0, 2).join("\n") + "\n");

    // a resume must now refuse to load a truncated journal rather than silently replay a prefix
    expect(() => createRuntime(driver, { cwd, now: () => 2, maxBlockMs: 0 })).not.toThrow();
    const resumed = createRuntime(driver, { cwd, now: () => 2, maxBlockMs: 0 });
    await expect(resumed.run()).rejects.toThrow(/truncat/i);
  });
});

describe("tool-agnostic agent harnesses (codex / opencode / gemini / cli — not claude-only)", () => {
  afterEach(() => {
    for (const k of ["LOOPY_CODEX_BIN", "LOOPY_AGENT_CMD"]) delete process.env[k];
  });

  it("ships first-class coding-agent harnesses beyond claude-code", () => {
    for (const n of ["internal", "llm", "claude-code", "codex", "opencode", "antigravity", "cursor-agent", "cli"]) {
      expect(BUILTIN_HARNESS_NAMES, n).toContain(n);
      expect(typeof builtinHarnesses[n]).toBe("function");
    }
  });

  it("unwrapAgentText: JSON object / fenced JSON → object; plain text → $.result", () => {
    expect(unwrapAgentText('{"done":true,"n":3}')).toEqual({ done: true, n: 3 });
    expect(unwrapAgentText("```json\n{\"ok\":1}\n```")).toEqual({ ok: 1 });
    expect((unwrapAgentText("all done") as { result?: string }).result).toBe("all done");
  });

  it("a named CLI harness (codex) shells out via execFile, with a per-tool binary override", async () => {
    // point the codex binary at `echo`; AGENT_CLIS.codex builds argv ["exec", prompt].
    process.env.LOOPY_CODEX_BIN = "echo";
    const r = (await builtinHarnesses["codex"]!({ harness: "codex", prompt: "do-the-thing" })) as { result?: string };
    expect(r.result).toContain("exec"); // echo printed the built argv
    expect(r.result).toContain("do-the-thing"); // ...including the prompt
  });

  it("the generic `cli` harness drives ANY agent CLI via LOOPY_AGENT_CMD", async () => {
    process.env.LOOPY_AGENT_CMD = "echo ran";
    const r = (await builtinHarnesses["cli"]!({ harness: "cli", prompt: "hello-loop" })) as { result?: string };
    expect(r.result).toContain("ran");
    expect(r.result).toContain("hello-loop");
  });

  it("the generic `cli` harness errors clearly when LOOPY_AGENT_CMD is unset", async () => {
    await expect(builtinHarnesses["cli"]!({ harness: "cli", prompt: "x" })).rejects.toThrow(/LOOPY_AGENT_CMD/);
  });
});

describe("llm harness robustness (audit wave 5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["LOOPY_LLM_API_KEY", "LOOPY_LLM_BASE_URL", "LOOPY_LLM_MODEL"]) delete process.env[k];
  });

  it("resolveLlm accepts a keyless base URL (Ollama/vLLM/LM Studio)", () => {
    expect(resolveLlm({ LOOPY_LLM_BASE_URL: "http://localhost:11434/v1", LOOPY_LLM_MODEL: "llama3" })).toEqual({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "llama3",
    });
  });

  it("chatComplete sends max_completion_tokens (not max_tokens) for reasoning models", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) => {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    await chatComplete({ baseUrl: "http://x/v1", apiKey: "k", model: "o3-mini" }, "s", "u");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined(); // reasoning models reject a non-default temperature
  });

  it("the llm harness strips ```json fences so structured save still works", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"done\":true}\n```" } }] }), { status: 200 }))
    );
    process.env.LOOPY_LLM_API_KEY = "k";
    process.env.LOOPY_LLM_BASE_URL = "http://x/v1";
    process.env.LOOPY_LLM_MODEL = "gpt-4o-mini";
    const config: RuntimeConfig = {
      spec: { id: "fence", caps: { max_iterations: 3, on_cap_exceeded: "exit-clean" } },
      initialState: () => ({ done: false }),
      terminate: (c) => c.state.done === true,
      iterate: async (c) => {
        const r = await c.agent({ harness: "llm", prompt: "done?" });
        c.state.done = c.jsonpath(r, "$.done");
      },
    };
    const res = await createRuntime(config, { cwd: tmp(), now: () => 1 }).run();
    expect(res.status).toBe("completed");
    expect(res.state.done).toBe(true);
  });
});

describe("model pricing → real $-cost metering (audit wave 2)", () => {
  afterEach(() => {
    delete process.env.LOOPY_LLM_PRICE_IN;
    delete process.env.LOOPY_LLM_PRICE_OUT;
  });

  it("normalizeModel strips provider prefixes and date suffixes", () => {
    expect(normalizeModel("openai/gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(normalizeModel("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(normalizeModel("claude-sonnet-4-6-20250930")).toBe("claude-sonnet-4-6");
  });

  it("priceUsd computes from the table, honors env overrides, returns undefined when unknown", () => {
    // gpt-4o-mini: $0.15/1M in, $0.60/1M out
    expect(priceUsd("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(priceUsd("openai/gpt-4o-mini", 0, 0)).toBe(0);
    expect(priceUsd("totally-unknown-model", 100, 100)).toBeUndefined();
    expect(priceUsd("totally-unknown-model", 1_000_000, 0, { LOOPY_LLM_PRICE_IN: "2", LOOPY_LLM_PRICE_OUT: "8" })).toBeCloseTo(2, 6);
    expect(isCostMeterable("gpt-4o")).toBe(true);
    expect(isCostMeterable("nope")).toBe(false);
  });

  it("chatComplete derives usage.usd from the model price (so the usd cap is enforceable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }), { status: 200 }))
    );
    const r = await chatComplete({ baseUrl: "http://x/v1", apiKey: "k", model: "gpt-4o-mini" }, "s", "u");
    expect(r.usage?.usd).toBeCloseTo(0.75, 6);
    vi.unstubAllGlobals();
  });

  it("the usd budget cap actually fires for the provider-agnostic llm harness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }), { status: 200 }))
    );
    process.env.LOOPY_LLM_API_KEY = "k";
    process.env.LOOPY_LLM_BASE_URL = "http://x/v1";
    process.env.LOOPY_LLM_MODEL = "gpt-4o-mini"; // $0.75 per call (1M+1M tokens)
    try {
      const config: RuntimeConfig = {
        spec: { id: "usdcap", caps: { max_iterations: 100, budget: { usd: 1.0 }, on_cap_exceeded: "fail" }, signal: "self-assess" },
        initialState: () => ({ done: false }),
        terminate: (c) => c.state.done === true,
        iterate: async (c) => {
          await c.agent({ harness: "llm", prompt: "work" });
        },
      };
      const r = await createRuntime(config, { cwd: tmp(), now: () => 1 }).run();
      expect(r.status).toBe("failed");
      expect(r.reason).toBe("usd-budget"); // $0.75 + $0.75 ≥ $1.0 → trips on the 2nd call
    } finally {
      vi.unstubAllGlobals();
      delete process.env.LOOPY_LLM_API_KEY;
      delete process.env.LOOPY_LLM_BASE_URL;
      delete process.env.LOOPY_LLM_MODEL;
    }
  });

  it("a model-supplied usage field cannot poison the budget meter", async () => {
    // model returns JSON that includes a bogus zero usage; provider reports the real usage
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"result":1,"usage":{"tokens":0,"usd":0}}' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } }), { status: 200 }))
    );
    process.env.LOOPY_LLM_API_KEY = "k";
    process.env.LOOPY_LLM_BASE_URL = "http://x/v1";
    process.env.LOOPY_LLM_MODEL = "gpt-4o-mini";
    try {
      const config: RuntimeConfig = {
        spec: { id: "poison", caps: { max_iterations: 100, budget: { usd: 1.0 }, on_cap_exceeded: "fail" }, signal: "self-assess" },
        initialState: () => ({ done: false }),
        terminate: (c) => c.state.done === true,
        iterate: async (c) => {
          await c.agent({ harness: "llm", prompt: "work" });
        },
      };
      const r = await createRuntime(config, { cwd: tmp(), now: () => 1 }).run();
      expect(r.reason).toBe("usd-budget"); // trusted usage still meters, despite the model's fake {usd:0}
    } finally {
      vi.unstubAllGlobals();
      delete process.env.LOOPY_LLM_API_KEY;
      delete process.env.LOOPY_LLM_BASE_URL;
      delete process.env.LOOPY_LLM_MODEL;
    }
  });
});

describe("budget cap-breakpoint resume (audit wave 2)", () => {
  it("a token-budget cap-breakpoint pauses, re-pauses without approval, and continues a fresh window when approved", async () => {
    const config: RuntimeConfig = {
      spec: { id: "tokcap", caps: { max_iterations: 1000, budget: { tokens: 10 }, on_cap_exceeded: "breakpoint" }, signal: "self-assess" },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        ctx.state.n = num(ctx.state.n) + 1;
        await ctx.agent({ harness: "internal", prompt: "work" });
      },
    };
    const cwd = tmp();
    // a harness reporting 5 tokens/call, so the 10-token budget trips after 2 iterations.
    const opts = { cwd, now: () => 1, agentHarnesses: { internal: async () => ({ usage: { tokens: 5 } }) } };

    const a = await createRuntime(config, opts).run();
    expect(a.status).toBe("paused");
    expect(a.reason).toBe("token-budget");
    const pausedAt = a.iteration;

    // re-run WITHOUT approval → still paused at the same point (the bug: stuck forever)
    const b = await createRuntime(config, opts).run();
    expect(b.status).toBe("paused");
    expect(b.iteration).toBe(pausedAt);

    // resume WITH approval → rebases the token meter and runs another full window before capping again
    const c = await createRuntime(config, { ...opts, approveCaps: true }).run();
    expect(c.status).toBe("paused");
    expect(c.reason).toBe("token-budget");
    expect(c.iteration).toBeGreaterThan(pausedAt); // made real progress past the gate
  });
});

describe("agent save-envelope unwrap (claude-code)", () => {
  it("unwraps JSON model output so $.field addresses it directly", () => {
    const envelope = JSON.stringify({ type: "result", result: JSON.stringify({ done: true, score: 0.9 }), usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
    const v = unwrapClaudeResult(envelope) as { done?: boolean; score?: number; usage?: { tokens?: number; usd?: number } };
    expect(v.done).toBe(true);
    expect(v.score).toBe(0.9);
    expect(v.usage).toEqual({ tokens: 15, usd: 0.01 });
  });
  it("exposes plain text output at $.result", () => {
    const envelope = JSON.stringify({ type: "result", result: "all good" });
    const v = unwrapClaudeResult(envelope) as { result?: string };
    expect(v.result).toBe("all good");
  });
  it("falls back to { result } for non-JSON stdout", () => {
    const v = unwrapClaudeResult("not json") as { result?: string };
    expect(v.result).toBe("not json");
  });
  it("trusted envelope usage overrides a model-emitted usage (no meter poisoning)", () => {
    // model output carries a bogus zero usage; the CLI envelope reports the real cost/tokens.
    const envelope = JSON.stringify({
      type: "result",
      result: JSON.stringify({ done: true, usage: { tokens: 0, usd: 0 } }),
      usage: { input_tokens: 1000, output_tokens: 500 },
      total_cost_usd: 0.42,
    });
    const v = unwrapClaudeResult(envelope) as { done?: boolean; usage?: { tokens?: number; usd?: number } };
    expect(v.done).toBe(true);
    expect(v.usage).toEqual({ tokens: 1500, usd: 0.42 }); // not the model's {0,0}
  });
});

describe("cost integrity fixes (audit 2)", () => {
  afterEach(() => {
    for (const k of ["LOOPY_LLM_PRICE_IN", "LOOPY_LLM_PRICE_OUT"]) delete process.env[k];
  });

  it("empty/blank price overrides fall through to the table, not coerced to $0", () => {
    // empty override + unknown model → unmeterable (was: $0 + falsely meterable)
    expect(priceUsd("totally-unknown", 1_000_000, 1_000_000, { LOOPY_LLM_PRICE_IN: "", LOOPY_LLM_PRICE_OUT: "  " })).toBeUndefined();
    expect(isCostMeterable("totally-unknown", { LOOPY_LLM_PRICE_IN: "", LOOPY_LLM_PRICE_OUT: "" })).toBe(false);
    // empty override + KNOWN model → still priced from the table
    expect(priceUsd("gpt-4o-mini", 1_000_000, 1_000_000, { LOOPY_LLM_PRICE_IN: "" })).toBeCloseTo(0.75, 6);
    // a real override still wins
    expect(priceUsd("totally-unknown", 1_000_000, 0, { LOOPY_LLM_PRICE_IN: "2", LOOPY_LLM_PRICE_OUT: "8" })).toBeCloseTo(2, 6);
  });

  it("a wallclock-budget cap-breakpoint resumes (rebases the wall clock)", async () => {
    let t = 0;
    const now = () => (t += 500); // 500ms per now() call → crosses a 1s budget within a couple iterations
    const config: RuntimeConfig = {
      spec: { id: "wc", caps: { max_iterations: 1000, budget: { wallclock: "1s" }, on_cap_exceeded: "breakpoint" }, signal: "self-assess" },
      initialState: () => ({ n: 0 }),
      terminate: () => false,
      iterate: async (ctx) => {
        ctx.state.n = num(ctx.state.n) + 1;
      },
    };
    const cwd = tmp();
    const a = await createRuntime(config, { cwd, now }).run();
    expect(a.status).toBe("paused");
    expect(a.reason).toBe("wallclock-budget");
    const at = a.iteration;
    // resume WITH approval → wallclockBase rebases (load() restores from the cap_cleared ts) and a
    // fresh window opens, so it makes progress before capping again.
    const c = await createRuntime(config, { cwd, now, approveCaps: true }).run();
    expect(c.status).toBe("paused");
    expect(c.reason).toBe("wallclock-budget");
    expect(c.iteration).toBeGreaterThan(at);
  });

  it("doctor advises (never asserts) on usd-budget meterability", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
    try {
      const mk = (): RuntimeConfig => ({
        spec: { id: "doc", caps: { max_iterations: 5, budget: { usd: 1 } }, signal: "state-predicate" },
        initialState: () => ({}),
        terminate: () => true,
        iterate: async () => {},
      });
      process.env.LOOPY_LLM_PRICE_IN = "1";
      process.env.LOOPY_LLM_PRICE_OUT = "1";
      await createRuntime(mk(), { cwd: tmp() }).doctor();
      delete process.env.LOOPY_LLM_PRICE_IN;
      delete process.env.LOOPY_LLM_PRICE_OUT;
      await createRuntime(mk(), { cwd: tmp() }).doctor();
    } finally {
      spy.mockRestore();
    }
    const out = logs.join("\n");
    expect(out).toContain("usd budget ($1)");
    expect(out).toContain("self-report"); // advisory wording, not a false ⚠ alarm
  });
});

describe("shell argv form (no shell)", () => {
  it("runs {command, args} via execFile", async () => {
    const r = await execShell({ command: "echo", args: ["hi"] });
    expect(r).toEqual({ stdout: "hi", code: 0 });
  });
  it("runs a string through a shell", async () => {
    const r = await execShell("echo hi");
    expect(r).toEqual({ stdout: "hi", code: 0 });
  });
  it("treats argv data literally (no shell interpretation)", async () => {
    const r = await execShell({ command: "echo", args: ["$HOME"] });
    expect(r).toEqual({ stdout: "$HOME", code: 0 }); // not expanded — no shell
  });
});

describe("breakpoint strategy (honored as metadata, not dropped)", () => {
  const stratConfig: RuntimeConfig = {
    spec: { id: "strat", caps: { max_iterations: 5, on_cap_exceeded: "exit-clean" } },
    initialState: () => ({ n: 0 }),
    terminate: (ctx) => num(ctx.state.n) >= 1,
    iterate: async (ctx) => {
      await ctx.breakpoint({ ask: "proceed?", strategy: "quorum" });
      ctx.state.n = 1;
    },
  };

  it("surfaces the strategy in the pause reason and the journaled breakpoint record", async () => {
    const cwd = tmp();
    // fail-closed → pauses; the requested strategy is visible to an approver/UI in the reason.
    const paused = await createRuntime(stratConfig, { cwd, now: () => 1 }).run();
    expect(paused.status).toBe("paused");
    expect(paused.reason).toContain("quorum");

    // approve → the journaled breakpoint effect carries the strategy (not silently dropped).
    const done = await createRuntime(stratConfig, { cwd, now: () => 2, autoApprove: true }).run();
    expect(done.status).toBe("completed");
    const events = readFileSync(join(cwd, ".loopy", "runs", "default", "events.jsonl"), "utf8");
    expect(events).toContain('"strategy":"quorum"');
  });
});

describe("single-step driving", () => {
  it("advances exactly one iteration per step()", async () => {
    const config: RuntimeConfig = {
      spec: { id: "stepper", caps: { max_iterations: 10, on_cap_exceeded: "exit-clean" }, signal: "state-predicate" },
      initialState: () => ({ n: 0 }),
      terminate: (ctx) => num(ctx.state.n) >= 2,
      iterate: async (ctx) => {
        ctx.state.n = num(ctx.state.n) + 1;
      },
    };
    const cwd = tmp();
    const opts = { cwd, now: () => 1 };
    expect((await createRuntime(config, opts).step()).state.n).toBe(1);
    expect((await createRuntime(config, opts).step()).state.n).toBe(2);
    const final = await createRuntime(config, opts).step();
    expect(final.status).toBe("completed");
  });
});
