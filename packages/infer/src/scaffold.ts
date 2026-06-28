/** Turn a FactPack into a DRAFT LoopSpec YAML — a starting point the /loopy skill completes
 *  and runs through validate→verify→score. It is not guaranteed to validate as-is. */
import type { FactPack, FactStep } from "./factpack.js";

function stepYaml(s: FactStep, i: number, sleepHint?: string): string {
  const id = `s${i}`;
  switch (s.kind) {
    case "http":
      return `  - { id: ${id}, kind: http, request: { method: GET, url: "TODO" } }   # from: ${trunc(s.detail)}`;
    case "shell":
      return `  - { id: ${id}, kind: shell, cmd: ${JSON.stringify(trunc(s.detail, 120))} }`;
    case "agent":
      return `  - { id: ${id}, kind: agent, harness: cli, prompt: "TODO: ${trunc(s.detail)}" }   # harness: cli (any coding agent via LOOPY_AGENT_CMD) | llm`;
    case "sleep":
      return `  - { id: ${id}, kind: sleep, for: "${sleepHint ?? "5m"}" }`;
  }
}

function trunc(s: string, n = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

export function scaffoldYaml(factpack: FactPack, id: string): string {
  const inputs = factpack.inputs.length
    ? "\ninputs:\n" + factpack.inputs.map((n) => `  ${n}: { type: string, required: true }`).join("\n")
    : "";
  const stateVars = [
    ...factpack.state.map((n) => `    ${n}: { type: json, init: null }`),
    "    done: { type: boolean, init: false }   # TODO: a real signal a step writes",
  ].join("\n");
  const steps = factpack.steps.length
    ? factpack.steps.map((s, i) => stepYaml(s, i, factpack.sleepHint)).join("\n")
    : '  - { id: work, kind: agent, harness: cli, prompt: "TODO: describe one iteration" }   # harness: cli (any coding agent via LOOPY_AGENT_CMD) | llm';
  const sleepStep = factpack.sleepHint && !factpack.steps.some((s) => s.kind === "sleep") ? `\n  - { id: wait, kind: sleep, for: "${factpack.sleepHint}" }` : "";
  const secretNote = factpack.secretsFlagged.length
    ? `\n# WARNING: possible secrets in the source — DO NOT inline; pass as inputs/env: ${factpack.secretsFlagged.join(", ")}`
    : "";

  return `# DRAFT inferred from a ${factpack.source} source (confidence: ${factpack.confidence}). REVIEW before use.
# ${factpack.notes.join("\n# ")}${secretNote}
loopspec: "0.1"
id: ${id}
meta: { name: ${id}, description: "Inferred draft — complete the TODOs, then validate + verify." }
pattern: ${factpack.candidatePattern}${inputs}

state:
  store: journal
  vars:
${stateVars}

body:
${steps}${sleepStep}

terminate:
  signal: state-predicate          # TODO: pick the STRONGEST real signal (prefer an oracle)
  until: "\${state.done == true}"   # TODO: real exit.${factpack.terminateHint ? ` loop-condition hint → exit when: ${trunc(factpack.terminateHint, 80)}` : ""}

caps:
  max_iterations: 50
  budget: { tokens: 200000, usd: 5.0, wallclock: "1h" }
  on_cap_exceeded: breakpoint
`;
}
