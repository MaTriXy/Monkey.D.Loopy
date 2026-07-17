import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecFromYaml, terminationGrounding, type LoopSpec } from "@loopyc/core";
import { scoreLoop, verifyLoop } from "@loopyc/verify";
import { OPERATOR_API_VERSION, listRuns } from "./read-model.js";
import { OperatorRegistry, type LoopRegistration } from "./registry.js";
import { OperatorRunController, OperatorScheduler } from "./controller.js";
import { indexArtifacts, readIndexedArtifact, type ArtifactIndex } from "./artifacts.js";
import { NotificationDispatcher } from "./notifications.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/control-center");

export interface OperatorServerOptions {
  registry?: OperatorRegistry;
  host?: string;
  port?: number;
  token?: string;
  assetsDir?: string;
  controller?: OperatorRunController;
  scheduler?: OperatorScheduler;
  notifier?: NotificationDispatcher;
}

export interface OperatorServerHandle {
  server: Server;
  registry: OperatorRegistry;
  controller: OperatorRunController;
  scheduler: OperatorScheduler;
  notifier: NotificationDispatcher;
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

async function loopOverview(loop: LoopRegistration, controller: OperatorRunController, artifactCache: Map<string, { key: string; index: ArtifactIndex }>): Promise<Record<string, unknown>> {
  const source = join(loop.path, "loop.source.yaml");
  let spec: Record<string, unknown> | undefined;
  let score: number | undefined;
  let grounding: string | undefined;
  let loadedSpec: LoopSpec | undefined;
  let artifacts: ArtifactIndex = { files: [], totalBytes: 0, truncated: false, diagnostics: [] };
  if (existsSync(source)) {
    const loaded = loadSpecFromYaml(readFileSync(source, "utf8"));
    if (loaded.spec) {
      const report = await verifyLoop(loaded.spec, loaded.capsInjected ?? false);
      score = scoreLoop(loaded.spec, report).total;
      grounding = terminationGrounding(loaded.spec).class;
      loadedSpec = loaded.spec;
      spec = { signal: loaded.spec.terminate.signal, caps: loaded.spec.caps, schedule: loaded.spec.schedule };
    }
  }
  const runs = listRuns(loop.path);
  const cacheKey = `${loop.specHash}:${Math.max(0, ...runs.map((run) => run.updatedAt ?? 0))}`;
  const cached = artifactCache.get(loop.id);
  if (cached?.key === cacheKey) artifacts = cached.index;
  else if (loadedSpec) {
    try { artifacts = indexArtifacts(loop.path, loadedSpec.artifacts, loop.id); }
    catch (error) { artifacts = { files: [], totalBytes: 0, truncated: false, diagnostics: [`index failed without affecting the run: ${(error as Error).message}`] }; }
    artifactCache.set(loop.id, { key: cacheKey, index: artifacts });
  }
  return { ...loop, score, grounding, spec, runs, artifacts, operation: controller.readState().loops[loop.id] ?? {}, source: { artifact: loop.path, spec: source } };
}

function safeAsset(assetsDir: string, pathname: string): string | undefined {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.split("/").includes("..")) return undefined;
  const full = resolve(assetsDir, relative);
  if (!full.startsWith(`${resolve(assetsDir)}/`) && full !== resolve(assetsDir)) return undefined;
  return existsSync(full) ? full : undefined;
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; body: Buffer } | { ok: false }> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false };
  if (req.method === "GET" || req.method === "HEAD") return { ok: true, body: Buffer.alloc(0) };
  return new Promise((resolveBody) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const done = (result: { ok: true; body: Buffer } | { ok: false }) => {
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      resolveBody(result);
    };
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.pause();
        done({ ok: false });
      } else chunks.push(chunk);
    });
    req.on("end", () => done({ ok: true, body: Buffer.concat(chunks) }));
  });
}

function jsonBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  const value = JSON.parse(body.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value as Record<string, unknown>;
}

export function createOperatorServer(options: OperatorServerOptions = {}): OperatorServerHandle {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error(`operator must bind to loopback; got '${host}'`);
  const port = options.port ?? 3210;
  const registry = options.registry ?? new OperatorRegistry();
  const artifactCache = new Map<string, { key: string; index: ArtifactIndex }>();
  const notifier = options.notifier ?? new NotificationDispatcher(registry);
  const controller = options.controller ?? new OperatorRunController({
    registry,
    onResult: async (loop, spec, runId, result) => {
      artifactCache.delete(loop.id);
      let artifacts: ArtifactIndex;
      try { artifacts = indexArtifacts(loop.path, spec.artifacts, loop.id); }
      catch (error) {
        registry.appendAudit({ actor: "operator", surface: "scheduler", action: "artifact.index", outcome: "failed", loopId: loop.id, runId, specHash: loop.specHash, detail: { error: (error as Error).message } });
        artifacts = { files: [], totalBytes: 0, truncated: false, diagnostics: [(error as Error).message] };
      }
      await notifier.dispatch(loop, spec, runId, result, artifacts);
    },
  });
  const scheduler = options.scheduler ?? new OperatorScheduler(controller);
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
      const received = await readBody(req);
      if (!received.ok) {
        json(res, 413, { apiVersion: OPERATOR_API_VERSION, error: "request body exceeds 65536 bytes" });
        return;
      }

      if (req.method === "POST") {
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          return void json(res, 415, { apiVersion: OPERATOR_API_VERSION, error: "POST requires application/json" });
        }
        let body: Record<string, unknown>;
        try { body = jsonBody(received.body); }
        catch (error) { return void json(res, 400, { apiVersion: OPERATOR_API_VERSION, error: (error as Error).message }); }
        const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "local-user";
        const handoff = url.pathname.match(/^\/api\/v1\/loops\/([A-Za-z0-9._-]+)\/handoff$/);
        if (handoff) {
          const to = body.to === "host" || body.to === "operator" ? body.to : undefined;
          if (!to) return void json(res, 400, { apiVersion: OPERATOR_API_VERSION, error: "handoff requires to=host|operator" });
          const reason = typeof body.reason === "string" ? body.reason : "";
          if (to === "operator") {
            scheduler.enable(handoff[1]!);
            try { registry.handoff(handoff[1]!, to, { actor, surface: "api", reason }); }
            catch (error) { scheduler.disable(handoff[1]!); throw error; }
          } else {
            scheduler.disable(handoff[1]!);
            try { registry.handoff(handoff[1]!, to, { actor, surface: "api", reason }); }
            catch (error) { scheduler.enable(handoff[1]!); throw error; }
          }
          return void json(res, 200, { apiVersion: OPERATOR_API_VERSION, loop: registry.get(handoff[1]!), schedule: controller.readState().loops[handoff[1]!] ?? {} });
        }
        const dispatch = url.pathname.match(/^\/api\/v1\/loops\/([A-Za-z0-9._-]+)\/runs$/);
        if (dispatch) {
          const action = body.action === "step" ? "step" : body.action === "run" ? "run" : undefined;
          if (!action) return void json(res, 400, { apiVersion: OPERATOR_API_VERSION, error: "action must be run or step" });
          const runId = typeof body.runId === "string" ? body.runId : undefined;
          const promise = controller.execute(dispatch[1]!, action, { actor, surface: "api", runId, reason: typeof body.reason === "string" ? body.reason : undefined });
          void promise.catch(() => undefined);
          return void json(res, 202, { apiVersion: OPERATOR_API_VERSION, accepted: true, action, runId: runId ?? controller.readState().loops[dispatch[1]!]?.active?.runId });
        }
        const actionRoute = url.pathname.match(/^\/api\/v1\/loops\/([A-Za-z0-9._-]+)\/runs\/([A-Za-z0-9._-]+)\/actions$/);
        if (actionRoute) {
          const action = typeof body.action === "string" ? body.action : "";
          const reason = typeof body.reason === "string" ? body.reason : undefined;
          if (action === "pause" || action === "stop") {
            const request = controller.requestStop(actionRoute[1]!, { actor, surface: "api", runId: actionRoute[2]!, reason, action });
            return void json(res, 202, { apiVersion: OPERATOR_API_VERSION, accepted: true, action, request });
          }
          if (action === "resume" || action === "approve") {
            const promise = controller.execute(actionRoute[1]!, action, { actor, surface: "api", runId: actionRoute[2]!, reason });
            void promise.catch(() => undefined);
            return void json(res, 202, { apiVersion: OPERATOR_API_VERSION, accepted: true, action, runId: actionRoute[2] });
          }
          if (action === "recover") {
            const resolution = body.resolution;
            if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) return void json(res, 400, { apiVersion: OPERATOR_API_VERSION, error: "recover requires a resolution object" });
            const promise = controller.execute(actionRoute[1]!, "recover", { actor, surface: "api", runId: actionRoute[2]!, reason, recovery: resolution as never });
            void promise.catch(() => undefined);
            return void json(res, 202, { apiVersion: OPERATOR_API_VERSION, accepted: true, action, runId: actionRoute[2] });
          }
          return void json(res, 400, { apiVersion: OPERATOR_API_VERSION, error: "action must be pause, stop, resume, approve, or recover" });
        }
        return void json(res, 404, { apiVersion: OPERATOR_API_VERSION, error: "not found" });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return void json(res, 405, { apiVersion: OPERATOR_API_VERSION, error: "method not allowed" });

      if (url.pathname === "/api/v1/health") {
        json(res, 200, { apiVersion: OPERATOR_API_VERSION, ok: true, loopback: true, scheduler: true });
        return;
      }
      if (url.pathname === "/api/v1/loops") {
        const loops = await Promise.all(registry.list().map((loop) => loopOverview(loop, controller, artifactCache)));
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
      const artifactMatch = url.pathname.match(/^\/api\/v1\/loops\/([A-Za-z0-9._-]+)\/artifacts(?:\/(.+))?$/);
      if (artifactMatch) {
        const loop = registry.get(artifactMatch[1]!);
        if (!loop) return void json(res, 404, { apiVersion: OPERATOR_API_VERSION, error: "loop not found" });
        const loaded = loadSpecFromYaml(readFileSync(join(loop.path, "loop.source.yaml"), "utf8"));
        if (!loaded.spec) return void json(res, 409, { apiVersion: OPERATOR_API_VERSION, error: "installed source no longer validates" });
        const index = indexArtifacts(loop.path, loaded.spec.artifacts, loop.id);
        if (!artifactMatch[2]) return void json(res, 200, { apiVersion: OPERATOR_API_VERSION, artifacts: index });
        const resolved = readIndexedArtifact(loop.path, index, artifactMatch[2]);
        if (!resolved) return void json(res, 404, { apiVersion: OPERATOR_API_VERSION, error: "artifact not allowlisted" });
        headers(res, resolved.artifact.mime);
        res.setHeader("Content-Length", String(resolved.artifact.size));
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(resolved.artifact.path.split("/").at(-1)!)}`);
        res.statusCode = 200;
        if (req.method === "HEAD") res.end();
        else res.end(resolved.data);
        return;
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
    controller,
    scheduler,
    notifier,
    token,
    start: () => new Promise((resolveStart, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        scheduler.start();
        resolveStart({ host, port: boundPort, url: `http://${host}:${boundPort}` });
      });
    }),
    stop: () => {
      scheduler.stop();
      return new Promise((resolveStop, reject) => server.close((error) => error ? reject(error) : resolveStop()));
    },
  };
}
