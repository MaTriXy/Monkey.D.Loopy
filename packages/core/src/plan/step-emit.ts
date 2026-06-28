/** Shared step-level emit helpers (save/on_done/http-request lowering). */
import { emitTemplate, emitValue } from "./emit.js";
import type { HttpRequest, OnDone } from "../types.js";

export { emitGuard, emitJsExpr, emitTemplate, emitValue } from "./emit.js";

/**
 * State writes use bracket access with a JSON-stringified key so a state-var name
 * can never become executable code, regardless of validation (defense in depth).
 */
function stateRef(varName: string): string {
  return `state[${JSON.stringify(varName)}]`;
}

/** Emit `state["x"] = ctx.jsonpath(<source>, ...)` lines into `lines`. */
export function emitSave(
  save: Record<string, string> | undefined,
  sourceVar: string,
  ind: string,
  lines: string[]
): void {
  for (const [varName, jsonPath] of Object.entries(save ?? {})) {
    lines.push(`${ind}${stateRef(varName)} = ctx.jsonpath(${sourceVar}, ${JSON.stringify(jsonPath)});`);
  }
}

/** Emit on_done mutations (incr / set / append) into `lines`. */
export function emitOnDone(onDone: OnDone | undefined, ind: string, lines: string[]): void {
  if (!onDone) return;
  if (onDone.incr) lines.push(`${ind}${stateRef(onDone.incr)} = ${stateRef(onDone.incr)} + 1;`);
  for (const [varName, value] of Object.entries(onDone.set ?? {})) {
    lines.push(`${ind}${stateRef(varName)} = ${emitValue(value)};`);
  }
  for (const [varName, value] of Object.entries(onDone.append ?? {})) {
    lines.push(`${ind}${stateRef(varName)}.push(${emitValue(value)});`);
  }
}

/** Emit an HTTP request literal object. With `envelope`, opt the call into the
 *  { status, ok, headers, body } result shape (so `save` can read `$.status`). */
export function emitHttpReq(req: HttpRequest, envelope?: boolean): string {
  const parts = [`method: ${JSON.stringify(req.method)}`, `url: ${emitTemplate(req.url)}`];
  if (req.headers && Object.keys(req.headers).length > 0) {
    const h = Object.entries(req.headers)
      .map(([k, v]) => `${JSON.stringify(k)}: ${emitTemplate(v)}`)
      .join(", ");
    parts.push(`headers: { ${h} }`);
  }
  if (req.body !== undefined) parts.push(`body: ${emitValue(req.body)}`);
  if (envelope) parts.push("envelope: true");
  return `{ ${parts.join(", ")} }`;
}
