import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecFromYaml, terminationGrounding } from "@loopyc/core";
import { scoreLoop, verifyLoop } from "@loopyc/verify";
import { OPERATOR_API_VERSION, listRuns } from "./read-model.js";
import { OperatorRegistry, type LoopRegistration } from "./registry.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/control-center");

export interface OperatorServerOptions {
  registry?: OperatorRegistry;
  host?: string;
  port?: number;
  token?: string;
  assetsDir?: string;
}

export interface OperatorServerHandle {
  server: Server;
  registry: OperatorRegistry;
  token: string;
  start(): Promise<{ host: string; port: number; url: string }>;
  stop(): Promise<void>;
}

function secureEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | undefined {
  return req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("loopy_token="))?.slice("loopy_token=".length);
}

function requestToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const header = req.headers["x-loopy-token"];
  if (typeof header === "string") return header;
  return cookieToken(req);
}

function headers(res: ServerResponse, contentType = "application/json; charset=utf-8"): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  headers(res);
  res.statusCode = status;
  res.end(`${JSON.stringify(value)}\n`);
}

function mime(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

async function loopOverview(loop: LoopRegistration): Promise<Record<string, unknown>> {
  const source = join(loop.path, "loop.source.yaml");
  let spec: Record<string, unknown> | undefined;
  let score: number | undefined;
  let grounding: string | undefined;
  if (existsSync(source)) {
    const loaded = loadSpecFromYaml(readFileSync(source, "utf8"));
    if (loaded.spec) {
      const report = await verifyLoop(loaded.spec, loaded.capsInjected ?? false);
      score = scoreLoop(loaded.spec, report).total;
      grounding = terminationGrounding(loaded.spec).class;
      spec = { signal: loaded.spec.terminate.signal, caps: loaded.spec.caps, schedule: loaded.spec.schedule };
    }
  }
  const runs = listRuns(loop.path);
  return { ...loop, score, grounding, spec, runs, source: { artifact: loop.path, spec: source } };
}

function safeAsset(assetsDir: string, pathname: string): string | undefined {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.split("/").includes("..")) return undefined;
  const full = resolve(assetsDir, relative);
  if (!full.startsWith(`${resolve(assetsDir)}/`) && full !== resolve(assetsDir)) return undefined;
  return existsSync(full) ? full : undefined;
}

async function bodyWithinLimit(req: IncomingMessage): Promise<boolean> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  return new Promise((resolveBody) => {
    let bytes = 0;
    const done = (ok: boolean) => {
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      resolveBody(ok);
    };
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.pause();
        done(false);
      }
    });
    req.on("end", () => done(true));
  });
}

export function createOperatorServer(options: OperatorServerOptions = {}): OperatorServerHandle {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error(`operator must bind to loopback; got '${host}'`);
  const port = options.port ?? 3210;
  const registry = options.registry ?? new OperatorRegistry();
  const token = options.token ?? registry.ensureToken();
  const assetsDir = options.assetsDir ?? DEFAULT_ASSETS;

  const server = createHttpServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host ?? `${host}:${port}`;
      const url = new URL(req.url ?? "/", `http://${hostHeader}`);

      const bootstrap = url.pathname === "/" && url.searchParams.has("token");
      if (bootstrap && secureEqual(url.searchParams.get("token") ?? undefined, token)) {
        headers(res);
        res.statusCode = 302;
        res.setHeader("Set-Cookie", `loopy_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader("Location", "/");
        res.end();
        return;
      }
      if (!secureEqual(requestToken(req), token)) {
        json(res, 401, { apiVersion: OPERATOR_API_VERSION, error: "authentication required" });
        return;
      }
      const origin = req.headers.origin;
      const expectedOrigin = `http://${hostHeader}`;
      if (origin && origin !== expectedOrigin) {
        json(res, 403, { apiVersion: OPERATOR_API_VERSION, error: "cross-origin request denied" });
        return;
      }
      if (!await bodyWithinLimit(req)) {
        json(res, 413, { apiVersion: OPERATOR_API_VERSION, error: "request body exceeds 65536 bytes" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { apiVersion: OPERATOR_API_VERSION, error: "method not allowed" });
        return;
      }

      if (url.pathname === "/api/v1/health") {
        json(res, 200, { apiVersion: OPERATOR_API_VERSION, ok: true, loopback: true });
        return;
      }
      if (url.pathname === "/api/v1/loops") {
        const loops = await Promise.all(registry.list().map(loopOverview));
        json(res, 200, { apiVersion: OPERATOR_API_VERSION, loops });
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/v1\/loops\/([A-Za-z0-9._-]+)\/runs(?:\/([A-Za-z0-9._-]+))?$/);
      if (runMatch) {
        const loop = registry.get(runMatch[1]!);
        if (!loop) return void json(res, 404, { apiVersion: OPERATOR_API_VERSION, error: "loop not found" });
        const runs = listRuns(loop.path);
        if (!runMatch[2]) return void json(res, 200, { apiVersion: OPERATOR_API_VERSION, runs });
        const run = runs.find((candidate) => candidate.runId === runMatch[2]);
        return void json(res, run ? 200 : 404, run ? { apiVersion: OPERATOR_API_VERSION, run } : { apiVersion: OPERATOR_API_VERSION, error: "run not found" });
      }
      if (url.pathname === "/api/v1/events") {
        headers(res, "text/event-stream; charset=utf-8");
        res.setHeader("Connection", "keep-alive");
        res.write(`event: snapshot\ndata: ${JSON.stringify({ apiVersion: OPERATOR_API_VERSION, loops: registry.list().map((loop) => ({ id: loop.id, runs: listRuns(loop.path) })) })}\n\n`);
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
        req.on("close", () => clearInterval(heartbeat));
        return;
      }
      const asset = safeAsset(assetsDir, url.pathname);
      if (asset) {
        headers(res, mime(asset));
        res.statusCode = 200;
        if (req.method === "HEAD") res.end();
        else res.end(readFileSync(asset));
        return;
      }
      json(res, 404, { apiVersion: OPERATOR_API_VERSION, error: "not found" });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { apiVersion: OPERATOR_API_VERSION, error: (error as Error).message });
      else res.destroy(error as Error);
    }
  });

  return {
    server,
    registry,
    token,
    start: () => new Promise((resolveStart, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        resolveStart({ host, port: boundPort, url: `http://${host}:${boundPort}` });
      });
    }),
    stop: () => new Promise((resolveStop, reject) => server.close((error) => error ? reject(error) : resolveStop())),
  };
}
