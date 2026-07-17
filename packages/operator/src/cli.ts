import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createOperatorServer } from "./server.js";
import { OperatorRegistry } from "./registry.js";
import { OperatorRunController, OperatorScheduler } from "./controller.js";
import { indexArtifacts } from "./artifacts.js";
import { NotificationDispatcher } from "./notifications.js";

const HELP = `loopyd — local Monkey D Loopy operator

Usage:
  loopyd install <artifact-dir>
  loopyd list
  loopyd handoff <loop> <host|operator> --reason <text>
  loopyd run|step <loop> [--run-id <id>]
  loopyd pause|stop|resume|approve <loop> --run-id <id> --reason <text>
  loopyd up [--background] [--port <port>]
  loopyd status
  loopyd down
  loopyd ui

No service is installed or started during npm install.`;

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid(registry: OperatorRegistry): number | undefined {
  if (!existsSync(registry.paths.pid)) return undefined;
  const pid = Number(readFileSync(registry.paths.pid, "utf8").trim());
  if (processAlive(pid)) return pid;
  rmSync(registry.paths.pid, { force: true });
  return undefined;
}

function runController(registry: OperatorRegistry): OperatorRunController {
  const notifier = new NotificationDispatcher(registry);
  return new OperatorRunController({
    registry,
    onResult: (loop, spec, runId, result) => notifier.dispatch(loop, spec, runId, result, indexArtifacts(loop.path, spec.artifacts, loop.id)).then(() => undefined),
  });
}

async function serve(registry: OperatorRegistry, port: number): Promise<number> {
  const existing = readPid(registry);
  if (existing && existing !== process.pid) throw new Error(`operator is already running (pid ${existing})`);
  const handle = createOperatorServer({ registry, port });
  const address = await handle.start();
  registry.writePort(address.port);
  writeFileSync(registry.paths.pid, `${process.pid}\n`, { mode: 0o600 });
  const cleanup = async () => {
    rmSync(registry.paths.pid, { force: true });
    const safe = await handle.controller.shutdown();
    await handle.stop().catch(() => undefined);
    if (!safe) console.error("loopyd: shutdown timed out before every run reached a journal-safe boundary");
  };
  process.once("SIGINT", () => void cleanup().then(() => process.exit(0)));
  process.once("SIGTERM", () => void cleanup().then(() => process.exit(0)));
  console.log(`operator listening on ${address.url} (pid ${process.pid})`);
  return new Promise(() => undefined);
}

export async function runOperatorCli(argv: string[]): Promise<number> {
  const registry = new OperatorRegistry();
  const command = argv[0];
  if (!command || command === "help" || argv.includes("--help")) {
    console.log(HELP);
    return command ? 0 : 1;
  }
  if (command === "install") {
    if (!argv[1]) throw new Error("usage: loopyd install <artifact-dir>");
    const loop = registry.install(argv[1]);
    console.log(`installed '${loop.id}' from ${loop.path} (scheduler: ${loop.schedulerAuthority})`);
    return 0;
  }
  if (command === "list") {
    const loops = registry.list();
    if (!loops.length) console.log("no loops installed");
    for (const loop of loops) console.log(`${loop.id}\t${loop.schedulerAuthority}\t${loop.path}`);
    return 0;
  }
  if (command === "handoff") {
    const id = argv[1];
    const to = argv[2];
    const reason = flagValue(argv, "--reason") ?? "";
    if (!id || (to !== "host" && to !== "operator")) throw new Error("usage: loopyd handoff <loop> <host|operator> --reason <text>");
    const controller = new OperatorRunController({ registry });
    const scheduler = new OperatorScheduler(controller);
    if (to === "operator") {
      scheduler.enable(id);
      try { registry.handoff(id, to, { actor: flagValue(argv, "--actor") ?? "local-user", surface: "cli", reason }); }
      catch (error) { scheduler.disable(id); throw error; }
    } else {
      scheduler.disable(id);
      try { registry.handoff(id, to, { actor: flagValue(argv, "--actor") ?? "local-user", surface: "cli", reason }); }
      catch (error) { scheduler.enable(id); throw error; }
    }
    console.log(`scheduler authority for '${id}' handed to ${to}`);
    if (to === "host") console.log(`host trigger guidance: loopc schedule install ${registry.get(id)!.path}`);
    return 0;
  }
  if (["run", "step", "resume", "approve"].includes(command)) {
    const id = argv[1];
    if (!id) throw new Error(`usage: loopyd ${command} <loop> [--run-id <id>]`);
    const runId = flagValue(argv, "--run-id");
    if ((command === "resume" || command === "approve") && !runId) throw new Error(`${command} requires --run-id <id>`);
    const controller = runController(registry);
    const result = await controller.execute(id, command as "run" | "step" | "resume" | "approve", {
      actor: flagValue(argv, "--actor") ?? "local-user",
      surface: "cli",
      runId,
      reason: flagValue(argv, "--reason"),
    });
    console.log(`${command} '${id}' → ${result.status} (iteration ${result.iteration})`);
    return result.status === "failed" || result.status === "uncertain" ? 1 : 0;
  }
  if (command === "pause" || command === "stop") {
    const id = argv[1];
    const runId = flagValue(argv, "--run-id");
    if (!id || !runId) throw new Error(`usage: loopyd ${command} <loop> --run-id <id> --reason <text>`);
    const controller = runController(registry);
    const request = controller.requestStop(id, {
      actor: flagValue(argv, "--actor") ?? "local-user",
      surface: "cli",
      runId,
      reason: flagValue(argv, "--reason"),
      action: command,
    });
    console.log(`${command} requested for '${id}' run '${request.runId}' at the next journal-safe boundary`);
    return 0;
  }
  if (command === "status") {
    const pid = readPid(registry);
    console.log(pid ? `operator running (pid ${pid})` : "operator stopped");
    return pid ? 0 : 1;
  }
  if (command === "down") {
    const pid = readPid(registry);
    if (!pid) {
      console.log("operator already stopped");
      return 0;
    }
    process.kill(pid, "SIGTERM");
    console.log(`graceful shutdown requested (pid ${pid})`);
    return 0;
  }
  if (command === "ui") {
    const pid = readPid(registry);
    if (!pid) throw new Error("operator is stopped; run `loopyd up --background` first");
    const port = registry.readPort(Number(process.env.LOOPY_OPERATOR_PORT ?? 3210));
    const token = registry.ensureToken();
    console.log(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    return 0;
  }
  if (command === "up" || command === "serve") {
    const port = Number(flagValue(argv, "--port") ?? process.env.LOOPY_OPERATOR_PORT ?? 3210);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port '${port}'`);
    if (command === "up" && argv.includes("--background")) {
      if (process.platform === "win32") throw new Error("background lifecycle is not supported on Windows; run `loopyd up` in the foreground");
      const existing = readPid(registry);
      if (existing) {
        console.log(`operator already running (pid ${existing})`);
        return 0;
      }
      if (port === 0) throw new Error("background mode requires a fixed port; omit --port or choose a port from 1 to 65535");
      registry.writePort(port);
      const entry = realpathSync(process.argv[1]!);
      const child = spawn(process.execPath, [entry, "serve", "--port", String(port)], { detached: true, stdio: "ignore", env: { ...process.env, LOOPY_OPERATOR_PORT: String(port) } });
      child.unref();
      console.log(`operator starting in background (pid ${child.pid})`);
      return 0;
    }
    return serve(registry, port);
  }
  console.error(`unknown command '${command}'\n\n${HELP}`);
  return 1;
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) {
  runOperatorCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(`loopyd: ${(error as Error).message}`); process.exitCode = 1; });
}
