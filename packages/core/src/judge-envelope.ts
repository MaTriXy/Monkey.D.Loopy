/** Strict boundary for trusted judge transport. Evidence remains data, never control. */
import { isGauntletWorkstreamId } from "./gauntlet-id.js";
export interface JudgeWorkstream { id: string; title: string; scope: string; gap: string; evidence: string; }
export interface JudgeEnvelope { status: "actionable" | "complete" | "no-op" | "invalid"; evidence: { fingerprint: string; workstreams: JudgeWorkstream[]; summary: string }; }

const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const safeText = (value: unknown): value is string => typeof value === "string" && value.length <= 8_192;
// These two fields are interpolated into a builder prompt. Keep them deliberately
// non-instructional: a short label and a repository-relative path, not free-form prose.
const safeTitle = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(value);
const safeScope = (value: unknown): value is string => typeof value === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9._-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value) && !value.split("/").includes("..");
const stream = (value: unknown): JudgeWorkstream | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!isGauntletWorkstreamId(item.id)) return undefined;
  return safeTitle(item.title) && safeScope(item.scope) && safeText(item.gap) && safeText(item.evidence)
    ? { id: item.id as string, title: item.title, scope: item.scope, gap: item.gap, evidence: item.evidence }
    : undefined;
};

/** Invalid input is deterministic and deliberately has an empty workstream list. */
export function normalizeJudgeEnvelope(value: unknown): JudgeEnvelope {
  const invalid: JudgeEnvelope = { status: "invalid", evidence: { fingerprint: "invalid-judge-envelope", workstreams: [], summary: "Judge envelope was invalid." } };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
  const root = value as Record<string, unknown>;
  if (root.status !== "actionable" && root.status !== "complete" && root.status !== "no-op") return invalid;
  if (!root.evidence || typeof root.evidence !== "object" || Array.isArray(root.evidence)) return invalid;
  const evidence = root.evidence as Record<string, unknown>;
  if (!fingerprint(evidence.fingerprint) || !safeText(evidence.summary) || !Array.isArray(evidence.workstreams)) return invalid;
  const workstreams = evidence.workstreams.map(stream);
  if (workstreams.some((item) => !item) || new Set(workstreams.map((item) => item!.id)).size !== workstreams.length) return invalid;
  // An actionable judge must describe at least one concrete bounded repair. Terminal states must not smuggle work.
  if ((root.status === "actionable" && workstreams.length === 0) || (root.status !== "actionable" && workstreams.length !== 0)) return invalid;
  return { status: root.status, evidence: { fingerprint: evidence.fingerprint, workstreams: workstreams as JudgeWorkstream[], summary: evidence.summary } };
}
