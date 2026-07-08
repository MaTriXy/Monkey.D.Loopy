/** Planner entry point: dispatch a validated LoopSpec to a target adapter. */
import type { LoopSpec, RuntimeTarget } from "../types.js";
import type { Adapter, PlanOptions, PlanResult } from "./types.js";
import { standaloneAdapter } from "./standalone.js";
import { babysitterAdapter } from "./babysitter.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { claudeNativeAdapter } from "./claude-native.js";
import { n8nAdapter } from "./n8n.js";

const ADAPTERS: Record<RuntimeTarget, Adapter> = {
  standalone: standaloneAdapter,
  babysitter: babysitterAdapter,
  "claude-code": claudeCodeAdapter,
  "claude-native": claudeNativeAdapter,
  n8n: n8nAdapter,
};

export const SUPPORTED_TARGETS: RuntimeTarget[] = ["standalone", "babysitter", "claude-code", "claude-native", "n8n"];

/**
 * Pure: lower a (validated) LoopSpec to a target's runnable file set.
 * No I/O — the CLI is responsible for writing PlannedFile[] to disk.
 * `opts` carries optional, target-specific codegen knobs (e.g. `{ vendor }` for standalone).
 */
export function planLoopExport(spec: LoopSpec, target: RuntimeTarget, opts?: PlanOptions): PlanResult {
  const adapter = ADAPTERS[target];
  if (!adapter) throw new Error(`unknown target '${target}' (supported: ${SUPPORTED_TARGETS.join(", ")})`);
  return adapter.plan(spec, opts);
}

/** Lower to multiple targets at once. */
export function planAll(spec: LoopSpec, targets: RuntimeTarget[]): PlanResult[] {
  return targets.map((t) => planLoopExport(spec, t));
}

export * from "./types.js";
