/**
 * Compact, LLM-friendly serialization of a LoopSpec ("TOON"-style: token-oriented,
 * indentation-based) plus a hand-written authoring guide. The MCP `get_loop_schema`
 * tool (M2) serves LOOPSPEC_GUIDE so agents author specs reliably instead of guessing.
 *
 * v0.1 emits a compact YAML-compatible form; a stricter TOON encoder can replace
 * toToon() later without changing call sites.
 */

const BARE_STRING_RE = /^[A-Za-z0-9_./:+\-${}]+$/;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return BARE_STRING_RE.test(s) && s.length > 0 ? s : JSON.stringify(s);
}

function isScalar(v: unknown): boolean {
  return v === null || ["number", "boolean", "string"].includes(typeof v);
}

export function toToon(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (isScalar(value)) return scalar(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isScalar)) return `[${value.map(scalar).join(", ")}]`;
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scalar(item)}`;
        const block = toToon(item, indent + 1).replace(/^ {2}/, "");
        return `${pad}- ${block.trimStart()}`;
      })
      .join("\n");
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return entries
    .map(([k, v]) => {
      if (isScalar(v)) return `${pad}${k}: ${scalar(v)}`;
      if (Array.isArray(v) && v.every(isScalar)) return `${pad}${k}: ${toToon(v, indent)}`;
      return `${pad}${k}:\n${toToon(v, indent + 1)}`;
    })
    .join("\n");
}

export const LOOPSPEC_GUIDE = `# LoopSpec v0.1 — authoring guide

A LoopSpec declares ONE bounded agent loop. The compiler REFUSES to emit an
unbounded loop: \`terminate\` is required and \`caps\` are mandatory (auto-injected
if omitted, but you should set them deliberately).

## Required fields
- loopspec: "0.1"
- id: kebab-case identifier
- pattern: react | plan-execute-reflect | evaluator-optimizer | loop-until-dry | map-reduce | poll-until | cron
- body: list of steps (>=1)
- terminate: { signal, until }   # signal: oracle > state-predicate > llm-judge > self-assess

## Step kinds (closed set — no raw code)
- agent:      { id, kind: agent, harness, prompt, allowed-tools?, save?, on_done? }
- shell:      { id, kind: shell, cmd, save?, on_done? }
- http:       { id, kind: http, request: { method, url, headers?, body? }, save?, on_done? }
- breakpoint: { id, kind: breakpoint, ask, strategy?, auto_approve_in? }
- sleep:      { id, kind: sleep, for?: "5m" | until?: "\${...}" }   # exactly one of for/until
- reduce:     { id, kind: reduce, over: "\${...}", as?, body: [...] }   # body may on_done.append into a list

## State, inputs, expressions
- state.vars: { name: { type, init } }   types: string|int|number|boolean|json|list|enum[a,b,c]
- inputs:     { name: { type, required?, default? } }
- names (ids, state vars, inputs, aliases) must be safe identifiers — they are lowered into code.
- Expressions use \${...} with: state.x, inputs.y, env.Z, meta.m, iteration, item.
  Operators: == != < <= > >= && || ! and or not in + - * / %  (no function calls).
- save uses json-path: { stateVar: "$.path.into.response" }   (agent save reads the agent's result envelope)
- on_done: { incr: stateVar } | { set: { stateVar: value-or-\${expr} } } | { append: { listVar: value-or-\${expr} } }

## Caps (mandatory)
- caps: { max_iterations, no_progress?: { fingerprint, max_repeats }, budget?: { tokens, usd, wallclock }, on_cap_exceeded?: fail|breakpoint|exit-clean }

## Resilience (optional)
- retry: { max, backoff_ms }   # transient http/shell/agent failures retry with exponential backoff

## Hard rules the validator enforces
1. terminate present; until references a signal that some step can change (else unreachable).
2. self-assess termination requires explicit caps.
3. every reference (state/inputs) must be declared; every save/on_done target must be declared.
4. exactly one of sleep.for / sleep.until.
5. expressions must be in the safe subset (no calls / unknown roots).

## Post-generation checklist
- [ ] Is the termination signal the STRONGEST available (prefer oracle/state-predicate)?
- [ ] Does a step actually write the var(s) the exit predicate reads?
- [ ] Are caps set to your real cost tolerance (not just defaults)?
- [ ] For poll/loop-until-dry: is there a no_progress fingerprint to catch thrash?
`;
