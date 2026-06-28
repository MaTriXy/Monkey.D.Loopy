import { describe, expect, it } from "vitest";
import {
  collectRefs,
  evaluate,
  ExprError,
  parseExpr,
  parseGuard,
  parseInterpolations,
  validateRefs,
} from "../src/expr.js";

describe("expression parsing & evaluation", () => {
  it("evaluates comparisons and logic", () => {
    const ctx = { state: { status: "red", attempt: 3 } };
    expect(evaluate(parseExpr("state.status == 'red'"), ctx)).toBe(true);
    expect(evaluate(parseExpr("state.attempt >= 3 && state.status != 'green'"), ctx)).toBe(true);
    expect(evaluate(parseExpr("state.attempt < 2 || state.status == 'red'"), ctx)).toBe(true);
  });

  it("honors arithmetic precedence", () => {
    expect(evaluate(parseExpr("2 + 3 * 4"), {})).toBe(14);
    expect(evaluate(parseExpr("(2 + 3) * 4"), {})).toBe(20);
  });

  it("supports and/or/not keyword aliases and `in`", () => {
    expect(evaluate(parseExpr("not false"), {})).toBe(true);
    expect(evaluate(parseExpr("'a' in items"), { items: ["a", "b"] })).toBe(true);
    expect(evaluate(parseExpr("'z' in items"), { items: ["a", "b"] })).toBe(false);
  });

  it("strips a single ${...} wrapper in guards", () => {
    expect(evaluate(parseGuard("${state.x == 1}"), { state: { x: 1 } })).toBe(true);
  });

  it("splits interpolated templates", () => {
    const segs = parseInterpolations("attempt ${state.attempt} of ${meta.name}");
    expect(segs.map((s) => s.kind)).toEqual(["lit", "expr", "lit", "expr"]);
  });

  it("collects references", () => {
    const refs = collectRefs(parseExpr("state.a == inputs.b && env.C"));
    expect(refs).toEqual([["state", "a"], ["inputs", "b"], ["env", "C"]]);
  });

  it("rejects unknown roots and undeclared bindings", () => {
    const ast = parseExpr("state.unknown == 1 && bogus.x");
    const problems = validateRefs(ast, { stateVars: new Set(["known"]), inputs: new Set() });
    expect(problems.length).toBe(2);
  });

  it("throws on unsafe / malformed expressions", () => {
    expect(() => parseExpr("foo(1)")).toThrow(ExprError);
    expect(() => parseExpr("1 +")).toThrow(ExprError);
  });

  it("honors precedence across comparison / logic / arithmetic", () => {
    expect(evaluate(parseExpr("1 + 2 == 3 && 4 > 2"), {})).toBe(true);
    expect(evaluate(parseExpr("2 + 3 * 4 >= 14"), {})).toBe(true);
    expect(evaluate(parseExpr("7 % 3"), {})).toBe(1);
    expect(evaluate(parseExpr("-state.n"), { state: { n: 5 } })).toBe(-5);
    expect(evaluate(parseExpr("'x' in items || state.ok"), { items: [], state: { ok: true } })).toBe(true);
  });

  it("covers all comparison operators", () => {
    expect(evaluate(parseExpr("3 != 4"), {})).toBe(true);
    expect(evaluate(parseExpr("3 <= 3"), {})).toBe(true);
    expect(evaluate(parseExpr("4 >= 5"), {})).toBe(false);
    expect(evaluate(parseExpr("2 < 3"), {})).toBe(true);
  });

  it("decodes \\t and \\r and passes unknown escapes through", () => {
    expect(evaluate(parseExpr("'a\\tb'"), {})).toBe("a\tb");
    expect(evaluate(parseExpr("'a\\rb'"), {})).toBe("a\rb");
    expect(evaluate(parseExpr("'a\\qb'"), {})).toBe("aqb");
  });

  it("rejects each malformed form", () => {
    for (const bad of ["'unterminated", "(1", "state.", "1.2.3", "1 2", "a &&"]) {
      expect(() => parseExpr(bad), bad).toThrow(ExprError);
    }
    expect(() => parseInterpolations("${state.x")).toThrow(ExprError); // unterminated ${...}
  });

  it("does not treat braces/quotes inside a string literal as structure", () => {
    const segs = parseInterpolations("${ inputs.x == 'a{b}c' }");
    expect(segs.length).toBe(1);
    expect(segs[0]!.kind).toBe("expr");
  });
});
