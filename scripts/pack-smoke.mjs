import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = mkdtempSync(join(tmpdir(), "loopy-pack-smoke-"));
const tarballsDir = join(temp, "tarballs");
const consumer = join(temp, "consumer");
const output = join(consumer, "out");
const keep = process.env.LOOPY_KEEP_PACK_SMOKE === "1";
const smokeEnv = { ...process.env, npm_config_cache: join(temp, "npm-cache") };

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: smokeEnv });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
};
const requireTruthy = (condition, message) => {
  if (!condition) throw new Error(`packed consumer smoke: ${message}`);
};

try {
  writeFileSync(join(temp, ".keep"), "");
  mkdirSync(tarballsDir, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  const publicDirs = run(process.execPath, [join(root, "scripts/list-public-package-dirs.mjs")]).trim().split(/\s+/);
  for (const dir of publicDirs) {
    run("pnpm", ["pack", "--pack-destination", tarballsDir], join(root, "packages", dir));
  }
  const tarballs = readdirSync(tarballsDir).filter((name) => name.endsWith(".tgz")).map((name) => join(tarballsDir, name));
  requireTruthy(tarballs.length === publicDirs.length, `packed ${tarballs.length}/${publicDirs.length} public packages`);

  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "loopy-release-smoke", private: true, type: "module" }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], consumer);

  const loopc = join(consumer, "node_modules", ".bin", "loopc");
  const loopyd = join(consumer, "node_modules", ".bin", "loopyd");
  requireTruthy(run(loopc, ["--version"], consumer).trim() === releaseVersion, "packed loopc reports the wrong version");

  // This is the public onboarding contract: from an empty directory, the packed CLI must prove,
  // execute, journal, inspect, and vendor a safe first loop without reaching into the repository.
  const firstLoop = join(consumer, "first-loop");
  const onboarding = run(loopc, ["quickstart", firstLoop], consumer);
  requireTruthy(onboarding.includes("first loop complete"), "quickstart did not reach its completion handoff");
  requireTruthy(existsSync(join(firstLoop, "hello-loopy.loop.yaml")), "quickstart omitted the editable LoopSpec");
  requireTruthy(
    existsSync(join(firstLoop, "run", ".loopy", "runs", "default", "events.jsonl")),
    "quickstart omitted the durable journal"
  );
  requireTruthy(
    existsSync(join(firstLoop, "artifact", "standalone", "runtime.bundle.mjs")),
    "quickstart omitted the vendored standalone runtime"
  );

  requireTruthy(run(loopyd, ["--help"], consumer).includes("local Monkey D Loopy operator"), "packed loopyd CLI is missing");
  requireTruthy(
    existsSync(join(consumer, "node_modules", "@loopyc", "operator", "assets", "control-center", "index.html")),
    "packed operator omits control-center assets"
  );
  const targets = run(loopc, ["targets"], consumer);
  for (const target of ["standalone", "babysitter", "claude-code", "claude-native", "n8n"]) {
    requireTruthy(targets.includes(target), `packed loopc targets omits ${target}`);
  }
  const recipes = run(loopc, ["recipes"], consumer);
  requireTruthy(recipes.includes("repo-health-doctor"), "packed loopc omits the verified recipe catalog");
  const recipeSpec = join(consumer, "packed-health.loop.yaml");
  run(loopc, ["new", "packed-health", "--recipe", "repo-health-doctor", "--out", recipeSpec], consumer);
  run(loopc, ["validate", recipeSpec], consumer);

  const spec = join(consumer, "release-smoke.yaml");
  writeFileSync(spec, `loopspec: "0.1"
id: release-smoke
pattern: react
state:
  vars:
    done: { type: boolean, init: false }
body:
  - id: finish
    kind: agent
    harness: internal
    prompt: finish
    on_done: { set: { done: true } }
terminate:
  signal: state-predicate
  until: "\${state.done == true}"
caps:
  max_iterations: 3
`);
  run(loopc, ["compile", spec, "--target", "all", "--out", output], consumer);
  for (const target of ["standalone", "babysitter", "claude-code", "claude-native", "n8n"]) {
    requireTruthy(existsSync(join(output, target)), `compile --target all omitted ${target}`);
  }
  requireTruthy(
    existsSync(join(output, "claude-native", ".claude", "skills", "release-smoke", "SKILL.md")),
    "packed compile did not emit the Claude-native project skill"
  );

  const standalone = join(output, "standalone");
  const runtimeTarball = tarballs.find((path) => path.includes("loopyc-runtime-"));
  requireTruthy(runtimeTarball, "runtime tarball missing");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", runtimeTarball], standalone);
  const runResult = JSON.parse(run(process.execPath, ["loop.mjs", "run"], standalone).trim());
  requireTruthy(runResult.status === "completed", `packed standalone returned ${runResult.status}`);

  const publicManifests = publicDirs.map((dir) => JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")));
  const imports = publicManifests.filter((manifest) => manifest.publishConfig?.main).map((manifest) => manifest.name);
  run(process.execPath, ["--input-type=module", "-e", `await Promise.all(${JSON.stringify(imports)}.map((name) => import(name)))`], consumer);

  const mcpSmoke = join(consumer, "mcp-smoke.mjs");
  const mcpEntry = join(consumer, "node_modules", "@loopyc", "mcp", "dist", "index.js");
  writeFileSync(mcpSmoke, `
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "packed-smoke", version: ${JSON.stringify(releaseVersion)} });
const transport = new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(mcpEntry)}] });
await client.connect(transport);
const names = (await client.listTools()).tools.map((tool) => tool.name);
for (const required of ["get_loop_schema", "list_recipes", "new_loop", "compile_loop", "run_loop"]) {
  if (!names.includes(required)) throw new Error("packed MCP omits " + required);
}
const listed = await client.callTool({ name: "list_recipes", arguments: {} });
const listedText = listed.content?.[0]?.text ?? "";
if (!listedText.includes("repo-health-doctor")) throw new Error("packed MCP recipe catalog is empty");
const created = await client.callTool({ name: "new_loop", arguments: { id: "packed-health", recipe: "repo-health-doctor" } });
const createdText = created.content?.[0]?.text ?? "";
if (!createdText.includes("name: repo-health-doctor")) throw new Error("packed MCP did not preserve recipe provenance");
await client.close();
`);
  run(process.execPath, [mcpSmoke], consumer);
  console.log(`packed consumer smoke ✓ ${tarballs.length} packages · clean-room quickstart + libraries + CLI + MCP · all targets · claude-native · standalone run`);
} finally {
  if (keep) console.log(`packed consumer retained at ${temp}`);
  else rmSync(temp, { recursive: true, force: true });
}
