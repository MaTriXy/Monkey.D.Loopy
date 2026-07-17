/**
 * Normalization: fill defaults and AUTO-INJECT caps so the downstream contract is
 * uniform. Caps are mandatory — if the author omitted them we inject sane,
 * per-pattern defaults and record that we did (the validator uses this to decide
 * whether a weak termination signal is acceptable).
 */
import type { Caps, LoopPattern, LoopSpec } from "./types.js";
import { LOOPSPEC_VERSION } from "./types.js";
import type { RawLoopSpec } from "./schema.js";

export interface NormalizedSpec {
  /** Structurally complete except `terminate`, which the validator gates on. */
  spec: RawLoopSpec & { caps: Caps };
  capsInjected: boolean;
}

/** Per-pattern cap defaults. Conservative on iterations; generous-but-bounded on budget. */
const PATTERN_MAX_ITERATIONS: Record<LoopPattern, number> = {
  react: 25,
  "plan-execute-reflect": 25,
  "evaluator-optimizer": 25,
  "loop-until-dry": 50,
  "map-reduce": 100,
  "poll-until": 288, // ~24h at one check / 5m
  cron: 100,
};

function defaultCaps(pattern: LoopPattern, mode: string | undefined): Caps {
  const isLongLived = pattern === "poll-until" || mode === "forever" || mode === "watch";
  return {
    max_iterations: isLongLived ? 288 : PATTERN_MAX_ITERATIONS[pattern] ?? 100,
    budget: {
      tokens: 200_000,
      usd: 5.0,
      wallclock: isLongLived ? "24h" : "1h",
    },
    on_cap_exceeded: "breakpoint",
  };
}

export function normalize(raw: RawLoopSpec): NormalizedSpec {
  const spec = structuredClone(raw) as RawLoopSpec;

  if (!spec.loopspec) spec.loopspec = LOOPSPEC_VERSION;

  spec.meta = {
    name: spec.meta?.name ?? spec.id,
    version: spec.meta?.version ?? "0.1.0",
    description: spec.meta?.description,
  };

  spec.target = {
    runtime: spec.target?.runtime ?? "standalone",
    emit: spec.target?.emit ?? ["cli", "skill", "doctor"],
  };

  spec.schedule = spec.schedule ?? { mode: "manual" };

  if (spec.artifacts) {
    spec.artifacts = {
      include: spec.artifacts.include,
      exclude: spec.artifacts.exclude ?? [],
      max_files: spec.artifacts.max_files ?? 1_000,
      max_bytes: spec.artifacts.max_bytes ?? 50_000_000,
    };
  }

  if (spec.state) {
    spec.state.store = spec.state.store ?? "journal";
  }

  spec.observe = {
    trace: spec.observe?.trace ?? "journal",
    hooks: spec.observe?.hooks,
    notify: spec.observe?.notify,
  };

  const capsInjected = spec.caps === undefined;
  const caps: Caps = capsInjected
    ? defaultCaps(spec.pattern, spec.schedule.mode)
    : {
        ...spec.caps!,
        on_cap_exceeded: spec.caps!.on_cap_exceeded ?? "breakpoint",
      };

  return { spec: { ...spec, caps }, capsInjected };
}

/** Cast a fully validated normalized spec to the canonical LoopSpec type. */
export function asLoopSpec(spec: RawLoopSpec & { caps: Caps }): LoopSpec {
  // Safe only after validate() reports no hard errors (terminate present, etc.).
  return spec as unknown as LoopSpec;
}
