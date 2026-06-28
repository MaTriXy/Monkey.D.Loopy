/**
 * Deterministic lowering of LoopSpec expressions to JavaScript source.
 * Pure string-in / string-out so the planner stays I/O-free and golden-testable.
 */
import { parseGuard, parseInterpolations, type ExprNode } from "../expr.js";

const BIN_JS: Record<string, string> = {
  "==": "===",
  "!=": "!==",
  "&&": "&&",
  "||": "||",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
};

/** Lower an expression AST to a JS expression string. `in` uses the runtime `__in` helper. */
export function emitJsExpr(node: ExprNode): string {
  switch (node.k) {
    case "lit":
      return JSON.stringify(node.v);
    case "ref":
      // optional-chain multi-segment refs so navigating into an undefined intermediate
      // yields undefined (matching the runtime interpreter), not a TypeError.
      return node.path.length > 1
        ? node.path[0]! + node.path.slice(1).map((p) => `?.${p}`).join("")
        : node.path[0]!;
    case "unary":
      return node.op === "!" ? `!(${emitJsExpr(node.e)})` : `-(${emitJsExpr(node.e)})`;
    case "bin":
      if (node.op === "in") return `__in(${emitJsExpr(node.l)}, ${emitJsExpr(node.r)})`;
      return `(${emitJsExpr(node.l)} ${BIN_JS[node.op]} ${emitJsExpr(node.r)})`;
  }
}

/** Lower a guard/condition string (`${expr}` or bare) to a JS boolean expression. */
export function emitGuard(src: string): string {
  return emitJsExpr(parseGuard(src));
}

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** Lower an interpolated string (prompt/url/cmd) to a JS template literal. */
export function emitTemplate(src: string): string {
  const segs = parseInterpolations(src);
  let out = "`";
  for (const seg of segs) {
    if (seg.kind === "lit") out += escapeTemplate(seg.text);
    else out += "${" + emitJsExpr(seg.ast) + "}";
  }
  return out + "`";
}

/** Lower an arbitrary JSON-ish value, treating strings as interpolated templates. */
export function emitValue(value: unknown): string {
  if (typeof value === "string") return emitTemplate(value);
  return JSON.stringify(value ?? null);
}
