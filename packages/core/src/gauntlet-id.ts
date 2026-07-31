/** Stable, display-safe identifier used by Gauntlet workstreams. */
export const GAUNTLET_WORKSTREAM_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isGauntletWorkstreamId(value: unknown): value is string {
  return typeof value === "string" && GAUNTLET_WORKSTREAM_ID_RE.test(value);
}
