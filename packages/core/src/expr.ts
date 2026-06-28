/**
 * A tiny, safe expression language for LoopSpec conditions and interpolations.
 *
 * Supports: member access (state.x, inputs.y, env.Z, meta.m, item, iteration),
 * comparisons, boolean and/or/not, arithmetic, `in`, parentheses, and literals.
 *
 * It is intentionally NOT a general language: there is no call syntax, no
 * indexing by arbitrary expressions, no assignment. That is what makes it safe to
 * echo literally into a generated artifact and to evaluate at runtime. The same
 * AST is reused by the validator (reference + safety checks) and the runtime.
 */

export type ExprNode =
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "ref"; path: string[] }
  | { k: "unary"; op: "!" | "-"; e: ExprNode }
  | { k: "bin"; op: BinOp; l: ExprNode; r: ExprNode };

export type BinOp =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "in";

export class ExprError extends Error {}

/**
 * Allowed root identifiers for references in EVERY scope.
 *
 * NOTE: `item` is deliberately NOT here — it is only bound inside a `reduce`
 * (`for (const item of ...)`), so the validator admits it solely via
 * `RefScope.extraRoots` within a reduce body. Listing it globally would let a
 * spec reference `item` in a `when`/`terminate.until`/fingerprint outside any
 * reduce, pass validation, then emit an undefined identifier at runtime.
 */
export const ALLOWED_ROOTS = new Set([
  "state",
  "inputs",
  "env",
  "meta",
  "iteration",
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "dot" }
  | { t: "eof" };

const KEYWORDS: Record<string, Token> = {
  true: { t: "id", v: "true" },
  false: { t: "id", v: "false" },
  null: { t: "id", v: "null" },
  and: { t: "op", v: "&&" },
  or: { t: "op", v: "||" },
  not: { t: "op", v: "!" },
  in: { t: "op", v: "in" },
};

const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const ONE_CHAR_OPS = new Set(["<", ">", "+", "-", "*", "/", "%", "!"]);

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    if (c === ".") {
      toks.push({ t: "dot" });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < n) {
          const e = src[j + 1]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= n) throw new ExprError(`Unterminated string in expression: ${src}`);
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && (isDigit(src[j]!) || src[j] === ".")) j++;
      const num = Number(src.slice(i, j));
      if (Number.isNaN(num)) throw new ExprError(`Invalid number: ${src.slice(i, j)}`);
      toks.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j]!)) j++;
      const word = src.slice(i, j);
      const kw = KEYWORDS[word];
      toks.push(kw ?? { t: "id", v: word });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}' in expression: ${src}`);
  }
  toks.push({ t: "eof" });
  return toks;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

// ---------------------------------------------------------------------------
// Pratt parser
// ---------------------------------------------------------------------------

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  in: 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[], private readonly src: string) {}

  parse(): ExprNode {
    const node = this.parseExpr(0);
    if (this.peek().t !== "eof") {
      throw new ExprError(`Unexpected trailing tokens in expression: ${this.src}`);
    }
    return node;
  }

  private peek(): Token {
    return this.toks[this.pos]!;
  }
  private next(): Token {
    return this.toks[this.pos++]!;
  }

  private parseExpr(minPrec: number): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok.t !== "op") break;
      const prec = BINARY_PRECEDENCE[tok.v];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = { k: "bin", op: tok.v as BinOp, l: left, r: right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const tok = this.peek();
    if (tok.t === "op" && (tok.v === "!" || tok.v === "-")) {
      this.next();
      return { k: "unary", op: tok.v, e: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const tok = this.next();
    if (tok.t === "num") return { k: "lit", v: tok.v };
    if (tok.t === "str") return { k: "lit", v: tok.v };
    if (tok.t === "lparen") {
      const node = this.parseExpr(0);
      const close = this.next();
      if (close.t !== "rparen") throw new ExprError(`Expected ) in expression: ${this.src}`);
      return node;
    }
    if (tok.t === "id") {
      if (tok.v === "true") return { k: "lit", v: true };
      if (tok.v === "false") return { k: "lit", v: false };
      if (tok.v === "null") return { k: "lit", v: null };
      const path = [tok.v];
      while (this.peek().t === "dot") {
        this.next();
        const member = this.next();
        if (member.t !== "id") throw new ExprError(`Expected member name after '.' in: ${this.src}`);
        path.push(member.v);
      }
      return { k: "ref", path };
    }
    throw new ExprError(`Unexpected token in expression: ${this.src}`);
  }
}

/** Parse a raw expression (no `${}` wrapper). */
export function parseExpr(src: string): ExprNode {
  return new Parser(tokenize(src), src).parse();
}

/**
 * Parse a guard/condition that may be written as `${expr}` or as a bare expr.
 * A single wrapping `${ ... }` is stripped.
 */
export function parseGuard(src: string): ExprNode {
  return parseExpr(unwrapGuard(src));
}

export function unwrapGuard(src: string): string {
  const trimmed = src.trim();
  const m = /^\$\{([\s\S]*)\}$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

// ---------------------------------------------------------------------------
// Interpolation (for prompts, urls, cmds: text with embedded ${...})
// ---------------------------------------------------------------------------

export type InterpSegment =
  | { kind: "lit"; text: string }
  | { kind: "expr"; src: string; ast: ExprNode };

/** Split a template string into literal and `${expr}` segments. */
export function parseInterpolations(src: string): InterpSegment[] {
  const segments: InterpSegment[] = [];
  let i = 0;
  const n = src.length;
  let lit = "";
  while (i < n) {
    if (src[i] === "$" && src[i + 1] === "{") {
      if (lit) {
        segments.push({ kind: "lit", text: lit });
        lit = "";
      }
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        const ch = src[j];
        if (ch === "'" || ch === '"') {
          // skip over a string literal so its braces/quotes don't affect depth
          j++;
          while (j < n && src[j] !== ch) {
            if (src[j] === "\\") j++;
            j++;
          }
          j++; // consume closing quote
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (depth !== 0) throw new ExprError(`Unterminated \${...} in: ${src}`);
      const exprSrc = src.slice(i + 2, j);
      segments.push({ kind: "expr", src: exprSrc, ast: parseExpr(exprSrc) });
      i = j + 1;
    } else {
      lit += src[i];
      i++;
    }
  }
  if (lit) segments.push({ kind: "lit", text: lit });
  return segments;
}

// ---------------------------------------------------------------------------
// Reference collection + safety validation
// ---------------------------------------------------------------------------

/** Collect dotted reference paths (e.g. "state.status") from an AST. */
export function collectRefs(node: ExprNode, acc: string[][] = []): string[][] {
  switch (node.k) {
    case "lit":
      return acc;
    case "ref":
      acc.push(node.path);
      return acc;
    case "unary":
      return collectRefs(node.e, acc);
    case "bin":
      collectRefs(node.l, acc);
      collectRefs(node.r, acc);
      return acc;
  }
}

export interface RefScope {
  stateVars: Set<string>;
  inputs: Set<string>;
  /** Extra single-token roots allowed in this scope (e.g. a reduce alias). */
  extraRoots?: Set<string>;
}

/**
 * Validate that every reference uses an allowed root and a declared binding.
 * Returns a list of human-readable problems (empty = safe).
 */
export function validateRefs(node: ExprNode, scope: RefScope): string[] {
  const problems: string[] = [];
  for (const path of collectRefs(node)) {
    const root = path[0]!;
    const allowed = ALLOWED_ROOTS.has(root) || scope.extraRoots?.has(root);
    if (!allowed) {
      problems.push(
        `unknown reference root '${root}' (allowed: ${[...ALLOWED_ROOTS].join(", ")})`
      );
      continue;
    }
    if (root === "state") {
      const v = path[1];
      if (v === undefined) {
        problems.push("bare 'state' reference; use state.<var>");
      } else if (!scope.stateVars.has(v)) {
        problems.push(`reference to undeclared state var 'state.${v}'`);
      }
    }
    if (root === "inputs") {
      const v = path[1];
      if (v === undefined) {
        problems.push("bare 'inputs' reference; use inputs.<name>");
      } else if (!scope.inputs.has(v)) {
        problems.push(`reference to undeclared input 'inputs.${v}'`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Evaluation (used by the runtime; included here so it stays in lockstep with parsing)
// ---------------------------------------------------------------------------

export interface EvalContext {
  state?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  item?: unknown;
  iteration?: number;
  [extra: string]: unknown;
}

export function evaluate(node: ExprNode, ctx: EvalContext): unknown {
  switch (node.k) {
    case "lit":
      return node.v;
    case "ref":
      return resolveRef(node.path, ctx);
    case "unary":
      return node.op === "!" ? !truthy(evaluate(node.e, ctx)) : -Number(evaluate(node.e, ctx));
    case "bin":
      return evalBin(node, ctx);
  }
}

function resolveRef(path: string[], ctx: EvalContext): unknown {
  let cur: unknown = ctx[path[0]!];
  for (let i = 1; i < path.length; i++) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[path[i]!];
  }
  return cur;
}

function evalBin(node: Extract<ExprNode, { k: "bin" }>, ctx: EvalContext): unknown {
  const { op } = node;
  // Operand semantics, matching the JS the emitter lowers to (`l && r` / `l || r`),
  // so the runtime interpreter and the generated code never diverge.
  if (op === "&&") {
    const l = evaluate(node.l, ctx);
    return truthy(l) ? evaluate(node.r, ctx) : l;
  }
  if (op === "||") {
    const l = evaluate(node.l, ctx);
    return truthy(l) ? l : evaluate(node.r, ctx);
  }
  const l = evaluate(node.l, ctx);
  const r = evaluate(node.r, ctx);
  switch (op) {
    case "==":
      return l === r;
    case "!=":
      return l !== r;
    case "<":
      return (l as number) < (r as number);
    case "<=":
      return (l as number) <= (r as number);
    case ">":
      return (l as number) > (r as number);
    case ">=":
      return (l as number) >= (r as number);
    case "+":
      return (l as number) + (r as number);
    case "-":
      return (l as number) - (r as number);
    case "*":
      return (l as number) * (r as number);
    case "/":
      return (l as number) / (r as number);
    case "%":
      return (l as number) % (r as number);
    case "in":
      if (Array.isArray(r)) return r.includes(l);
      if (typeof r === "string") return r.includes(String(l));
      if (r && typeof r === "object") return l != null && String(l) in (r as object);
      return false;
  }
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}
