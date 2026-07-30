/** A deliberately defensive read-only projection of journal state for the Gauntlet board. */
export interface GauntletWorkstream { id: string; title: string; scope: string; gap: string; evidence: string; }
export interface GauntletView {
  variant: "creative" | "verified";
  stage: string;
  round: number;
  threshold?: number;
  passed?: number;
  score?: number;
  status?: string;
  summary?: string;
  workstreams: GauntletWorkstream[];
  gaps: string[];
}

export interface WorkflowSummary {
  kind: "blueprint" | "recipe";
  name: string;
  title: string;
  summary: string;
  pattern: string;
  grounding: string;
  score: number;
  grade: string;
  schedule: string;
  featured: boolean;
  commandTemplate: string;
}

/** Keep board-only identifiers in the strict form accepted by trusted judges. */
export const GAUNTLET_WORKSTREAM_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const isGauntletWorkstreamId = (value: unknown): value is string => typeof value === "string" && GAUNTLET_WORKSTREAM_ID_RE.test(value);
export const isLoopId = isGauntletWorkstreamId;

export function orderWorkflows(workflows: readonly WorkflowSummary[]): WorkflowSummary[] {
  return [...workflows].sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
}

export function materializeWorkflowCommand(commandTemplate: string, loopId: string): string | undefined {
  if (!isLoopId(loopId) || !/^loopc new my-launch --(?:blueprint|recipe) [a-z][a-z0-9-]*$/.test(commandTemplate)) return undefined;
  return commandTemplate.replace("my-launch", loopId);
}

export async function copyWorkflowCommand(writeText: (text: string) => Promise<void>, command: string): Promise<string> {
  try {
    await writeText(command);
    return `Copied ${command}`;
  } catch {
    return "Copy failed; select the command manually.";
  }
}

export function projectGauntletRunStatus(iteration: number, tokens: number, usd: number): { iteration: string; budget: string } {
  const safeIteration = Number.isFinite(iteration) && iteration >= 0 ? Math.floor(iteration) : 0;
  const safeTokens = Number.isFinite(tokens) && tokens >= 0 ? Math.floor(tokens) : 0;
  const safeUsd = Number.isFinite(usd) && usd >= 0 ? usd : 0;
  return { iteration: `Iteration ${safeIteration}`, budget: `${safeTokens.toLocaleString("en-US")} tokens · $${safeUsd.toFixed(2)}` };
}

const text = (value: unknown, fallback = "—"): string => typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function workstreams(value: unknown): GauntletWorkstream[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const itemRecord = record(item);
    if (!itemRecord) return [];
    const id = text(itemRecord.id, "");
    if (!isGauntletWorkstreamId(id)) return [];
    return [{ id, title: text(itemRecord.title), scope: text(itemRecord.scope), gap: text(itemRecord.gap), evidence: text(itemRecord.evidence) }];
  });
}

/** Never throws, never renders HTML, and only exposes fields the board explicitly needs. */
export function projectGauntletState(state: unknown, inputs?: unknown): GauntletView | undefined {
  const root = record(state);
  if (!root) return undefined;
  const evidence = record(root.evidence);
  const verified = typeof root.status === "string" && evidence !== undefined;
  const streams = workstreams(verified ? evidence?.workstreams : root.workstreams);
  const history = Array.isArray(root.review_history) ? root.review_history : [];
  const gaps = [...streams.map((stream) => stream.gap).filter((gap) => gap !== "—"), ...history.flatMap((entry) => {
    const item = record(entry);
    const critic = record(item?.critic);
    const gap = critic?.gap ?? item?.gap; // tolerate legacy flat journal records
    return typeof gap === "string" ? [gap] : [];
  })].slice(0, 6);
  if (verified) return {
    variant: "verified", stage: text(root.status), round: number(root.rounds) ?? 0, status: text(root.status),
    summary: text(evidence?.summary), workstreams: streams, gaps,
  };
  if (!Array.isArray(root.workstreams) && !Array.isArray(root.review_history) && number(root.rounds) === undefined) return undefined;
  const finalScore = number(root.final_score) ?? number(root.last_score);
  return {
    variant: "creative", stage: root.decomposed === true ? "reviewing" : "decomposing", round: number(root.rounds) ?? 0,
    threshold: number(record(inputs)?.threshold) ?? number(root.threshold), passed: number(root.passed_count), score: finalScore,
    summary: text(root.final_gap, ""), workstreams: streams, gaps,
  };
}
