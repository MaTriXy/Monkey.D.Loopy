/**
 * Structural parse layer (zod). This catches gross shape errors and misspelled
 * top-level keys, then hands a permissive RawLoopSpec to normalize() + validate(),
 * which produce friendly, domain-specific diagnostics (e.g. "termination predicate
 * required") rather than raw zod noise.
 *
 * terminate and caps are OPTIONAL here on purpose: missing termination is a
 * first-class validator error, and caps are auto-injected during normalization.
 */
import { z } from "zod";

const httpRequest = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

const onDone = z.object({
  incr: z.string().optional(),
  set: z.record(z.unknown()).optional(),
  append: z.record(z.unknown()).optional(),
});

const stepBase = {
  id: z.string().min(1),
  when: z.string().optional(),
};

const agentStep = z.object({
  ...stepBase,
  kind: z.literal("agent"),
  harness: z.string().min(1),
  prompt: z.string().min(1),
  "allowed-tools": z.array(z.string()).optional(),
  save: z.record(z.string()).optional(),
  on_done: onDone.optional(),
});

const shellStep = z.object({
  ...stepBase,
  kind: z.literal("shell"),
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  save: z.record(z.string()).optional(),
  on_done: onDone.optional(),
});

const httpStep = z.object({
  ...stepBase,
  kind: z.literal("http"),
  request: httpRequest,
  // opt-in: deliver a { status, ok, headers, body } envelope instead of the bare body,
  // so `save` can read `$.status` / `$.ok` / `$.body.field`.
  envelope: z.boolean().optional(),
  save: z.record(z.string()).optional(),
  on_done: onDone.optional(),
});

const breakpointStep = z.object({
  ...stepBase,
  kind: z.literal("breakpoint"),
  ask: z.string().min(1),
  strategy: z.enum(["single", "first-wins", "quorum"]).optional(),
  auto_approve_in: z.array(z.string()).optional(),
});

const sleepStep = z.object({
  ...stepBase,
  kind: z.literal("sleep"),
  for: z.string().optional(),
  until: z.string().optional(),
});

// reduce contains nested steps; declared lazily so the union can reference itself.
const stepUnion: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    agentStep,
    shellStep,
    httpStep,
    breakpointStep,
    sleepStep,
    reduceStep,
  ])
);

const reduceStep = z.object({
  ...stepBase,
  kind: z.literal("reduce"),
  over: z.string().min(1),
  as: z.string().optional(),
  body: z.array(stepUnion),
});

const exitAction = z.object({
  kind: z.enum(["shell", "http", "agent"]),
  cmd: z.string().optional(),
  request: httpRequest.optional(),
  envelope: z.boolean().optional(),
  harness: z.string().optional(),
  prompt: z.string().optional(),
});

const terminate = z.object({
  signal: z.enum(["oracle", "state-predicate", "llm-judge", "self-assess"]),
  until: z.string().min(1),
  on_exit: exitAction.optional(),
});

const caps = z.object({
  max_iterations: z.number().int().positive(),
  no_progress: z
    .object({ fingerprint: z.string().min(1), max_repeats: z.number().int().positive() })
    .optional(),
  budget: z
    .object({
      tokens: z.number().int().positive().optional(),
      usd: z.number().positive().optional(),
      wallclock: z.string().optional(),
    })
    .optional(),
  on_cap_exceeded: z.enum(["fail", "breakpoint", "exit-clean"]).optional(),
});

const inputDecl = z.object({
  type: z.string().min(1),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

const stateVarDecl = z.object({
  type: z.string().min(1),
  init: z.unknown(),
  description: z.string().optional(),
});

export const LoopSpecSchema = z
  .object({
    loopspec: z.string(),
    id: z.string().min(1),
    meta: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
        description: z.string().optional(),
      })
      .optional(),
    pattern: z.enum([
      "react",
      "plan-execute-reflect",
      "evaluator-optimizer",
      "loop-until-dry",
      "map-reduce",
      "poll-until",
      "cron",
    ]),
    provenance: z
      .object({
        factory_version: z.string().optional(),
        source: z.string().optional(),
        run_id: z.string().optional(),
        recipe: z.object({ name: z.string().min(1), version: z.string().min(1) }).optional(),
      })
      .optional(),
    target: z
      .object({
        runtime: z.enum(["standalone", "babysitter", "claude-code", "claude-native", "n8n"]).optional(),
        emit: z.array(z.enum(["cli", "skill", "doctor"])).optional(),
      })
      .optional(),
    inputs: z.record(inputDecl).optional(),
    state: z
      .object({
        store: z.enum(["journal", "memory"]).optional(),
        vars: z.record(stateVarDecl),
      })
      .optional(),
    body: z.array(stepUnion).min(1),
    terminate: terminate.optional(),
    caps: caps.optional(),
    schedule: z
      .object({ mode: z.enum(["manual", "cron", "watch", "forever"]), cron: z.string().optional() })
      .optional(),
    artifacts: z
      .object({
        include: z.array(z.string().min(1)).min(1),
        exclude: z.array(z.string().min(1)).optional(),
        max_files: z.number().int().positive().max(10_000).optional(),
        max_bytes: z.number().int().positive().max(1_000_000_000).optional(),
      })
      .strict()
      .optional(),
    notify: z
      .object({
        policy: z.enum(["never", "on-change", "on-failure", "always"]),
        channels: z.array(z.string().min(1)).max(32),
      })
      .strict()
      .optional(),
    retry: z
      .object({ max: z.number().int().nonnegative().optional(), backoff_ms: z.number().int().positive().optional() })
      .optional(),
    gates: z
      .array(
        z.object({
          after: z.string().optional(),
          when: z.string().optional(),
          ask: z.string().min(1),
          strategy: z.enum(["single", "first-wins", "quorum"]).optional(),
          auto_approve_in: z.array(z.string()).optional(),
        })
      )
      .optional(),
    observe: z
      .object({
        trace: z.enum(["journal", "none"]).optional(),
        hooks: z.record(z.unknown()).optional(),
        notify: z.record(z.unknown()).optional(),
      })
      .optional(),
  })
  .strict();

export type RawLoopSpec = z.infer<typeof LoopSpecSchema>;

export interface ParseOk {
  ok: true;
  data: RawLoopSpec;
}
export interface ParseErr {
  ok: false;
  errors: string[];
}

/** Structurally parse an already-deserialized object (from YAML/JSON). */
export function parseLoopSpec(raw: unknown): ParseOk | ParseErr {
  const result = LoopSpecSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const errors = result.error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return { ok: false, errors };
}
