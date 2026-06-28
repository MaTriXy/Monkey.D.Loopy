/**
 * Effect executors and agent-harness adapters. These are the raw side-effecting
 * operations; the runtime wraps each in the journal for idempotent replay. The inner
 * ReAct turn lives entirely inside an agent harness — the runtime never owns it.
 */
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeModel, priceUsd } from "./pricing.js";

// exec (shell) is used ONLY for `shell` steps, whose command is author-supplied and
// meant to run through a shell. Agent harnesses use execFile (no shell) to avoid
// interpolating prompts into a command string.
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface AgentRequest {
  harness: string;
  prompt: string;
  allowedTools?: string[];
}

export interface AgentResult {
  /** Structured payload the loop can extract from with `save` json-paths. */
  [key: string]: unknown;
  /** Optional usage the runtime accumulates against token/$ budgets. */
  usage?: { tokens?: number; usd?: number };
}

export type AgentHarness = (req: AgentRequest) => Promise<AgentResult>;

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Opt-in: when true, return a { status, ok, headers, body } envelope so a loop can read
   * the HTTP status of a JSON response (e.g. `save: { code: "$.status" }`). Default (false)
   * keeps the legacy shape — the bare parsed body — so existing loops are unaffected.
   */
  envelope?: boolean;
}

/**
 * Perform an HTTP request. Default: the parsed JSON body (or { status, raw } when not JSON).
 * With `envelope: true`: a { status, ok, headers, body } object — `body` is the parsed JSON
 * when the response is JSON, otherwise the raw text.
 */
export async function execHttp(req: HttpRequestSpec, timeoutMs?: number): Promise<unknown> {
  const init: RequestInit = { method: req.method, headers: req.headers };
  if (req.body !== undefined) {
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(req.url, { ...init, signal: controller.signal });
    const text = await res.text();
    let parsed: unknown;
    let isJson = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      isJson = false;
    }
    if (req.envelope) {
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, ok: res.ok, headers, body: isJson ? parsed : text };
    }
    // legacy (default) shape — unchanged: the bare parsed body, or { status, raw } when not JSON.
    return isJson ? parsed : { status: res.status, raw: text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ShellCommand = string | { command: string; args?: string[] };

/**
 * Run a shell command. A string runs through a shell; a `{command, args}` runs via
 * execFile (NO shell — safe for untrusted data). Returns parsed stdout JSON, or
 * { stdout, code } when not JSON.
 */
export async function execShell(
  cmd: ShellCommand,
  timeoutMs?: number,
  cwd?: string,
  env?: Record<string, string>
): Promise<unknown> {
  const opts = { encoding: "utf8" as const, timeout: timeoutMs ?? 0, killSignal: "SIGKILL" as const, cwd, env };
  try {
    const { stdout } =
      typeof cmd === "string"
        ? await execAsync(cmd, opts)
        : await execFileAsync(cmd.command, cmd.args ?? [], opts);
    const trimmed = stdout.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      return { stdout: trimmed, code: 0 };
    }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), code: err.code ?? 1 };
  }
}

/**
 * Unwrap the `claude -p --output-format json` envelope into the model's own result, so
 * `save` json-paths address the model output. JSON model output → that object; text → at
 * `.result`. Usage (tokens/$) is surfaced for budget metering. Exported for testing.
 */
export function unwrapClaudeResult(stdout: string): AgentResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { result: stdout.trim() };
  }
  const env = envelope as Record<string, unknown>;
  const raw = env && typeof env === "object" && "result" in env ? env.result : env;
  let value: AgentResult;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      value = parsed !== null && typeof parsed === "object" ? (parsed as AgentResult) : { result: raw };
    } catch {
      value = { result: raw };
    }
  } else if (raw && typeof raw === "object") {
    value = raw as AgentResult;
  } else {
    value = { result: raw };
  }
  // surface usage for budget metering. `usage` is metered into the budget caps, so it must come
  // ONLY from the trusted CLI envelope — never from model-emitted JSON (which could otherwise zero
  // or inflate the meter). Delete any model-supplied usage before applying the envelope's, exactly
  // as llmHarness does (was gated on `value.usage === undefined`, leaving a meter-poisoning hole).
  delete (value as Record<string, unknown>).usage;
  const u = env?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const usd = (env?.total_cost_usd ?? env?.cost_usd) as number | undefined;
  if (u || usd != null) {
    value.usage = {
      tokens: u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) : undefined,
      usd,
    };
  }
  return value;
}

/** A no-op agent harness — deterministic, for tests/CI and as a safe default. */
const internalHarness: AgentHarness = async () => ({});

/**
 * Generic unwrap for coding-agent CLIs that print the model's final answer to stdout. A JSON
 * object (optionally ```json-fenced) becomes that object so `save: { x: "$.field" }` works;
 * otherwise the plain text is available at `$.result`. (claude-code has a richer envelope with
 * usage/cost — see unwrapClaudeResult.) Exported for testing.
 */
export function unwrapAgentText(stdout: string): AgentResult {
  const t = stripFences(stdout.trim());
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AgentResult;
  } catch {
    /* not JSON — fall through to plain text */
  }
  return { result: stdout.trim() };
}

/**
 * A coding-agent CLI harness spec: the binary, how to build its argv from the step, and how to
 * unwrap its stdout. This is the seam that keeps the agent layer TOOL-AGNOSTIC — Claude Code is
 * just one entry; Codex, opencode, Antigravity, Cursor (and anything via the generic `cli` harness) are peers,
 * never a lock to a single vendor.
 */
interface AgentCli {
  bin: string;
  buildArgs: (req: AgentRequest) => string[];
  unwrap: (stdout: string) => AgentResult;
}

/**
 * Built-in coding-agent CLIs — the 2026 top tier: Claude Code, OpenAI Codex, Antigravity (Google's
 * successor to the retired Gemini CLI), Cursor, and OpenCode. Each runs headless via execFile (no
 * shell). The argv are the verified non-interactive forms (checked against each CLI's `--help`,
 * except antigravity which follows its published docs). Because a loop harness is UNATTENDED, CLIs
 * that would otherwise stop for an approval prompt run in auto-approve mode (antigravity --yes,
 * cursor-agent --force) so a loop step can't hang — deliberate human gates belong in the spec as
 * `breakpoint`/`gates`, not accidental CLI prompts. For different flags, point a binary elsewhere
 * with LOOPY_<NAME>_BIN, or use the generic `cli` harness (LOOPY_AGENT_CMD) which runs your exact command.
 */
const AGENT_CLIS: Record<string, AgentCli> = {
  // Claude Code — `claude -p --output-format json`; the envelope carries usage + total_cost_usd.
  "claude-code": {
    bin: "claude",
    buildArgs: (req) => [
      "-p",
      req.prompt,
      "--output-format",
      "json",
      ...(req.allowedTools?.length ? ["--allowedTools", req.allowedTools.join(",")] : []),
    ],
    unwrap: unwrapClaudeResult,
  },
  // OpenAI Codex CLI — `codex exec` is the non-interactive subcommand; --skip-git-repo-check so it
  // doesn't refuse to run outside a git repo (a loop's run dir often isn't one).
  codex: { bin: "codex", buildArgs: (req) => ["exec", "--skip-git-repo-check", req.prompt], unwrap: unwrapAgentText },
  // opencode — `opencode run <message>` is the non-interactive form.
  opencode: { bin: "opencode", buildArgs: (req) => ["run", req.prompt], unwrap: unwrapAgentText },
  // Antigravity CLI (`agy`) — Google's successor to the retired Gemini CLI. `-p` is the
  // non-interactive prompt; --yes auto-approves so a headless step can't hang. (Per the published
  // Antigravity CLI docs; override the binary with LOOPY_ANTIGRAVITY_BIN if it differs.)
  antigravity: { bin: "agy", buildArgs: (req) => ["-p", req.prompt, "--yes"], unwrap: unwrapAgentText },
  // Cursor Agent — `-p/--print` is the non-interactive/script mode; --force auto-allows commands.
  "cursor-agent": { bin: "cursor-agent", buildArgs: (req) => ["-p", "--force", req.prompt], unwrap: unwrapAgentText },
};

const EXEC_OPTS = { encoding: "utf8" as const, maxBuffer: 1024 * 1024 * 16, timeout: 600_000, killSignal: "SIGKILL" as const };

/** Build an AgentHarness that shells out to a coding-agent CLI via execFile (no shell). */
function makeCliHarness(name: string, cli: AgentCli): AgentHarness {
  const envBin = `LOOPY_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;
  return async (req) => {
    const bin = (process.env[envBin] || cli.bin).trim();
    try {
      const { stdout } = await execFileAsync(bin, cli.buildArgs(req), EXEC_OPTS);
      return cli.unwrap(stdout);
    } catch (e) {
      throw new Error(`agent harness '${name}' failed (is the '${bin}' CLI installed and authenticated?): ${(e as Error).message}`);
    }
  };
}

/**
 * Generic agent-CLI harness: drive ANY coding agent via LOOPY_AGENT_CMD (e.g. "codex exec",
 * "opencode run", "agy -p", "aider --message", "amp -x"). The command is split on whitespace
 * into bin + base args; the prompt is appended as ONE final argument via execFile — never
 * shell-interpolated, so a prompt can't inject shell. The escape hatch for full tool-agnosticism.
 */
const genericCliHarness: AgentHarness = async (req) => {
  const cmd = (process.env.LOOPY_AGENT_CMD ?? "").trim();
  if (!cmd) {
    throw new Error(
      "agent harness 'cli' needs LOOPY_AGENT_CMD set (e.g. 'codex exec', 'opencode run', 'agy -p' (antigravity), 'aider --message') — the prompt is appended as the final argument."
    );
  }
  const [bin, ...baseArgs] = cmd.split(/\s+/);
  try {
    const { stdout } = await execFileAsync(bin!, [...baseArgs, req.prompt], EXEC_OPTS);
    return unwrapAgentText(stdout);
  } catch (e) {
    throw new Error(`agent harness 'cli' (LOOPY_AGENT_CMD='${cmd}') failed: ${(e as Error).message}`);
  }
};

// ---------------------------------------------------------------------------
// Provider-agnostic LLM client (OpenAI-compatible — the format every provider,
// gateway, and local runtime speaks). NO vendor lock: configured by neutral env,
// auto-detecting whichever provider key you already have.
// ---------------------------------------------------------------------------

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Provider-default request headers (e.g. OpenRouter attribution). Merged below the base
   *  content-type/authorization in chatComplete; never overrides authorization. */
  headers?: Record<string, string>;
}

/** Known providers, each exposing an OpenAI-compatible /chat/completions endpoint. */
const LLM_PROVIDERS: { env: string; baseUrl: string; defaultModel: string; headers?: Record<string, string> }[] = [
  { env: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { env: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-6" },
  { env: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash" },
  { env: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
  {
    env: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    // Recommended by OpenRouter for app attribution / leaderboard ranking. Harmless elsewhere.
    headers: { "HTTP-Referer": "https://github.com/MaTriXy/monkey-d-loopy", "X-Title": "Monkey D Loopy" },
  },
  { env: "AI_GATEWAY_API_KEY", baseUrl: "https://ai-gateway.vercel.sh/v1", defaultModel: "openai/gpt-4o-mini" },
];

/**
 * Resolve an LLM from env, provider-neutral. Precedence: explicit LOOPY_LLM_* first, then any
 * recognized provider key. Override base/model anytime — point it at OpenAI, Anthropic, Gemini,
 * Groq, OpenRouter, the Vercel AI Gateway, Ollama/vLLM/LM Studio, or any OpenAI-compatible URL.
 */
export function resolveLlm(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const key = env.LOOPY_LLM_API_KEY;
  const base = env.LOOPY_LLM_BASE_URL;
  const model = env.LOOPY_LLM_MODEL;
  // explicit config: an API key OR a base URL. A bare base URL (no key) is the keyless local
  // case — Ollama / vLLM / LM Studio need no auth; Bearer with an empty token is ignored.
  if (key || base) {
    return { baseUrl: (base ?? "https://api.openai.com/v1").replace(/\/+$/, ""), apiKey: key ?? "", model: model ?? "gpt-4o-mini" };
  }
  for (const p of LLM_PROVIDERS) {
    const k = env[p.env];
    if (k) {
      return {
        baseUrl: (base ?? p.baseUrl).replace(/\/+$/, ""),
        apiKey: k,
        model: model ?? p.defaultModel,
        ...(p.headers ? { headers: { ...p.headers } } : {}),
      };
    }
  }
  return null;
}

/** Parse the LOOPY_LLM_HEADERS env (a JSON object of header→value) merged into every request. */
function parseEnvHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env.LOOPY_LLM_HEADERS;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (v != null) out[k] = String(v);
      return out;
    }
  } catch {
    /* malformed LOOPY_LLM_HEADERS is ignored rather than crashing the request */
  }
  return {};
}

/**
 * Merge request headers with strict precedence: provider defaults < LOOPY_LLM_HEADERS < the base
 * content-type/authorization. Authorization (and content-type) are owned by the base and cannot be
 * overridden by a provider/env header — so a stray `authorization` in LOOPY_LLM_HEADERS is dropped.
 *
 * Exception: a keyless local endpoint (apiKey "" — Ollama/vLLM/LM Studio, or any non-Bearer scheme
 * supplied via LOOPY_LLM_HEADERS) gets NO base `authorization` header at all, so we never send a
 * literal `Authorization: Bearer ` (empty token) that strict servers reject, and a user-supplied
 * authorization in LOOPY_LLM_HEADERS is left to stand alone.
 */
function buildHeaders(cfg: LlmConfig, env: Record<string, string | undefined>): Record<string, string> {
  const hasKey = cfg.apiKey.trim() !== "";
  const extra = { ...(cfg.headers ?? {}), ...parseEnvHeaders(env) };
  for (const k of Object.keys(extra)) {
    // content-type is always base-owned; authorization is base-owned ONLY when we have a key.
    if (/^content-type$/i.test(k) || (hasKey && /^authorization$/i.test(k))) delete extra[k];
  }
  return {
    ...extra,
    "content-type": "application/json",
    ...(hasKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

/** OpenAI reasoning models (o1/o3/o4/gpt-5 families) reject `max_tokens` + a non-default
 *  `temperature`; they use `max_completion_tokens` instead. */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(normalizeModel(model));
}

type LlmUsage = { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined;

/** Shape of a normal (non-streaming) OpenAI-compatible completion body — also the body a provider
 *  returns when it ignores `stream:true`, so both the non-stream and stream-fallback paths parse it. */
type CompletionJson = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/** Parse a non-streaming completion body into the runtime's metered { text, usage } result. */
function parseCompletion(cfg: LlmConfig, json: CompletionJson): { text: string; usage?: { tokens?: number; usd?: number } } {
  return toResult(cfg, String(json.choices?.[0]?.message?.content ?? ""), json.usage);
}

/** Shape the provider usage into the runtime's metered { tokens, usd } the same way for both paths. */
function toResult(cfg: LlmConfig, text: string, u: LlmUsage): { text: string; usage?: { tokens?: number; usd?: number } } {
  if (!u) return { text };
  const promptT = u.prompt_tokens ?? 0;
  const completionT = u.completion_tokens ?? 0;
  // prefer a provider-reported cost (e.g. OpenRouter usage.cost); else derive from the price table
  // so the usd budget cap is enforceable for ANY OpenAI-compatible provider, not just claude-code.
  const usd = typeof u.cost === "number" ? u.cost : priceUsd(cfg.model, promptT, completionT);
  return { text, usage: { tokens: promptT + completionT, ...(usd !== undefined ? { usd } : {}) } };
}

/**
 * Consume an SSE stream: accumulate `choices[0].delta.content`; keep the last `usage` chunk. Also
 * returns the raw body and whether any `data:` lines were seen, so chatComplete can fall back to a
 * non-streaming parse when a provider/proxy ignores `stream:true` and replies with a plain JSON body.
 */
async function readSseStream(res: Response): Promise<{ text: string; usage: LlmUsage; sawData: boolean; raw: string }> {
  // `res.body` is null for a bodyless response (e.g. 204) — guard rather than NPE on a non-null `!`.
  if (!res.body) throw new Error("LLM stream response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let text = "";
  let usage: LlmUsage;
  let sawData = false;
  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    sawData = true;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
      if (chunk.usage) usage = chunk.usage;
    } catch {
      /* ignore non-JSON keepalive/comment lines */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const slice = typeof value === "string" ? value : decoder.decode(value, { stream: true });
    raw += slice;
    buffer += slice;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      consume(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer) consume(buffer); // flush any trailing line without a newline
  return { text, usage, sawData, raw };
}

/**
 * One OpenAI-compatible chat completion. Returns the text + usage (provider-agnostic).
 * Opt into Server-Sent-Events streaming with `opts.stream` — the accumulated text and usage are
 * identical in shape to the non-streaming path.
 */
export async function chatComplete(
  cfg: LlmConfig,
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number; stream?: boolean }
): Promise<{ text: string; usage?: { tokens?: number; usd?: number } }> {
  const maxTokens = opts?.maxTokens ?? 2000;
  const reasoning = isReasoningModel(cfg.model);
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(reasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens, temperature: opts?.temperature ?? 0 }),
    // request usage on the final SSE chunk so the $ budget cap stays enforceable while streaming.
    ...(opts?.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  // bound the request so a hung connection can't stall the durable loop forever (the runtime's
  // effectTimeoutMs only covers http/shell, not the agent harness). The timeout spans the full
  // body read (incl. the stream) so a slow trickle still aborts.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(cfg, process.env),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    if (opts?.stream) {
      const streamed = await readSseStream(res);
      if (streamed.sawData) return toResult(cfg, streamed.text, streamed.usage);
      // A provider/proxy that doesn't support streaming ignores `stream:true` and returns a normal
      // JSON completion (no SSE `data:` lines). Parse the accumulated body like the non-stream path
      // so the text + usage aren't silently dropped (was: { text: "", usage: undefined }).
      return parseCompletion(cfg, JSON.parse(streamed.raw) as CompletionJson);
    }
    return parseCompletion(cfg, (await res.json()) as CompletionJson);
  } finally {
    clearTimeout(timer);
  }
}

/** Strip a leading ```json / ``` fence (and trailing ```), a near-universal model habit. */
function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json|ya?ml)?\s*\n?([\s\S]*?)\n?```$/i);
  return m ? m[1]!.trim() : t;
}

/** Provider-agnostic agent harness: one OpenAI-compatible completion per step. */
const llmHarness: AgentHarness = async (req) => {
  const cfg = resolveLlm();
  if (!cfg) {
    throw new Error(
      "agent harness 'llm' needs an LLM configured — set LOOPY_LLM_API_KEY (+ LOOPY_LLM_BASE_URL, LOOPY_LLM_MODEL) or any provider key (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY)."
    );
  }
  // Opt-in streaming: set LOOPY_LLM_STREAM truthy so a compiled loop streams the completion. NOTE:
  // budget metering while streaming relies on the provider honoring stream_options.include_usage
  // (chatComplete requests it) — providers that omit the final usage chunk leave the call unmetered.
  const stream = /^(1|true|yes|on)$/i.test((process.env.LOOPY_LLM_STREAM ?? "").trim());
  const { text, usage } = await chatComplete(
    cfg,
    "You are executing one step of an agent loop. If the step needs a structured result, reply with a single JSON object; otherwise reply with plain text.",
    req.prompt,
    stream ? { stream: true } : undefined
  );
  let value: AgentResult;
  try {
    // models very often wrap JSON in ```json fences; strip them so `save: { x: "$.field" }` works.
    const parsed = JSON.parse(stripFences(text));
    value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AgentResult) : { result: text };
  } catch {
    value = { result: text };
  }
  // `usage` is metered into the budget caps, so it must come ONLY from the trusted provider —
  // never from model-emitted JSON (which could otherwise zero or inflate the meter).
  delete (value as Record<string, unknown>).usage;
  if (usage) value.usage = usage;
  return value;
};

export const builtinHarnesses: Record<string, AgentHarness> = {
  internal: internalHarness, // no-op (deterministic; for tests/CI)
  llm: llmHarness, // provider-agnostic OpenAI-compatible client; configure via env
  // Coding-agent CLIs — first-class peers, NOT claude-only (claude-code / codex / opencode / antigravity / cursor-agent).
  ...Object.fromEntries(Object.entries(AGENT_CLIS).map(([name, cli]) => [name, makeCliHarness(name, cli)])),
  cli: genericCliHarness, // drive ANY agent CLI via LOOPY_AGENT_CMD (the universal escape hatch)
};

/** Names of the built-in agent harnesses (for docs / introspection). */
export const BUILTIN_HARNESS_NAMES = Object.keys(builtinHarnesses);
