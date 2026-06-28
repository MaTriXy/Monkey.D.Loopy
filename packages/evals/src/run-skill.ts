/** `pnpm eval:skill` — author a spec per NL fixture (LLM if a key is set, else golden) and grade it. */
import { writeFileSync } from "node:fs";
import { FIXTURES } from "./skill/fixtures.js";
import { aggregate, gradeSpec, type SkillGrade } from "./skill/grade.js";
import { llmAuthorAvailable, llmAuthorSpec } from "./skill/author.js";

const live = llmAuthorAvailable();
console.log(
  live
    ? "skill-eval: LIVE (authoring via the configured LLM)"
    : "skill-eval: OFFLINE (grading golden specs — set LOOPY_LLM_API_KEY or any provider key for live authoring)"
);

const grades: SkillGrade[] = [];
for (const fx of FIXTURES) {
  let yaml: string;
  try {
    yaml = live ? await llmAuthorSpec(fx.nl) : fx.golden;
  } catch (e) {
    console.error(`  author failed for ${fx.id} (${(e as Error).message}) — using golden`);
    yaml = fx.golden;
  }
  const g = await gradeSpec(fx, yaml);
  console.log(
    `${g.pass ? "✓" : "✗"} ${g.id.padEnd(14)} pattern=${g.patternMatch} signal=${g.signalTierOk} score=${g.score}${g.notes.length ? ` — ${g.notes.join("; ")}` : ""}`
  );
  grades.push(g);
}

const agg = aggregate(grades);
console.log(
  `\npattern ${(agg.patternRate * 100).toFixed(0)}% · signal ${(agg.signalRate * 100).toFixed(0)}% · reachable ${(agg.reachableRate * 100).toFixed(0)}% · mean-score ${agg.meanScore.toFixed(0)} · pass ${(agg.passRate * 100).toFixed(0)}%  → ${agg.pass ? "PASS" : "FAIL"}`
);
writeFileSync("skill-eval-report.json", JSON.stringify({ live, grades, aggregate: agg }, null, 2));
process.exit(agg.pass ? 0 : 1);
