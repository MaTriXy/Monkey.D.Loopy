/**
 * loopc-mcp server. Exposes the Monkey D Loopy factory to any MCP-capable agent so
 * loops can be authored, validated, verified, compiled, run, and inspected
 * conversationally. createServer() is transport-agnostic (the bin wires stdio; tests
 * use an in-memory transport).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatValidation,
  getBlueprint,
  listBlueprints,
  loadSpecFromYaml,
  LOOPSPEC_GUIDE,
  planLoopExport,
  SUPPORTED_TARGETS,
  type PlannedFile,
  type RuntimeTarget,
} from "@loopyc/core";
import { createRuntime, Journal } from "@loopyc/runtime";
import { formatScore, formatVerify, interpretLoop, scoreLoop, verifyLoop } from "@loopyc/verify";
import { inferScaffold } from "@loopyc/infer";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function loadOrError(yaml: string):
  | { ok: true; spec: NonNullable<ReturnType<typeof loadSpecFromYaml>["spec"]>; capsInjected: boolean }
  | { ok: false; message: string } {
  const r = loadSpecFromYaml(yaml);
  if (r.parseErrors) return { ok: false, message: `parse failed:\n${r.parseErrors.join("\n")}` };
  if (!r.validation!.ok) return { ok: false, message: `validation failed:\n${formatValidation(r.validation!)}` };
  return { ok: true, spec: r.spec!, capsInjected: r.capsInjected ?? false };
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

async function writePlanned(dir: string, files: PlannedFile[]): Promise<void> {
  for (const f of files) {
    const full = join(dir, f.relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.contents, "utf8");
    if (f.executable) await chmod(full, 0o755);
  }
}

/** A code fence longer than any backtick run inside the content (CommonMark-safe). */
function fence(s: string): string {
  const runs = s.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  return "`".repeat(Math.max(3, longest + 1));
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "loopc-mcp", version: "0.1.0" });

  server.tool(
    "get_loop_schema",
    "Return the LoopSpec v0.1 authoring guide (required fields, step kinds, the safe expression language, hard rules, and a post-generation checklist). Read this BEFORE authoring a loop.",
    {},
    async () => text(LOOPSPEC_GUIDE)
  );

  server.tool(
    "list_blueprints",
    "List the built-in starting-point loop blueprints (one per pattern: react, plan-execute-reflect, evaluator-optimizer, loop-until-dry, map-reduce, poll-until, cron).",
    {},
    async () => text(listBlueprints().map((b) => `${b.name.padEnd(22)} ${b.description}`).join("\n"))
  );

  server.tool(
    "new_loop",
    "Scaffold a LoopSpec YAML, either from a named blueprint (id substituted) or as a minimal template for the given pattern.",
    {
      id: z.string().describe("kebab-case loop id"),
      blueprint: z.string().optional(),
      pattern: z
        .enum(["react", "plan-execute-reflect", "evaluator-optimizer", "loop-until-dry", "map-reduce", "poll-until", "cron"])
        .optional(),
    },
    async ({ id, blueprint, pattern }) => {
      if (blueprint) {
        const bp = getBlueprint(blueprint);
        if (!bp) return text(`unknown blueprint '${blueprint}'. Use list_blueprints.`, true);
        return text(bp.yaml.replace(/^id:.*$/m, `id: ${id}`));
      }
      return text(minimalTemplate(id, pattern ?? "react"));
    }
  );

  server.tool(
    "validate_loop",
    "Validate a LoopSpec YAML: hard gates (termination required, exit reachable, bindings declared, safe expressions) plus soft warnings. Refuses unbounded/unreachable loops.",
    { yaml: z.string() },
    async ({ yaml }) => {
      const r = loadSpecFromYaml(yaml);
      if (r.parseErrors) return text(`parse failed:\n${r.parseErrors.join("\n")}`, true);
      return text(formatValidation(r.validation!), !r.validation!.ok);
    }
  );

  server.tool(
    "verify_loop",
    "Dry-run a LoopSpec through the real runtime with MOCKED effects (no side effects). Proves it is bounded-under-caps and deterministic on replay, then returns a graded scorecard.",
    { yaml: z.string() },
    async ({ yaml }) => {
      const r = loadOrError(yaml);
      if (!r.ok) return text(r.message, true);
      const report = await verifyLoop(r.spec, r.capsInjected);
      const card = scoreLoop(r.spec, report);
      return text(`${formatVerify(report)}\n\n${formatScore(card)}`, !report.ok);
    }
  );

  server.tool(
    "compile_loop",
    "Compile a validated LoopSpec to runnable artifact(s). With `out`, writes files to disk; otherwise returns the planned files inline. Target defaults to the spec's runtime (or standalone); use 'all' for both.",
    {
      yaml: z.string(),
      target: z.enum(["standalone", "babysitter", "claude-code", "n8n", "all"]).optional(),
      out: z.string().optional().describe("output directory; if omitted, files are returned inline"),
    },
    async ({ yaml, target, out }) => {
      const r = loadOrError(yaml);
      if (!r.ok) return text(r.message, true);
      const targets: RuntimeTarget[] =
        target === "all" ? [...SUPPORTED_TARGETS] : target ? [target] : [r.spec.target?.runtime ?? "standalone"];
      const blocks: string[] = [];
      for (const t of targets) {
        const plan = planLoopExport(r.spec, t);
        if (out) {
          const dir = join(out, t);
          await writePlanned(dir, plan.files);
          blocks.push(`✓ ${t}: wrote ${plan.files.length} files to ${dir}${plan.warnings.length ? `\n  warnings: ${plan.warnings.join("; ")}` : ""}`);
        } else {
          const files = plan.files
            .map((f) => {
              const fc = fence(f.contents);
              return `### ${t}/${f.relativePath}\n${fc}\n${f.contents}\n${fc}`;
            })
            .join("\n\n");
          blocks.push(`# target: ${t}${plan.warnings.length ? `\n> warnings: ${plan.warnings.join("; ")}` : ""}\n\n${files}`);
        }
      }
      return text(blocks.join("\n\n"));
    }
  );

  server.tool(
    "run_loop",
    "Run a LoopSpec with REAL effects. EXECUTES shell/http/agent steps with a minimal SCRUBBED env (PATH/HOME/etc., NOT the server's secrets) — both the shell subprocess AND the ${env.X} expression context see only the scrubbed env plus any values you pass in `env`. Still a real side-effecting run — pass confirm:true to proceed; prefer verify_loop for a safe dry-run. Returns the RunResult and the run directory.",
    {
      yaml: z.string(),
      inputs: z.record(z.unknown()).optional(),
      cwd: z.string().optional().describe("run directory (a temp dir is used if omitted)"),
      env: z.record(z.string()).optional().describe("explicit env values the loop may read via ${env.X} / shell (e.g. an API key); nothing else from the server's process env is exposed"),
      confirm: z.boolean().optional().describe("must be true to actually execute real side effects"),
    },
    async ({ yaml, inputs, cwd, env, confirm }) => {
      const r = loadOrError(yaml);
      if (!r.ok) return text(r.message, true);
      if (!confirm) {
        return text(
          "run_loop executes REAL shell/http/agent side effects (shell runs with a minimal scrubbed env, but still runs real commands). Re-call with confirm:true to proceed, or use verify_loop for a safe dry-run.",
          true
        );
      }
      const dir = cwd ?? mkdtempSync(join(tmpdir(), "loopy-run-"));
      // Build ONE scrubbed env (a safe baseline + caller-supplied values) and use it for BOTH
      // the shell subprocess (effectEnv) and the expression context (env). Passing only effectEnv
      // would leave the runtime's expr `env` defaulting to the full process.env, so a validated
      // `${env.OPENAI_API_KEY}` in a url/cmd/header would still exfiltrate the server's secrets.
      const allow = ["PATH", "HOME", "TMPDIR", "TEMP", "LANG", "LC_ALL", "SHELL"];
      const scrubbed: Record<string, string> = {};
      for (const k of allow) if (process.env[k] != null) scrubbed[k] = process.env[k]!;
      Object.assign(scrubbed, env ?? {});
      const result = await createRuntime(interpretLoop(r.spec), { cwd: dir, inputs, effectEnv: scrubbed, env: scrubbed }).run();
      return text(`run dir: ${dir}\n${JSON.stringify(result, null, 2)}`, result.status === "failed");
    }
  );

  server.tool(
    "infer_loop_scaffold",
    "Deterministically extract a FactPack from an existing script (JS/TS or bash) or a .loopy journal and return a DRAFT LoopSpec to complete. No LLM/side effects. The draft is a starting point — fill the TODOs, then validate_loop + verify_loop (verify proves bounded, not semantically faithful, so review it).",
    { source: z.string().describe("the script or journal CONTENT"), filename: z.string().optional().describe("filename hint for kind detection (e.g. watch.sh, poll.ts, events.jsonl)") },
    async ({ source, filename }) => {
      const { kind, factpack, draftYaml } = inferScaffold(filename ?? "input", source);
      const head =
        `# FactPack (${kind}, confidence ${factpack.confidence}) — pattern ${factpack.candidatePattern}, ${factpack.steps.length} step(s)\n` +
        (factpack.secretsFlagged.length ? `# WARNING: possible secrets: ${factpack.secretsFlagged.join(", ")}\n` : "") +
        factpack.notes.map((n) => `# · ${n}`).join("\n");
      return text(`${head}\n\n${draftYaml}`);
    }
  );

  server.tool(
    "inspect_run",
    "Inspect a loop run directory: its current status/iteration, the derived state, and the last journal events.",
    { dir: z.string(), tail: z.number().int().positive().optional(), runId: z.string().optional().describe("run id to inspect (default 'default')") },
    async ({ dir, tail, runId }) => {
      const rid = runId ?? "default";
      const journal = new Journal(dir, rid);
      if (!journal.exists()) return text(`no run journal found under ${dir}/.loopy/runs/${rid}`, true);
      const events = journal.load();
      const n = tail ?? 10;
      const last = events.slice(-n).map((e) => `  #${e.seq} ${e.type} ${JSON.stringify(e.data)}`).join("\n");
      const final = events.filter((e) => e.type === "iteration_snapshot").at(-1);
      const state = final ? JSON.stringify(final.data.state) : "(no snapshot yet)";
      return text(`events: ${events.length}\nlatest state: ${state}\n\nlast ${n} events:\n${last}`);
    }
  );

  return server;
}
