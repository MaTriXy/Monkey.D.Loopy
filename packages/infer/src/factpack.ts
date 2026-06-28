/**
 * FactPack extraction — DETERMINISTIC, no LLM. Pulls the load-bearing facts out of an
 * existing script (JS/TS via the TypeScript AST, or bash heuristics) or a .loopy journal:
 * candidate pattern, body steps, a termination hint, inputs/state candidates, and flagged
 * secrets. The /loopy skill (or a model) turns the FactPack + draft into a real LoopSpec via
 * the unchanged validate→verify→score gates. A FactPack is a DRAFT, not a guarantee.
 */
import ts from "typescript";

export type SourceKind = "js" | "bash" | "journal";

export interface FactStep {
  kind: "http" | "shell" | "agent" | "sleep";
  detail: string;
}

export interface FactPack {
  source: SourceKind;
  candidatePattern: string;
  steps: FactStep[];
  terminateHint?: string;
  sleepHint?: string;
  inputs: string[];
  state: string[];
  secretsFlagged: string[];
  notes: string[];
  confidence: "low" | "medium" | "high";
}

/** Secret keyword SEGMENTS (matched as whole `_`- or case-delimited parts, not substrings, so
 *  `tokens`/`tokenizer`/`MAX_TOKENS`/`secretary` are NOT flagged while `AWS_SECRET_ACCESS_KEY`,
 *  `PRIVATE_KEY`, `PASSPHRASE`, `accessToken`, `apiKey` are). */
const SECRET_SEGMENTS = new Set([
  "KEY", "APIKEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "PASSPHRASE",
  "BEARER", "CREDENTIAL", "CREDENTIALS", "PAT", "PRIVATEKEY", "ACCESSKEY",
]);

/** Split an identifier into upper-cased segments by `_` and camelCase boundaries. */
function segmentsOf(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split("_")
    .filter(Boolean)
    .map((s) => s.toUpperCase());
}

function flagSecrets(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const id = m[0]!;
    if (segmentsOf(id).some((seg) => SECRET_SEGMENTS.has(seg))) out.add(id);
  }
  return [...out];
}

/** Detect the source kind from filename + content. */
export function detectKind(filename: string, content: string): SourceKind {
  if (/\.(jsonl)$/.test(filename) || /"type"\s*:\s*"(run_start|iteration_snapshot|effect)"/.test(content)) return "journal";
  if (/\.(sh|bash)$/.test(filename) || /^#!.*\b(ba)?sh\b/.test(content)) return "bash";
  if (/\.(m?[jt]s|cjs)$/.test(filename)) return "js";
  // fall back on content
  return /^\s*(while|until|for)\b.*\bdo\b/m.test(content) && !/=>|function|const |let /.test(content) ? "bash" : "js";
}

// --- JS / TS (real AST) -----------------------------------------------------
function extractJs(src: string): FactPack {
  const sf = ts.createSourceFile("input.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const steps: FactStep[] = [];
  const inputs = new Set<string>();
  const notes: string[] = [];
  let pattern = "react";
  let terminateHint: string | undefined;
  let sleepHint: string | undefined;
  let hasLoop = false;

  const visit = (node: ts.Node): void => {
    if (ts.isWhileStatement(node)) {
      hasLoop = true;
      terminateHint = `!(${node.expression.getText(sf)})`; // exit when the while-condition is false
    } else if (ts.isForStatement(node)) {
      hasLoop = true;
      if (node.condition) terminateHint = `!(${node.condition.getText(sf)})`;
    } else if (ts.isForOfStatement(node)) {
      hasLoop = true;
      pattern = "map-reduce";
    } else if (ts.isDoStatement(node)) {
      hasLoop = true;
      terminateHint = `!(${node.expression.getText(sf)})`;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      const arg0 = node.arguments[0]?.getText(sf) ?? "";
      if (/\bfetch\b|\baxios\b|\bgot\b|\bhttps?2?\.(get|request)\b/.test(callee)) steps.push({ kind: "http", detail: arg0 || callee });
      else if (/\bexec(Sync|File|FileSync)?\b|\bspawn(Sync)?\b/.test(callee)) steps.push({ kind: "shell", detail: arg0 || callee });
      else if (/setInterval/.test(callee)) {
        sleepHint = node.arguments[1]?.getText(sf);
        pattern = "poll-until";
      } else if (/setTimeout/.test(callee)) {
        sleepHint = node.arguments[1]?.getText(sf);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const m = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/.exec(node.getText(sf));
      if (m) inputs.add(m[1]!);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!hasLoop) notes.push("no loop construct found — treating the script as a single iteration body");
  if (sleepHint && pattern === "react") pattern = "poll-until";
  notes.push("JS/TS inference is structural: confirm the termination predicate maps to a real state signal, not the raw loop condition.");
  return {
    source: "js",
    candidatePattern: pattern,
    steps,
    terminateHint,
    sleepHint,
    inputs: [...inputs],
    state: [],
    secretsFlagged: flagSecrets(src),
    notes,
    confidence: hasLoop && terminateHint ? "medium" : "low",
  };
}

// --- bash (heuristic) -------------------------------------------------------
function extractBash(src: string): FactPack {
  const steps: FactStep[] = [];
  const inputs = new Set<string>();
  const notes: string[] = [];
  let pattern = "react";
  let terminateHint: string | undefined;
  let sleepHint: string | undefined;
  let hasLoop = false;
  // names that are NOT external inputs: locally assigned vars + loop counters.
  const localVars = new Set<string>();
  for (const am of src.matchAll(/^\s*(?:local\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)) localVars.add(am[1]!);
  for (const fm of src.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) localVars.add(fm[1]!);

  for (const raw of src.split("\n")) {
    const t = raw.trim();
    let m: RegExpExecArray | null;
    // loop keywords (may share a line with the body in one-liners)
    if ((m = /\bwhile\s+(.+?);?\s*do\b/.exec(t))) {
      hasLoop = true;
      if (!/^while\s+true\b/.test(m[0]!.trim())) terminateHint = `!(${m[1]!.trim()})`;
      pattern = "poll-until";
    } else if ((m = /\buntil\s+(.+?);?\s*do\b/.exec(t))) {
      hasLoop = true;
      terminateHint = m[1]!.trim();
      pattern = "poll-until";
    } else if (/\bfor\s+\w+\s+in\b/.test(t)) {
      hasLoop = true;
      pattern = "map-reduce";
    }
    // effects — detected independently, even on a loop-keyword line
    if (/\bcurl\b|\bwget\b/.test(t)) steps.push({ kind: "http", detail: t });
    if ((m = /\bsleep\s+(\d+[a-z]*)\b/.exec(t))) sleepHint = /^\d+$/.test(m[1]!) ? `${m[1]}s` : m[1]!;
    for (const cmd of t.split(/;|&&/).map((c) => c.trim())) {
      if (
        cmd &&
        // shell keywords need a word boundary so `find`/`docker`/`ifconfig`/`format` aren't
        // mistaken for `fi`/`do`/`if`/`for` and silently dropped.
        !/^(while|until|for|do|done|if|then|fi|elif|else|case|esac)\b/.test(cmd) &&
        !/^(#|set\b|export\b|sleep\b)/.test(cmd) &&
        !/\bcurl\b|\bwget\b/.test(cmd)
      ) {
        steps.push({ kind: "shell", detail: cmd });
      }
    }
    for (const e of t.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) inputs.add(e[1]!);
  }
  // drop loop counters / locally-assigned vars — they are not external inputs.
  for (const v of localVars) inputs.delete(v);
  if (!hasLoop) notes.push("no loop construct found — treating the script as a single iteration body");
  notes.push("bash inference is heuristic (no full grammar): review the steps and the exit condition.");
  return {
    source: "bash",
    candidatePattern: pattern,
    steps,
    terminateHint,
    sleepHint,
    inputs: [...inputs].filter((v) => v !== "1" && v !== "?"),
    state: [],
    secretsFlagged: flagSecrets(src),
    notes,
    confidence: hasLoop && terminateHint ? "medium" : "low",
  };
}

// --- .loopy journal round-trip ----------------------------------------------
function extractJournal(src: string): FactPack {
  const lines = src.split("\n").filter((l) => l.trim());
  const events: { type: string; data: Record<string, unknown> }[] = [];
  let skipped = 0;
  for (const l of lines) {
    try {
      events.push(JSON.parse(l) as { type: string; data: Record<string, unknown> });
    } catch {
      // tolerate a crash-truncated / torn line (the journal is append-only + crash-resumable),
      // mirroring the runtime's Journal.load instead of failing the whole inference.
      skipped++;
    }
  }
  const state = new Set<string>();
  const stepKinds = new Map<string, FactStep>();
  const notes: string[] = [];
  if (skipped) notes.push(`skipped ${skipped} unparseable journal line(s) (likely a crash-truncated tail).`);
  for (const ev of events) {
    if (ev.type === "run_start" && ev.data.baseState) {
      for (const k of Object.keys(ev.data.baseState as object)) state.add(k);
    } else if (ev.type === "effect") {
      const kind = ev.data.kind as string;
      // preserve the real effect kind (http was previously coerced to shell); fold sleepUntil
      // into sleep; anything else (e.g. breakpoint) falls back to shell.
      const stepKind: FactStep["kind"] =
        kind === "agent" || kind === "shell" || kind === "sleep" || kind === "http"
          ? kind
          : kind === "sleepUntil"
            ? "sleep"
            : "shell";
      const id = `${stepKind}-${stepKinds.size}`;
      if (!stepKinds.has(`${ev.data.iteration}:${ev.data.seq}`)) {
        stepKinds.set(`${ev.data.iteration}:${ev.data.seq}`, {
          kind: stepKind,
          detail: String(ev.data.cmd ?? ev.data.url ?? ev.data.harness ?? id),
        });
      }
    }
  }
  notes.push("journal round-trip recovers state + steps but NOT the termination predicate (it isn't journaled) — supply `terminate.until` from the run's intent.");
  return {
    source: "journal",
    candidatePattern: "poll-until",
    steps: [...new Map([...stepKinds].slice(0, 6)).values()],
    terminateHint: undefined,
    inputs: [],
    state: [...state],
    secretsFlagged: [],
    notes,
    confidence: "medium",
  };
}

export function extractFactPack(content: string, kind: SourceKind): FactPack {
  if (kind === "journal") return extractJournal(content);
  if (kind === "bash") return extractBash(content);
  return extractJs(content);
}
