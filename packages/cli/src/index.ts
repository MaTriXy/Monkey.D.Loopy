/**
 * loopc — the Monkey D Loopy CLI. The only byte-writer / I/O layer over @loopyc/core.
 * Dev runs via tsx; the published bin is the compiled ./dist/index.js (shebang added at build).
 *
 * Commands:
 *   loopc new <id> [--blueprint <name>] [--pattern <p>] [--out <file>]
 *   loopc validate <spec.yaml>
 *   loopc compile <spec.yaml> [--target standalone,babysitter,claude-code,claude-native,n8n|all] [--out <dir>]
 *   loopc blueprints
 */
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  CAPABILITY_MATRIX,
  formatValidation,
  getBlueprint,
  listBlueprints,
  loadSpecFromYaml,
  planLoopExport,
  SUPPORTED_TARGETS,
  type PlannedFile,
  type RuntimeTarget,
} from "@loopyc/core";
import { createRuntime, Journal } from "@loopyc/runtime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { flagString, parseArgs } from "./args.js";
import { formatScore, formatVerify, interpretLoop, scoreLoop, verifyLoop } from "@loopyc/verify";
import { inferScaffold } from "@loopyc/infer";

const USAGE = `loopc — factory for runnable agent loops

Usage:
  loopc new <id> [--blueprint <name>] [--pattern <pattern>] [--out <file>]
  loopc new <id> --from-shell "<cmd>" --until "<expr>"   (scaffold a loop around a command)
  loopc validate <spec.yaml>
  loopc verify <spec.yaml> [--fix]
  loopc score <spec.yaml>
  loopc run <spec.yaml> [--out <dir>] [--inputs <file.json>] [--approve] [--yes] [--run-id <id>]
  loopc inspect <dir> [--tail <n>] [--run-id <id>]
  loopc compile <spec.yaml> [--target standalone,babysitter,claude-code,claude-native,n8n|all] [--out <dir>] [--vendor]
  loopc schedule install <dir>   (print the host trigger to fire a scheduled loop on a cadence)
  loopc reprint <artifact-dir> [--target <t>] [--out <dir>]   (recompile under this factory)
  loopc infer-scaffold <script-or-journal> [--out <draft.yaml>]   (draft a spec from a script/trace)
  loopc targets       (show the per-target capability matrix)
  loopc blueprints

Run \`loopc blueprints\` to list starting-point templates.`;

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const cmd = positionals[0];

  if (!cmd || flags.help) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  switch (cmd) {
    case "new":
      return cmdNew(positionals[1], flags);
    case "validate":
      return cmdValidate(positionals[1]);
    case "verify":
      return cmdVerify(positionals[1], flags);
    case "score":
      return cmdScore(positionals[1]);
    case "run":
      return cmdRun(positionals[1], flags);
    case "inspect":
      return cmdInspect(positionals[1], flags);
    case "compile":
      return cmdCompile(positionals[1], flags);
    case "schedule":
      return cmdScheduleInstall(positionals[1], positionals[2]);
    case "reprint":
      return cmdReprint(positionals[1], flags);
    case "targets":
      return cmdTargets();
    case "infer-scaffold":
      return cmdInferScaffold(positionals[1], flags);
    case "blueprints":
      return cmdBlueprints();
    default:
      console.error(`unknown command '${cmd}'\n\n${USAGE}`);
      return 1;
  }
}

function cmdBlueprints(): number {
  console.log("Available blueprints:\n");
  for (const b of listBlueprints()) {
    console.log(`  ${b.name.padEnd(22)} ${b.description}`);
  }
  console.log("\nScaffold one with: loopc new <id> --blueprint <name>");
  return 0;
}

async function cmdNew(id: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!id) {
    console.error("usage: loopc new <id> [--blueprint <name>] [--pattern <pattern>] [--out <file>]");
    return 1;
  }
  const blueprintName = flagString(flags, "blueprint");
  const fromShell = flagString(flags, "from-shell");
  let yaml: string;
  if (fromShell) {
    const until = flagString(flags, "until");
    if (!until) {
      console.error("--from-shell requires --until <expr> (e.g. --until \"${state.out.ready == true}\")");
      return 1;
    }
    yaml = fromShellTemplate(id, fromShell, until, flagString(flags, "pattern") ?? "loop-until-dry");
  } else if (blueprintName) {
    const bp = getBlueprint(blueprintName);
    if (!bp) {
      console.error(`unknown blueprint '${blueprintName}'. Run \`loopc blueprints\` to list.`);
      return 1;
    }
    yaml = bp.yaml.replace(/^id:.*$/m, `id: ${id}`);
  } else {
    yaml = minimalTemplate(id, flagString(flags, "pattern") ?? "react");
  }
  const out = flagString(flags, "out") ?? `${id}.loop.yaml`;
  await writeFile(out, yaml, "utf8");
  console.log(`✓ wrote ${out}`);
  console.log(`  next: loopc validate ${out} && loopc compile ${out} --target all`);
  return 0;
}

async function cmdValidate(file: string | undefined): Promise<number> {
  if (!file) {
    console.error("usage: loopc validate <spec.yaml>");
    return 1;
  }
  const text = await readFile(resolve(file), "utf8");
  const result = loadSpecFromYaml(text);
  if (result.parseErrors) {
    console.error(`✗ parse failed:\n${result.parseErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  console.log(formatValidation(result.validation!));
  return result.validation!.ok ? 0 : 1;
}

async function cmdVerify(file: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!file) {
    console.error("usage: loopc verify <spec.yaml> [--fix]");
    return 1;
  }
  const text = await readFile(resolve(file), "utf8");
  const result = loadSpecFromYaml(text);
  if (result.parseErrors) {
    console.error(`✗ parse failed:\n${result.parseErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  if (!result.validation!.ok) {
    console.error("✗ refusing to verify — validation failed:");
    console.error(formatValidation(result.validation!));
    return 1;
  }
  const report = await verifyLoop(result.spec!, result.capsInjected ?? false);
  console.log(formatVerify(report));
  if (flags.fix && report.capsInjected) {
    const obj = parseYaml(text) as Record<string, unknown>;
    obj.caps = result.spec!.caps;
    await writeFile(resolve(file), stringifyYaml(obj), "utf8");
    console.log(`✓ wrote explicit caps into ${file}`);
  }
  return report.ok ? 0 : 1;
}

async function cmdScore(file: string | undefined): Promise<number> {
  if (!file) {
    console.error("usage: loopc score <spec.yaml>");
    return 1;
  }
  const text = await readFile(resolve(file), "utf8");
  const result = loadSpecFromYaml(text);
  if (result.parseErrors) {
    console.error(`✗ parse failed:\n${result.parseErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  if (!result.validation!.ok) {
    console.error("✗ refusing to score — validation failed:");
    console.error(formatValidation(result.validation!));
    return 1;
  }
  const report = await verifyLoop(result.spec!, result.capsInjected ?? false);
  const card = scoreLoop(result.spec!, report);
  console.log(formatVerify(report));
  console.log("");
  console.log(formatScore(card));
  return report.ok ? 0 : 1;
}

async function cmdRun(file: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!file) {
    console.error("usage: loopc run <spec.yaml> [--out <dir>] [--inputs <file.json>] [--approve] [--yes] [--run-id <id>]");
    return 1;
  }
  const text = await readFile(resolve(file), "utf8");
  const result = loadSpecFromYaml(text);
  if (result.parseErrors) {
    console.error(`✗ parse failed:\n${result.parseErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  if (!result.validation!.ok) {
    console.error("✗ refusing to run — validation failed:");
    console.error(formatValidation(result.validation!));
    return 1;
  }
  for (const w of result.validation!.warnings) console.warn(`  ⚠ [${w.code}] ${w.message}`);

  let inputs: Record<string, unknown> | undefined;
  const inputsFile = flagString(flags, "inputs");
  if (inputsFile) {
    try {
      inputs = JSON.parse(await readFile(resolve(inputsFile), "utf8")) as Record<string, unknown>;
    } catch (e) {
      console.error(`✗ could not read --inputs '${inputsFile}': ${(e as Error).message}`);
      return 1;
    }
  }

  // The run dir is the runtime cwd; the journal lives under <dir>/.loopy/runs/<runId>.
  // Unlike the MCP server, this is a local command the user runs themselves: INHERIT
  // process.env (no scrubbing), mirroring the compiled standalone artifact's `node loop.mjs run`.
  const outDir = resolve(flagString(flags, "out") ?? ".loopy");
  const r = await createRuntime(interpretLoop(result.spec!), {
    cwd: outDir,
    inputs,
    autoApprove: Boolean(flags.yes || flags["auto-approve"]),
    approveCaps: Boolean(flags.approve),
    runId: flagString(flags, "run-id"),
  }).run();

  console.log(`✓ ran '${result.spec!.id}'`);
  console.log(`  run dir:   ${outDir}`);
  console.log(`  status:    ${r.status}`);
  console.log(`  iteration: ${r.iteration}`);
  if (r.reason) console.log(`  reason:    ${r.reason}`);
  return r.status === "failed" ? 1 : 0;
}

function cmdInspect(dirArg: string | undefined, flags: Record<string, string | boolean>): number {
  if (!dirArg) {
    console.error("usage: loopc inspect <dir> [--tail <n>] [--run-id <id>]");
    return 1;
  }
  const dir = resolve(dirArg);
  const runId = flagString(flags, "run-id") ?? "default";
  const journal = new Journal(dir, runId);
  if (!journal.exists()) {
    console.error(`no run journal found under ${join(dir, ".loopy", "runs", runId)} — run one first with \`loopc run <spec> --out ${dirArg}\`.`);
    return 1;
  }
  let events;
  try {
    events = journal.load();
  } catch (e) {
    // a genuinely corrupted/truncated journal makes load() throw — degrade gracefully instead of
    // surfacing a raw stack via the top-level catch.
    console.error(`✗ could not read the journal under ${join(dir, ".loopy", "runs", runId)}: ${(e as Error).message}`);
    console.error(`  the run dir may be corrupted — inspect/clear it, or start a fresh run with --out.`);
    return 1;
  }
  const n = Number.parseInt(flagString(flags, "tail") ?? "", 10) || 10;

  // status/iteration come from the persisted run meta (best-effort; the journal is the truth).
  try {
    const meta = JSON.parse(readFileSync(join(journal.dir, "meta.json"), "utf8")) as { status?: string; iteration?: number };
    console.log(`status: ${meta.status ?? "unknown"}  ·  iteration: ${meta.iteration ?? "?"}`);
  } catch {
    /* no meta cache yet — fall through to the journal view */
  }

  const final = events.filter((e) => e.type === "iteration_snapshot").at(-1);
  const state = final ? JSON.stringify(final.data.state) : "(no snapshot yet)";
  const last = events.slice(-n).map((e) => `  #${e.seq} ${e.type} ${JSON.stringify(e.data)}`).join("\n");
  console.log(`events: ${events.length}`);
  console.log(`latest state: ${state}`);
  console.log(`\nlast ${n} events:\n${last}`);
  return 0;
}

async function cmdCompile(file: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!file) {
    console.error("usage: loopc compile <spec.yaml> [--target ...] [--out <dir>] [--vendor]");
    return 1;
  }
  const text = await readFile(resolve(file), "utf8");
  const result = loadSpecFromYaml(text);
  if (result.parseErrors) {
    console.error(`✗ parse failed:\n${result.parseErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  if (!result.validation!.ok) {
    console.error("✗ refusing to compile — validation failed:");
    console.error(formatValidation(result.validation!));
    return 1;
  }
  for (const w of result.validation!.warnings) console.warn(`  ⚠ [${w.code}] ${w.message}`);

  const spec = result.spec!;
  const targets = resolveTargets(flags, spec.target?.runtime);
  const outDir = flagString(flags, "out") ?? join("out", spec.id);

  // --vendor bundles @loopyc/runtime into the standalone artifact so it runs with plain `node`
  // (no install). It only makes sense for the standalone target — refuse it for anything else.
  const vendor = Boolean(flags.vendor);
  if (vendor && (targets.length !== 1 || targets[0] !== "standalone")) {
    console.error("--vendor applies to the standalone target only — pass `--target standalone` (or omit --target).");
    return 1;
  }

  for (const target of targets) {
    const plan = planLoopExport(spec, target, target === "standalone" ? { vendor } : undefined);
    const targetDir = join(outDir, target);
    await writePlanned(targetDir, plan.files);
    if (vendor && target === "standalone") {
      await writeFile(join(targetDir, "runtime.bundle.mjs"), await bundleRuntime(), "utf8");
    }
    await writeFile(join(targetDir, "loop.source.yaml"), text, "utf8"); // self-contained for reprint
    const fileCount = plan.files.length + (vendor && target === "standalone" ? 1 : 0);
    console.log(`✓ compiled '${spec.id}' → ${target}  (${fileCount} files in ${targetDir})`);
    for (const f of plan.files) console.log(`    ${f.relativePath}`);
    if (vendor && target === "standalone") {
      console.log(`    runtime.bundle.mjs`);
      console.log(`    ↳ self-contained: runs with plain \`node loop.mjs run\` — no npm install needed.`);
    }
    for (const w of plan.warnings) console.warn(`    ⚠ ${w}`);
  }
  return 0;
}

/**
 * Bundle @loopyc/runtime into a single self-contained ESM file (text) with esbuild. node built-ins
 * stay external under platform:"node"; any @loopyc/* deps of the runtime are inlined. The entry is
 * resolved through Node's own resolution so it follows the same `@loopyc/runtime` the CLI loads.
 */
async function bundleRuntime(): Promise<string> {
  const { build } = await import("esbuild");
  // Resolve via the ESM `import` condition (same one the CLI's own top-level
  // `import { createRuntime } from "@loopyc/runtime"` uses). createRequire(...).resolve uses the
  // CJS `require` condition, which the runtime's PUBLISHED exports map (publishConfig: types+import
  // only) does NOT define — so it threw ERR_PACKAGE_PATH_NOT_EXPORTED in any packed/published CLI,
  // exactly the zero-install distribution path --vendor exists for. import.meta.resolve handles the
  // published case (dev tsx + plain node both have it); fall back to createRequire where
  // import.meta.resolve is unavailable (e.g. Vitest's SSR transform), which resolves fine against
  // the in-repo workspace exports.
  const metaResolve = (import.meta as unknown as { resolve?: (s: string) => string }).resolve;
  const entry =
    typeof metaResolve === "function"
      ? fileURLToPath(metaResolve("@loopyc/runtime"))
      : createRequire(import.meta.url).resolve("@loopyc/runtime");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  return result.outputFiles![0]!.text;
}

/**
 * `loopc schedule install <dir>` — print the host trigger for a compiled, scheduled artifact.
 * Install-only: it reads the artifact's `schedule/` dir and prints copy-paste guidance for the
 * CURRENT platform (paths pre-filled). It has NO side effects beyond reading + printing — it does
 * not enable, load, or write anything. If the loop has no recurring schedule, it errors non-zero.
 */
function cmdScheduleInstall(sub: string | undefined, dirArg: string | undefined): number {
  if (sub !== "install" || !dirArg) {
    console.error("usage: loopc schedule install <dir>");
    return 1;
  }
  const dir = resolve(dirArg);
  const schedDir = join(dir, "schedule");
  if (!existsSync(schedDir)) {
    console.error(`No schedule/ trigger files under ${dirArg}.`);
    console.error("This loop isn't on a recurring schedule (schedule.mode is one-shot/'manual' or absent),");
    console.error("so there's nothing to install. Give it a recurring schedule (cron/forever/watch) and recompile.");
    return 1;
  }
  const names = readdirSync(schedDir);
  const plistName = names.find((n) => n.endsWith(".plist"));
  const id = plistName ? plistName.replace(/\.plist$/, "") : "loop";
  const readSched = (name: string): string =>
    existsSync(join(schedDir, name)) ? readFileSync(join(schedDir, name), "utf8") : "";
  // Make the printed snippet copy-paste-ready by swapping the artifact placeholder for the abs dir.
  const ready = (s: string): string => s.split("/path/to/loop").join(dir);

  const cronLine = readSched("crontab.txt").split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
  const cron = cronLine.trim().split(/\s+/).slice(0, 5).join(" ");

  console.log(`Scheduler install for '${id}'  (install-only: this prints guidance; it enables nothing).`);
  console.log(`Artifact: ${dir}`);
  if (cron) console.log(`Cadence:  ${cron}   (one iteration per fire: node loop.mjs step)`);
  console.log("");

  if (process.platform === "darwin") {
    console.log("Platform: macOS (launchd)\n");
    console.log(`  cp '${join(schedDir, `${id}.plist`)}' ~/Library/LaunchAgents/com.loopy.${id}.plist`);
    console.log(`  launchctl load ~/Library/LaunchAgents/com.loopy.${id}.plist`);
    console.log(`  # later, to remove: launchctl unload ~/Library/LaunchAgents/com.loopy.${id}.plist`);
    console.log(`\n--- ${id}.plist (paths filled in) ---`);
    console.log(ready(readSched(`${id}.plist`)));
  } else if (process.platform === "linux") {
    console.log("Platform: Linux (systemd --user)\n");
    console.log("  mkdir -p ~/.config/systemd/user");
    console.log(`  cp '${join(schedDir, `${id}.service`)}' '${join(schedDir, `${id}.timer`)}' ~/.config/systemd/user/`);
    console.log(`  # then edit the copied units: replace /path/to/loop with ${dir}`);
    console.log(`  systemctl --user daemon-reload && systemctl --user enable --now ${id}.timer`);
    console.log("\n  Or with plain cron — run `crontab -e` and paste:");
    console.log(`    ${ready(cronLine).trim()}`);
  } else {
    console.log(`Platform: ${process.platform} (cron)\n`);
    console.log("  run `crontab -e` and paste:");
    console.log(`    ${ready(cronLine).trim()}`);
  }

  console.log(`\nCI option: ${id}.gh-actions.yml → copy to .github/workflows/${id}.yml in your repo`);
  console.log("  (GitHub Actions runs `node loop.mjs step` on the schedule; wire any secrets it needs).");
  console.log(`\nAll trigger files: ${schedDir}`);
  return 0;
}

async function cmdReprint(dirArg: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!dirArg) {
    console.error("usage: loopc reprint <artifact-dir> [--target <t>] [--out <dir>]");
    return 1;
  }
  const dir = resolve(dirArg);
  let text: string;
  try {
    text = await readFile(join(dir, "loop.source.yaml"), "utf8");
  } catch {
    console.error(`no loop.source.yaml in ${dirArg} — reprint needs an artifact compiled by this version.`);
    return 1;
  }
  const result = loadSpecFromYaml(text);
  if (result.parseErrors) {
    console.error(`✗ parse failed:\n${result.parseErrors.map((e) => `  - ${e}`).join("\n")}`);
    return 1;
  }
  if (!result.validation!.ok) {
    console.error("✗ refusing to reprint — the embedded spec is invalid under this factory:");
    console.error(formatValidation(result.validation!));
    return 1;
  }
  let target = flagString(flags, "target");
  let lockVendor = false;
  try {
    const lock = JSON.parse(await readFile(join(dir, "loop.lock"), "utf8")) as { target?: string; vendor?: boolean };
    if (!target) target = lock.target;
    lockVendor = lock.vendor === true;
  } catch {
    /* no/unreadable lock — fall through to spec defaults */
  }
  const resolved = (target ?? result.spec!.target?.runtime ?? "standalone") as RuntimeTarget;
  if (!SUPPORTED_TARGETS.includes(resolved)) {
    console.error(`unknown target '${resolved}' (supported: ${SUPPORTED_TARGETS.join(", ")})`);
    return 1;
  }
  const outDir = flagString(flags, "out") ?? dir; // overwrite in place by default
  // Preserve the zero-install property: a vendored artifact (per loop.lock, or a stray
  // runtime.bundle.mjs from an older lock-less build) must stay vendored, else reprint would
  // rewrite the import back to a bare @loopyc/runtime with no install path and break the loop.
  const vendor =
    resolved === "standalone" && (lockVendor || existsSync(join(dir, "runtime.bundle.mjs")));
  const plan = planLoopExport(result.spec!, resolved, vendor ? { vendor: true } : undefined);
  await writePlanned(outDir, plan.files);
  if (vendor) await writeFile(join(outDir, "runtime.bundle.mjs"), await bundleRuntime(), "utf8");
  await writeFile(join(outDir, "loop.source.yaml"), text, "utf8");
  console.log(
    `✓ reprinted '${result.spec!.id}' → ${resolved}${vendor ? " (vendored)" : ""}  (${plan.files.length + (vendor ? 1 : 0)} files in ${outDir})`
  );
  for (const w of plan.warnings) console.warn(`    ⚠ ${w}`);
  return 0;
}

async function cmdInferScaffold(file: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!file) {
    console.error("usage: loopc infer-scaffold <script-or-journal> [--out <draft.yaml>]");
    return 1;
  }
  const text = await readFile(resolve(file), "utf8");
  const { kind, factpack, draftYaml } = inferScaffold(file, text);
  console.log(`✓ extracted a FactPack from a ${kind} source (confidence: ${factpack.confidence})`);
  console.log(`  pattern: ${factpack.candidatePattern} · steps: ${factpack.steps.length} · inputs: ${factpack.inputs.join(", ") || "none"}`);
  if (factpack.terminateHint) console.log(`  exit hint: ${factpack.terminateHint}`);
  if (factpack.secretsFlagged.length) console.warn(`  ⚠ possible secrets — pass as inputs, never inline: ${factpack.secretsFlagged.join(", ")}`);
  for (const n of factpack.notes) console.log(`  · ${n}`);
  const out = flagString(flags, "out");
  if (out) {
    await writeFile(resolve(out), draftYaml, "utf8");
    console.log(`\n✓ wrote draft → ${out}\n  next: complete the TODOs, then \`loopc validate\` + \`loopc verify\`. The draft is NOT guaranteed valid — verify proves bounded, not semantically faithful, so review it.`);
  } else {
    console.log(`\n${draftYaml}`);
  }
  return 0;
}

function cmdTargets(): number {
  const targets = SUPPORTED_TARGETS;
  const caps = Object.keys(CAPABILITY_MATRIX[targets[0]!]);
  const icon = { enforced: "✓", soft: "~", unsupported: "✗" } as const;
  const w = Math.max(...caps.map((c) => c.length));
  const tw = Math.max(12, ...targets.map((t) => t.length + 2));
  console.log("Capability matrix  (✓ enforced · ~ soft · ✗ unsupported)\n");
  console.log(`  ${"capability".padEnd(w)}  ${targets.map((t) => t.padEnd(tw)).join("")}`);
  for (const cap of caps) {
    const cells = targets.map((t) => icon[CAPABILITY_MATRIX[t][cap as keyof (typeof CAPABILITY_MATRIX)[typeof t]]].padEnd(tw)).join("");
    console.log(`  ${cap.padEnd(w)}  ${cells}`);
  }
  return 0;
}

function fromShellTemplate(id: string, cmd: string, until: string, pattern: string): string {
  return `loopspec: "0.1"
id: ${id}
meta:
  name: ${id}
  description: "Loop around a shell command until a condition holds."
pattern: ${pattern}

state:
  store: journal
  vars:
    out: { type: json, init: null }

body:
  - id: run
    kind: shell
    cmd: ${JSON.stringify(cmd)}
    save: { out: "$" }

terminate:
  signal: state-predicate
  until: ${JSON.stringify(until)}

caps:
  max_iterations: 50
  no_progress: { fingerprint: "\${state.out}", max_repeats: 8 }
  budget: { tokens: 200000, usd: 5.0, wallclock: "1h" }
  on_cap_exceeded: breakpoint
`;
}

function resolveTargets(
  flags: Record<string, string | boolean>,
  specDefault: RuntimeTarget | undefined
): RuntimeTarget[] {
  if (flags.all === true || flags.target === "all") return [...SUPPORTED_TARGETS];
  const t = flagString(flags, "target");
  if (t) {
    const requested = t.split(",").map((s) => s.trim()) as RuntimeTarget[];
    for (const r of requested) {
      if (!SUPPORTED_TARGETS.includes(r)) {
        throw new Error(`unknown target '${r}' (supported: ${SUPPORTED_TARGETS.join(", ")}, all)`);
      }
    }
    return requested;
  }
  return [specDefault ?? "standalone"];
}

async function writePlanned(dir: string, files: PlannedFile[]): Promise<void> {
  for (const f of files) {
    const full = join(dir, f.relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.contents, "utf8");
    if (f.executable) await chmod(full, 0o755);
  }
}

function minimalTemplate(id: string, pattern: string): string {
  return `loopspec: "0.1"
id: ${id}
meta:
  name: ${id}
  description: ""
pattern: ${pattern}

state:
  store: journal
  vars:
    done: { type: boolean, init: false }

body:
  - id: work
    kind: agent
    harness: cli  # any coding agent via LOOPY_AGENT_CMD; or 'llm' for a plain LLM step
    prompt: "Do one unit of work toward the goal. Set done when the goal is met."
    on_done: { set: { done: true } }

terminate:
  signal: state-predicate
  until: "\${state.done == true}"

caps:
  max_iterations: 10
  budget: { tokens: 200000, usd: 5.0, wallclock: "1h" }
  on_cap_exceeded: breakpoint
`;
}

// Run only when invoked directly (so the module is importable in tests) — symlink-robust.
const __entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === __entry) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`loopc: ${(err as Error).message}`);
      process.exit(1);
    });
}
