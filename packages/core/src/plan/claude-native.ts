/**
 * Claude-native adapter. Lowers a LoopSpec into a project-scope Claude Code skill at
 * `.claude/skills/<name>/SKILL.md`, so the loop is invokable as `/<name>` inside Claude Code.
 *
 * This target is a UX/native-integration layer, not a new runtime. The generated skill can
 * delegate to a sibling standalone artifact when present; otherwise Claude executes the loop
 * from the embedded contract and must honor caps itself. Capability warnings stay soft.
 */
import type { Adapter, PlanResult, PlannedFile } from "./types.js";
import { capabilityWarnings } from "./types.js";
import type { LoopSpec, Step } from "../types.js";

function skillSlug(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
  return slug || "loopy-loop";
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function mdEscape(s: string): string {
  return s.replace(/[`\\]/g, "\\$&");
}

function whenSuffix(step: Step): string {
  return step.when ? ` when \`${mdEscape(step.when)}\`` : "";
}

function saveSuffix(save?: Record<string, string>): string {
  if (!save || Object.keys(save).length === 0) return "";
  return ` Save ${Object.entries(save).map(([k, v]) => `\`${mdEscape(v)}\` to \`state.${k}\``).join(", ")}.`;
}

function stepLine(step: Step, indent = ""): string[] {
  const id = `\`${step.id}\``;
  switch (step.kind) {
    case "agent":
      return [`${indent}- ${id}: run agent harness \`${step.harness}\`${whenSuffix(step)} with prompt: ${step.prompt}${saveSuffix(step.save)}`];
    case "shell":
      return [`${indent}- ${id}: run shell command \`${mdEscape(step.args ? [step.cmd, ...step.args].join(" ") : step.cmd)}\`${whenSuffix(step)}.${saveSuffix(step.save)}`];
    case "http":
      return [`${indent}- ${id}: call HTTP ${step.request.method} \`${mdEscape(step.request.url)}\`${whenSuffix(step)}.${saveSuffix(step.save)}`];
    case "breakpoint":
      return [`${indent}- ${id}: pause for approval${whenSuffix(step)}. Ask: "${step.ask}"`];
    case "sleep":
      return [`${indent}- ${id}: ${step.for ? `wait ${step.for}` : `wait until \`${mdEscape(step.until!)}\``}${whenSuffix(step)}.`];
    case "reduce": {
      const head = `${indent}- ${id}: for each \`${step.as ?? "item"}\` in \`${mdEscape(step.over)}\`${whenSuffix(step)}:`;
      return [head, ...step.body.flatMap((s) => stepLine(s, `${indent}  `))];
    }
  }
}

function emitSkill(spec: LoopSpec, slug: string): string {
  const inputs = Object.entries(spec.inputs ?? {}).map(([k, v]) => `\`${k}\` (${v.type}${v.required ? ", required" : ""})`).join(", ") || "none";
  const state = Object.entries(spec.state?.vars ?? {}).map(([k, v]) => `\`${k}\` = ${JSON.stringify(v.init)}`).join(", ") || "none";
  const caps = [
    `max_iterations=${spec.caps.max_iterations}`,
    spec.caps.no_progress ? `no_progress=${spec.caps.no_progress.max_repeats} repeats of ${spec.caps.no_progress.fingerprint}` : undefined,
    spec.caps.budget ? `budget=${JSON.stringify(spec.caps.budget)}` : undefined,
  ].filter(Boolean).join("; ");
  const changedName = slug !== spec.id ? `\n- Original LoopSpec id: \`${spec.id}\`; Claude command name: \`/${slug}\`.` : "";
  const skillDescription = `Run the generated Monkey D Loopy loop "${spec.id}" from Claude Code. Invoke manually as /${slug}; use when the user wants to run, step, resume, inspect, or manage this loop.`;

  return `---
name: ${JSON.stringify(slug)}
description: ${JSON.stringify(skillDescription)}
argument-hint: "[run|step|resume|inspect|doctor|approve|native] [inputs]"
disable-model-invocation: true
---

# ${spec.meta?.name ?? spec.id} — Claude-native Loopy loop

This is a generated Claude Code skill. It gives the loop a native slash command, \`/${slug}\`, while preserving the LoopSpec contract in [reference/loopspec.json](reference/loopspec.json).
${changedName}

## Invocation

Interpret \`$ARGUMENTS\` as a command plus optional JSON inputs.

- No command or \`run\`: run the loop to completion or a cap.
- \`step\`: advance one iteration.
- \`resume\`: resume after a wait, pause, or crash.
- \`approve\`: approve a pending cap breakpoint and resume.
- \`inspect\`: show where the runtime journal lives so you can read and summarize it.
- \`doctor\`: preflight the loop.
- \`native\`: execute from the contract below even if no standalone artifact is available.

## Preferred hybrid path

First try to delegate to the Loopy standalone runtime, because it enforces journal, replay, caps, durable sleep, and budget behavior. Run this command with the requested action:

\`\`\`bash
node "\${CLAUDE_SKILL_DIR}/scripts/run-standalone.mjs" <command> '<inputs-json>'
\`\`\`

If the command reports that no standalone artifact was found, continue with the Claude-native fallback below.

## Claude-native fallback

When running without a standalone artifact, you are the executor. Follow this contract exactly:

- Pattern: \`${spec.pattern}\`
- Inputs: ${inputs}
- Initial state: ${state}
- Exit when: \`${spec.terminate.until}\` (signal: \`${spec.terminate.signal}\`)
- Caps: ${caps}
- Cap action: \`${spec.caps.on_cap_exceeded ?? "breakpoint"}\`
- Schedule mode: \`${spec.schedule?.mode ?? "manual"}\`

Each iteration:
${spec.body.flatMap((s) => stepLine(s)).join("\n")}

After each iteration, update state, append a short entry to \`.loopy/claude-native/${slug}/journal.md\`, then re-check the exit predicate. Stop immediately when the exit predicate is true or a cap is hit. For any cap with action \`breakpoint\`, pause and ask the user before continuing.

## Guardrails

- Do not silently run forever. If the exit predicate is not satisfied, caps still stop the loop.
- Prefer external evidence for done checks. Treat agent self-reports as weak unless the LoopSpec declares that as the signal.
- Do not invent undeclared inputs or state variables; ask for missing required inputs.
- If the user asks for hard guarantees, use or create the standalone target instead of pure Claude-native fallback.
`;
}

function emitRunner(spec: LoopSpec, slug: string): string {
  return `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] || "run";
const inputArg = process.argv.slice(3).join(" ").trim();
const loopId = ${JSON.stringify(spec.id)};
const slug = ${JSON.stringify(slug)};
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const skillDir = process.env.CLAUDE_SKILL_DIR || resolve(__dirname, "..");

const candidates = [
  process.env.LOOPY_ARTIFACT_DIR,
  // target-all layout: <out>/claude-native/.claude/skills/<slug>/scripts -> <out>/standalone
  resolve(skillDir, "..", "..", "..", "..", "standalone"),
  resolve(projectDir, ".loopy", "compiled", loopId, "standalone"),
  resolve(projectDir, ".loopy", "compiled", slug, "standalone"),
  resolve(projectDir, ".loopy-artifacts", loopId, "standalone"),
  resolve(projectDir, ".loopy-artifacts", slug, "standalone"),
  resolve(projectDir, "out", loopId, "standalone"),
  resolve(projectDir, "out", slug, "standalone"),
].filter(Boolean);

const dir = candidates.find((c) => existsSync(join(c, "loop.mjs")));
if (!dir) {
  console.error("No standalone Loopy artifact found for '" + loopId + "'.");
  console.error("Set LOOPY_ARTIFACT_DIR or compile with: loopc compile <spec> --target all --out <dir>");
  process.exit(2);
}

if (inputArg) {
  try {
    const inputs = JSON.parse(inputArg);
    writeFileSync(join(dir, "inputs.json"), JSON.stringify(inputs, null, 2) + "\\n");
  } catch (e) {
    console.error("Invalid inputs JSON: " + e.message);
    process.exit(2);
  }
}

if (command === "inspect") {
  console.log("Artifact: " + dir);
  console.log("Journal:  " + join(dir, ".loopy", "runs", "default"));
  process.exit(0);
}

const runtimeCommand = command === "approve" ? "resume" : command;
const args = ["loop.mjs", runtimeCommand];
if (command === "approve") args.push("--approve");

const result = spawnSync(process.execPath, args, { cwd: dir, stdio: "inherit" });
process.exit(result.status ?? 1);
`;
}

function emitReadme(spec: LoopSpec, slug: string): string {
  return `# ${spec.id} — Claude-native Loopy target

This target installs a Claude Code project skill. Copy the generated \`.claude/\` directory into
the repository where you want the loop available, then start Claude Code from that project and run:

\`\`\`text
/${slug} run
/${slug} step
/${slug} inspect
\`\`\`

## Files

\`\`\`text
.claude/skills/${slug}/SKILL.md
.claude/skills/${slug}/reference/loopspec.json
.claude/skills/${slug}/loop.lock
.claude/skills/${slug}/scripts/run-standalone.mjs
README.md
loop.lock
loop.source.yaml        # written by loopc compile
\`\`\`

Claude Code discovers project skills from \`.claude/skills/<skill-name>/SKILL.md\`. The skill
directory name becomes the slash command, so this loop is invoked as \`/${slug}\`.

## Inputs

Pass inputs as JSON after the command:

\`\`\`text
/${slug} run '{"input_name":"value"}'
\`\`\`

The generated skill supports \`run\`, \`step\`, \`resume\`, \`inspect\`, \`doctor\`, \`approve\`,
and \`native\`.

## Runtime guarantees

For hard Loopy guarantees, compile a standalone target next to this target:

\`\`\`bash
loopc compile ${spec.id}.loop.yaml --target all --out ./out/${spec.id}
\`\`\`

The skill first tries to delegate to the sibling standalone artifact. If none is found, Claude can
execute the embedded LoopSpec contract directly, but caps, state updates, and journal discipline
are then agent-honored rather than runtime-enforced.

If the standalone artifact lives somewhere else, set \`LOOPY_ARTIFACT_DIR\` to the directory that
contains \`loop.mjs\`.
`;
}

export const claudeNativeAdapter: Adapter = {
  target: "claude-native",
  plan(spec: LoopSpec): PlanResult {
    const slug = skillSlug(spec.id);
    const skillRoot = `.claude/skills/${slug}`;
    const lock = { loop_id: spec.id, skill_name: slug, loopspec_version: spec.loopspec, target: "claude-native", signal: spec.terminate.signal, caps: spec.caps };
    const files: PlannedFile[] = [
      { relativePath: `${skillRoot}/SKILL.md`, contents: emitSkill(spec, slug), kind: "skill" },
      { relativePath: `${skillRoot}/reference/loopspec.json`, contents: json(spec) + "\n", kind: "config" },
      { relativePath: `${skillRoot}/loop.lock`, contents: json(lock) + "\n", kind: "provenance" },
      { relativePath: `${skillRoot}/scripts/run-standalone.mjs`, contents: emitRunner(spec, slug), kind: "asset", executable: true },
      { relativePath: "README.md", contents: emitReadme(spec, slug), kind: "doc" },
      { relativePath: "loop.lock", contents: json(lock) + "\n", kind: "provenance" },
    ];
    return { target: "claude-native", files, warnings: capabilityWarnings(spec, "claude-native") };
  },
};
