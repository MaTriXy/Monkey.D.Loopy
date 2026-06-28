/** Duration string parsing shared by the validator and (later) the runtime. */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
/** Sane upper bound: 100 years in ms. Beyond this a duration is almost certainly a typo,
 *  and very large digit strings overflow IEEE-754 to Infinity (an unbounded sleep/budget). */
const MAX_DURATION_MS = 100 * 365 * 86_400_000;

/** Parse "5m", "24h", "500ms" into milliseconds. Throws on malformed or out-of-range input. */
export function parseDuration(input: string): number {
  const m = DURATION_RE.exec(input.trim());
  if (!m) {
    throw new Error(`invalid duration '${input}' (use forms like 500ms, 30s, 5m, 24h, 7d)`);
  }
  const ms = Number(m[1]) * UNIT_MS[m[2]!]!;
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DURATION_MS) {
    throw new Error(`duration '${input}' is out of range (max ~100y; got ${ms} ms)`);
  }
  return ms;
}

export function isValidDuration(input: string): boolean {
  const m = DURATION_RE.exec(input.trim());
  if (!m) return false;
  const ms = Number(m[1]) * UNIT_MS[m[2]!]!;
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_DURATION_MS;
}
