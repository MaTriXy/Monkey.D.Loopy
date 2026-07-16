/**
 * n8n adapter — best-effort export of a LoopSpec to an importable n8n workflow JSON.
 *
 * This is a SCAFFOLD, not a faithful runtime: n8n uses an item-passing execution model
 * (no shared mutable state, its own history), so our journal/caps/shared-state guarantees
 * do not map. But every step now lowers to a REAL node (http→httpRequest with headers+body,
 * agent→httpRequest to an OpenAI-compatible endpoint, breakpoint→Wait, reduce→SplitInBatches
 * with its body wired in a loop, sleep→Wait) and the `exit?` IF node gets a real lowered
 * condition from `terminate.until`. The remaining caveats (state mapping, expression syntax,
 * cap enforcement) are flagged in the README + node notes and in the capability matrix.
 */
import type { Adapter, PlanResult, PlannedFile } from "./types.js";
import { capabilityWarnings } from "./types.js";
import { parseDuration } from "../duration.js";
import { parseGuard, type ExprNode } from "../expr.js";
import type { LoopSpec, Step } from "../types.js";

/** POSIX single-quote — n8n's executeCommand runs via a shell, so argv must be quoted. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const BIN_N8N: Record<string, string> = {
  "==": "===", "!=": "!==", "&&": "&&", "||": "||",
  "<": "<", "<=": "<=", ">": ">", ">=": ">=", "+": "+", "-": "-", "*": "*", "/": "/", "%": "%",
};

/** Best-effort lowering of a Loopy reference to an n8n expression fragment. */
function n8nRef(path: string[]): string {
  const [root, ...rest] = path;
  if (root === "iteration") return "$runIndex";
  if (root === "env") return rest.length ? `$env.${rest.join(".")}` : "$env";
  // state / inputs / meta / item / unknown all map to the current item (best-effort).
  return rest.length ? `$json.${rest.join(".")}` : "$json";
}

/** Lower an expression AST to an n8n expression body (inside `={{ ... }}`). */
function n8nExpr(node: ExprNode): string {
  switch (node.k) {
    case "lit":
      return JSON.stringify(node.v);
    case "ref":
      return n8nRef(node.path);
    case "unary":
      return node.op === "!" ? `!(${n8nExpr(node.e)})` : `-(${n8nExpr(node.e)})`;
    case "bin":
      if (node.op === "in") return `(${n8nExpr(node.r)}).includes(${n8nExpr(node.l)})`;
      return `(${n8nExpr(node.l)} ${BIN_N8N[node.op]} ${n8nExpr(node.r)})`;
  }
}

/** Build the IF node's `conditions` from terminate.until — a real single-boolean condition,
 *  or null when the expression can't be parsed (caller falls back to an empty + noted condition). */
function lowerUntil(until: string): Record<string, unknown> | null {
  try {
    const expr = n8nExpr(parseGuard(until));
    return {
      options: { caseSensitive: true, typeValidation: "loose" },
      combinator: "and",
      conditions: [
        {
          id: "exit",
          leftValue: `={{ ${expr} }}`,
          rightValue: "",
          operator: { type: "boolean", operation: "true", singleValue: true },
        },
      ],
    };
  } catch {
    return null;
  }
}

interface N8nNode {
  parameters: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  notes?: string;
}

function nodeFor(step: Step, x: number, y: number): N8nNode {
  const base = { id: step.id, name: step.id, position: [x, y] as [number, number] };
  switch (step.kind) {
    case "http": {
      const p: Record<string, unknown> = { url: step.request.url, method: step.request.method, options: {} };
      const headers = step.request.headers ?? {};
      if (Object.keys(headers).length) {
        p.sendHeaders = true;
        p.headerParameters = { parameters: Object.entries(headers).map(([name, value]) => ({ name, value })) };
      }
      if (step.request.body !== undefined) {
        p.sendBody = true;
        p.specifyBody = "json";
        p.jsonBody = typeof step.request.body === "string" ? step.request.body : JSON.stringify(step.request.body, null, 2);
      }
      const note = "Rewrite any ${state.x}/${inputs.y} to n8n {{ }} expressions.";
      return { ...base, type: "n8n-nodes-base.httpRequest", typeVersion: 4, parameters: p, notes: note };
    }
    case "shell":
      return {
        ...base,
        type: "n8n-nodes-base.executeCommand",
        typeVersion: 1,
        parameters: { command: step.args ? [step.cmd, ...step.args.map(shQuote)].join(" ") : step.cmd },
      };
    case "sleep": {
      if (step.until) {
        return {
          ...base,
          type: "n8n-nodes-base.wait",
          typeVersion: 1,
          parameters: { amount: 60, unit: "seconds" },
          notes: `sleep until ${step.until} — n8n's Wait can't poll a predicate; this is a 60s placeholder. Wire a Wait→IF poll loop for the real condition.`,
        };
      }
      const seconds = step.for ? Math.max(1, Math.round(parseDuration(step.for) / 1000)) : 60;
      return { ...base, type: "n8n-nodes-base.wait", typeVersion: 1, parameters: { amount: seconds, unit: "seconds" } };
    }
    case "agent":
      // a real OpenAI-compatible chat completion (mirrors the runtime `llm` harness).
      return {
        ...base,
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4,
        parameters: {
          method: "POST",
          url: "={{ ($env.LOOPY_LLM_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions' }}",
          sendHeaders: true,
          headerParameters: {
            parameters: [
              { name: "Authorization", value: "=Bearer {{ $env.LOOPY_LLM_API_KEY }}" },
              { name: "content-type", value: "application/json" },
            ],
          },
          sendBody: true,
          specifyBody: "json",
          jsonBody: JSON.stringify(
            { model: "gpt-4o-mini", messages: [{ role: "user", content: step.prompt }] },
            null,
            2
          ),
          options: {},
        },
        notes: `agent (${step.harness}): set the model/key via $env.LOOPY_LLM_*; read the reply at {{ $json.choices[0].message.content }}. Rewrite \${...} in the prompt to {{ }}.`,
      };
    case "breakpoint":
      // a real human gate: pause until resumed via the node's webhook.
      return {
        ...base,
        type: "n8n-nodes-base.wait",
        typeVersion: 1.1,
        parameters: { resume: "webhook", options: {} },
        notes: `human gate: ${step.ask} — resume via this node's webhook (or swap for a Form/approval node).`,
      };
    case "reduce":
      // Loop Over Items: the body is wired through the 'loop' output and back; 'done' continues.
      return {
        ...base,
        type: "n8n-nodes-base.splitInBatches",
        typeVersion: 3,
        parameters: { options: {} },
        notes: `reduce over ${step.over}: rewrite the source to an n8n collection feeding this node. Each item runs the body (loop output) and returns here; 'done' continues the chain.`,
      };
  }
}

function buildWorkflow(spec: LoopSpec): unknown {
  const isCron = spec.schedule?.mode === "cron";
  const trigger: N8nNode = isCron
    ? {
        id: "trigger",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1,
        position: [0, 300],
        parameters: { rule: { interval: [{ field: "cronExpression", expression: spec.schedule?.cron ?? "0 * * * *" }] } },
      }
    : { id: "trigger", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 300], parameters: {} };

  const nodes: N8nNode[] = [trigger];
  const mainNames: string[] = [trigger.name];
  const reduceBodies: { sib: string; bodyNames: string[] }[] = [];
  let x = 280;

  for (const step of spec.body) {
    const node = nodeFor(step, x, 300);
    x += 280;
    nodes.push(node);
    mainNames.push(node.name);
    if (step.kind === "reduce") {
      const bodyNames: string[] = [];
      let bx = node.position[0];
      for (const b of step.body) {
        const bn = nodeFor(b, bx, 540);
        bx += 280;
        nodes.push(bn);
        bodyNames.push(bn.name);
      }
      reduceBodies.push({ sib: node.name, bodyNames });
    }
  }

  const conditions = lowerUntil(spec.terminate.until);
  const ifNode: N8nNode = {
    id: "exit",
    name: "exit?",
    type: "n8n-nodes-base.if",
    typeVersion: 2,
    position: [x + 280, 300],
    parameters: { conditions: conditions ?? { conditions: [] } },
    notes:
      `Exit when: ${spec.terminate.until}. true → stop; false → loop back. ` +
      (conditions
        ? `Condition lowered to an n8n expression (best-effort: state/inputs map to the current item — review it).`
        : `Couldn't auto-lower the predicate; fill the condition manually.`) +
      ` n8n won't enforce max_iterations=${spec.caps.max_iterations}, so add a stop guard.`,
  };
  nodes.push(ifNode);
  mainNames.push(ifNode.name);

  const conn = (to: string) => ({ main: [[{ node: to, type: "main", index: 0 }]] });
  const connections: Record<string, unknown> = {};
  const reduceMap = new Map(reduceBodies.map((r) => [r.sib, r.bodyNames]));

  // main chain: sequential, with a SplitInBatches 'done' output (index 0) continuing the chain
  // and its 'loop' output (index 1) entering the body.
  for (let i = 0; i < mainNames.length - 1; i++) {
    const cur = mainNames[i]!;
    const next = mainNames[i + 1]!;
    if (reduceMap.has(cur)) {
      const bodyNames = reduceMap.get(cur)!;
      connections[cur] = {
        main: [
          [{ node: next, type: "main", index: 0 }],
          bodyNames.length ? [{ node: bodyNames[0]!, type: "main", index: 0 }] : [],
        ],
      };
    } else {
      connections[cur] = conn(next);
    }
  }
  // reduce body chains: body[j] → body[j+1], last → back to the SplitInBatches node
  for (const { sib, bodyNames } of reduceBodies) {
    for (let j = 0; j < bodyNames.length - 1; j++) connections[bodyNames[j]!] = conn(bodyNames[j + 1]!);
    if (bodyNames.length) connections[bodyNames[bodyNames.length - 1]!] = conn(sib);
  }
  // IF: output 0 (true) → end; output 1 (false) → first step (loop back).
  const firstStep = mainNames[1] !== ifNode.name ? mainNames[1]! : null;
  connections[ifNode.name] = { main: [[], firstStep ? [{ node: firstStep, type: "main", index: 0 }] : []] };

  return { name: spec.id, nodes, connections, active: false, settings: {}, meta: { generatedBy: "monkey-d-loopy" } };
}

function emitReadme(spec: LoopSpec): string {
  return `# ${spec.meta?.name ?? spec.id} (n8n target)

> Generated by **Monkey D Loopy**. A best-effort **scaffold** of an importable n8n workflow.

Import \`${spec.id}.n8n.json\` into n8n (Workflows → Import from File).

Every step lowers to a **real node** (http→HTTP Request with headers+body, agent→HTTP Request to
an OpenAI-compatible endpoint, breakpoint→Wait, reduce→Loop Over Items, sleep→Wait), and the
\`exit?\` IF node carries a lowered condition from your \`terminate.until\`.

**Still a scaffold, not a faithful runtime.** n8n's execution model (item-passing, its own
history) does not map to Loopy's journal/caps/shared-state guarantees. Review:
- the **exit condition** in the \`exit?\` IF node — state/inputs were mapped to the current item
  (\`$json\`) as a best guess; n8n will **not** enforce \`max_iterations=${spec.caps.max_iterations}\`,
  so add a stop guard;
- **\${...} expressions** in URLs/prompts/headers — rewrite to n8n's \`{{ }}\` syntax;
- **shared state** — n8n has none; thread values via the item or Static Data / a Code node;
- the **agent** node — set \`$env.LOOPY_LLM_*\` and read the reply at
  \`{{ $json.choices[0].message.content }}\`.

For hard termination + cost caps + crash-resume, use the \`standalone\` target instead.
`;
}

export const n8nAdapter: Adapter = {
  target: "n8n",
  plan(spec: LoopSpec): PlanResult {
    const files: PlannedFile[] = [
      { relativePath: `${spec.id}.n8n.json`, contents: JSON.stringify(buildWorkflow(spec), null, 2) + "\n", kind: "config" },
      { relativePath: "README.md", contents: emitReadme(spec), kind: "doc" },
      {
        relativePath: "loop.lock",
        contents:
          JSON.stringify({ loop_id: spec.id, loopspec_version: spec.loopspec, target: "n8n", recipe: spec.provenance?.recipe, signal: spec.terminate.signal, caps: spec.caps }, null, 2) + "\n",
        kind: "provenance",
      },
    ];
    return { target: "n8n", files, warnings: capabilityWarnings(spec, "n8n") };
  },
};
