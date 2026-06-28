/** `pnpm eval` runner: run every eval, print a Markdown scorecard, write JSON, exit nonzero on any failure. */
import { writeFileSync } from "node:fs";
import { ALL_EVALS, type EvalResult } from "./index.js";

const results: EvalResult[] = [];
for (const ev of ALL_EVALS) {
  process.stdout.write(`running ${ev.name}… `);
  const r = await ev.run();
  console.log(r.failed === 0 ? "ok" : `FAILED (${r.failed})`);
  results.push(r);
}

const anyFail = results.some((r) => r.failed > 0);
const lines = ["", "# Monkey D Loopy — eval report", ""];
for (const r of results) {
  lines.push(`- ${r.failed === 0 ? "✓" : "✗"} **${r.name}** — ${r.total - r.failed}/${r.total} passed`);
  for (const f of r.failures.slice(0, 5)) lines.push(`    - ${f}`);
}
console.log(lines.join("\n"));
writeFileSync("evals-report.json", JSON.stringify(results, null, 2));
process.exit(anyFail ? 1 : 0);
