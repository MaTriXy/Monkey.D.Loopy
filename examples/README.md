# Examples — one loop per pattern

Every spec here passes `loopc validate` and `loopc verify` (bounded · deterministic ·
resume-stable, proven by dry-run before anything real executes). Scores come from
`loopc score`; the **grounding** column is who actually feeds the exit predicate —
`external` means an http/shell fact decides when the loop stops, `agent` means the
model's own report does (priced accordingly).

| Example | Pattern | What it does | Exit signal · grounding | Score |
|---|---|---|---|---|
| [`test-green.yaml`](test-green.yaml) | react | A coding agent fixes failing tests until the suite exits 0 | oracle · external | 96 A |
| [`migrate-deprecations.yaml`](migrate-deprecations.yaml) | plan-execute-reflect | Migrate off a deprecated API file-by-file; grep counts the plan, tsc reflects | oracle · external | 96 A |
| [`link-sweep.yaml`](link-sweep.yaml) | loop-until-dry | Fix broken doc links until two consecutive scans come back clean | oracle · external | 96 A |
| [`deploy-watch.yaml`](deploy-watch.yaml) | poll-until | Poll a deploy; agent fixes when red; exit on green | state-predicate · external | 91 A |
| [`issue-triage.yaml`](issue-triage.yaml) | map-reduce | Label each issue in a batch, then combine into one triage summary | state-predicate · structural | 85 B |
| [`nightly-digest.yaml`](nightly-digest.yaml) | cron | Every morning: fetch metrics, summarize, deliver to a webhook | state-predicate · structural | 85 B |
| [`release-notes.yaml`](release-notes.yaml) | evaluator-optimizer | Draft release notes; a rubric judge grades until 90+ | llm-judge · agent | 82 B |

The spread is deliberate. The three 96s never let the agent grade its own work — a shell
exit code or a scan count decides. `release-notes` scores lower **because** its judge is a
model: the scorecard prices judgment quality instead of taking the label's word for it.
If you relabeled that judge exit as `state-predicate`, the score would *drop*, not rise —
the grounding analysis sees through the label (and `loopc validate` calls it out).

Try one:

```bash
loopc validate examples/test-green.yaml
loopc verify   examples/test-green.yaml
loopc score    examples/test-green.yaml
loopc compile  examples/test-green.yaml --target standalone --out ./out/test-green
```
