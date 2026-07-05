/**
 * Helpers imported by generated standalone artifacts and used internally.
 * Kept identical to the inlined babysitter `__jsonpath` / `__in` so both targets
 * agree on expression and extraction semantics (the M1 tracked item).
 */

/** Truthy/array/string/object membership — matches the emitter's `__in(l, r)` lowering. */
export function __in(l: unknown, r: unknown): boolean {
  if (Array.isArray(r)) return r.includes(l);
  if (typeof r === "string") return r.includes(String(l));
  if (r && typeof r === "object") return l != null && String(l) in (r as object);
  return false;
}

/** Minimal json-path: supports `$.a.b`, `$.a[0]`, bare `a.b`. Returns undefined on miss. */
export function jsonpath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const seg of String(path).replace(/^\$\.?/, "").split(".")) {
    if (!seg) continue;
    const m = /^([^[]*)(?:\[(\d+)\])?$/.exec(seg);
    if (!m) return undefined;
    if (m[1]) cur = (cur as Record<string, unknown> | null)?.[m[1]];
    if (m[2] != null) cur = (cur as unknown[] | null)?.[Number(m[2])];
    if (cur == null) return undefined;
  }
  return cur;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "5m" / "24h" / "500ms" → milliseconds (mirrors @loopyc/core duration). */
export function parseDuration(input: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(input).trim());
  if (!m) throw new Error(`invalid duration '${input}'`);
  return Number(m[1]) * UNIT_MS[m[2]!]!;
}
