/** Planner output contract + the cross-target capability matrix. */
import type { LoopSpec, RuntimeTarget } from "../types.js";

export type PlannedFileKind =
  | "entry"
  | "config"
  | "doc"
  | "skill"
  | "doctor"
  | "provenance"
  | "asset";

export interface PlannedFile {
  relativePath: string;
  contents: string;
  kind: PlannedFileKind;
  /** Whether this file should be marked executable when materialized. */
  executable?: boolean;
}

export interface PlanResult {
  target: RuntimeTarget;
  files: PlannedFile[];
  /** Compile-time warnings, e.g. a feature the target only soft-enforces. */
  warnings: string[];
}

/** Optional, target-specific knobs threaded from `planLoopExport`. All purely affect codegen. */
export interface PlanOptions {
  /**
   * Standalone only: vendor `@loopyc/runtime` into a local `runtime.bundle.mjs` so the artifact
   * runs with plain `node` (no install). The planner rewrites the import + drops the dependency;
   * the CLI is responsible for actually generating the bundle file. Ignored by other targets.
   */
  vendor?: boolean;
}

export interface Adapter {
  target: RuntimeTarget;
  plan(spec: LoopSpec, opts?: PlanOptions): PlanResult;
}

// ---------------------------------------------------------------------------
// Capability matrix: what each target can ENFORCE vs only soft-honor.
// Used to emit honest compile-time warnings instead of silently degrading.
// ---------------------------------------------------------------------------

export type Capability =
  | "journal"
  | "replay"
  | "breakpoints"
  | "durable-sleep"
  | "max-iterations"
  | "no-progress"
  | "token-budget"
  | "usd-budget"
  | "wallclock-budget"
  | "schedule-forever"
  | "schedule-cron"
  | "http-native"
  | "artifact-contract"
  | "notifications";

export type Support = "enforced" | "soft" | "unsupported";

export const CAPABILITY_MATRIX: Record<RuntimeTarget, Record<Capability, Support>> = {
  standalone: {
    journal: "enforced",
    replay: "enforced",
    breakpoints: "enforced",
    "durable-sleep": "enforced",
    "max-iterations": "enforced",
    "no-progress": "enforced",
    "token-budget": "enforced",
    "usd-budget": "enforced",
    "wallclock-budget": "enforced",
    "schedule-forever": "enforced",
    "schedule-cron": "soft", // relies on host cron / Claude Cloud routines to fire it
    "http-native": "enforced",
    "artifact-contract": "soft",
    notifications: "soft",
  },
  babysitter: {
    journal: "enforced",
    replay: "enforced",
    breakpoints: "enforced",
    "durable-sleep": "enforced",
    "max-iterations": "enforced", // generated in-loop guard
    "no-progress": "enforced", // generated in-loop guard
    "token-budget": "soft", // babysitter does not meter our token usage
    "usd-budget": "soft",
    "wallclock-budget": "soft",
    "schedule-forever": "enforced",
    "schedule-cron": "soft",
    "http-native": "unsupported", // closed task enum (agent|shell|breakpoint|sleep) → lowered to shell+curl
    "artifact-contract": "soft",
    notifications: "unsupported",
  },
  // Prose execution guide for a coding agent (cc-wf-studio style): everything is
  // agent-followed, so enforcement is soft and there is no journal/replay machinery.
  "claude-code": {
    journal: "unsupported",
    replay: "unsupported",
    breakpoints: "soft",
    "durable-sleep": "soft",
    "max-iterations": "soft",
    "no-progress": "soft",
    "token-budget": "unsupported",
    "usd-budget": "unsupported",
    "wallclock-budget": "unsupported",
    "schedule-forever": "soft",
    "schedule-cron": "soft",
    "http-native": "enforced",
    "artifact-contract": "soft",
    notifications: "unsupported",
  },
  // Claude Code project skill: slash-command native UX. It can delegate to a sibling
  // standalone artifact for hard guarantees, but the Claude skill itself is still prompt-driven.
  "claude-native": {
    journal: "soft",
    replay: "soft",
    breakpoints: "soft",
    "durable-sleep": "soft",
    "max-iterations": "soft",
    "no-progress": "soft",
    "token-budget": "soft",
    "usd-budget": "soft",
    "wallclock-budget": "soft",
    "schedule-forever": "soft",
    "schedule-cron": "soft",
    "http-native": "soft",
    "artifact-contract": "soft",
    notifications: "unsupported",
  },
  // n8n workflow export — a best-effort node graph. n8n has its own execution model
  // (item-passing, its own history), so our journal/caps/shared-state guarantees don't map.
  n8n: {
    journal: "unsupported",
    replay: "soft",
    breakpoints: "unsupported",
    "durable-sleep": "enforced", // Wait node
    "max-iterations": "soft",
    "no-progress": "unsupported",
    "token-budget": "unsupported",
    "usd-budget": "unsupported",
    "wallclock-budget": "unsupported",
    "schedule-forever": "soft",
    "schedule-cron": "enforced", // Schedule Trigger
    "http-native": "enforced", // HTTP Request node
    "artifact-contract": "soft",
    notifications: "unsupported",
  },
};

/** Determine which capabilities a spec actually exercises. */
export function usedCapabilities(spec: LoopSpec): Set<Capability> {
  const used = new Set<Capability>();
  used.add("journal");
  used.add("replay");
  used.add("max-iterations");
  if (spec.caps.no_progress) used.add("no-progress");
  if (spec.caps.budget?.tokens) used.add("token-budget");
  if (spec.caps.budget?.usd) used.add("usd-budget");
  if (spec.caps.budget?.wallclock) used.add("wallclock-budget");
  if (spec.schedule?.mode === "forever" || spec.schedule?.mode === "watch")
    used.add("schedule-forever");
  if (spec.schedule?.mode === "cron") used.add("schedule-cron");
  if (spec.artifacts) used.add("artifact-contract");
  if (spec.notify && spec.notify.policy !== "never") used.add("notifications");

  const walk = (steps: typeof spec.body): void => {
    for (const s of steps) {
      if (s.kind === "breakpoint") used.add("breakpoints");
      if (s.kind === "sleep") used.add("durable-sleep");
      if (s.kind === "http") used.add("http-native");
      if (s.kind === "reduce") walk(s.body);
    }
  };
  walk(spec.body);
  if ((spec.gates?.length ?? 0) > 0) used.add("breakpoints");
  return used;
}

/** Compare used capabilities against a target's matrix → human-readable warnings. */
export function capabilityWarnings(spec: LoopSpec, target: RuntimeTarget): string[] {
  const matrix = CAPABILITY_MATRIX[target];
  const warnings: string[] = [];
  for (const cap of usedCapabilities(spec)) {
    const support = matrix[cap];
    if (support === "soft") {
      warnings.push(`'${cap}' is only soft-enforced on target '${target}' — it cannot be guaranteed.`);
    } else if (support === "unsupported") {
      warnings.push(`'${cap}' is unsupported on target '${target}' and will be lowered (see generated notes).`);
    }
  }
  return warnings;
}
