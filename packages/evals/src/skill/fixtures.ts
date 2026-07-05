/** Skill-eval fixtures: NL goal → expected spec properties + a hand-authored golden spec. */
import { getBlueprint } from "@loopyc/core";
import type { SkillFixture } from "./grade.js";

const RETRY_GOLDEN = `loopspec: "0.1"
id: retry-tests
meta: { name: retry-tests }
pattern: react
state:
  vars:
    passed: { type: boolean, init: false }
    attempt: { type: int, init: 0 }
body:
  - id: test
    kind: shell
    cmd: "npm test --silent -- --json"
    save: { passed: "$.passed" }
    on_done: { incr: attempt }
terminate:
  signal: oracle
  until: "\${state.passed == true}"
caps:
  max_iterations: 10
  no_progress: { fingerprint: "\${state.passed}", max_repeats: 5 }
  budget: { tokens: 200000, usd: 5.0, wallclock: "1h" }
  on_cap_exceeded: breakpoint
`;

const bp = (name: string): string => getBlueprint(name)!.yaml;

export const FIXTURES: SkillFixture[] = [
  { id: "retry-tests", nl: "Retry the build until the tests pass, at most 10 times.", expectedPatterns: ["react", "evaluator-optimizer"], minTier: "oracle", minScore: 80, golden: RETRY_GOLDEN },
  { id: "deploy-watch", nl: "Watch the deploy status; if it's red, have an agent push a fix; stop when it's green.", expectedPatterns: ["poll-until"], minTier: "state-predicate", minScore: 80, golden: bp("poll-until") },
  // "nothing new found" comes from the agent's own report, so the honest floor is
  // self-assess (a grounded variant would count with a shell/http check instead).
  { id: "bug-sweep", nl: "Keep hunting for issues until two passes in a row find nothing new.", expectedPatterns: ["loop-until-dry"], minTier: "self-assess", minScore: 60, golden: bp("loop-until-dry") },
  { id: "draft-refine", nl: "Improve the draft and grade it against a rubric until it scores at least 0.85.", expectedPatterns: ["evaluator-optimizer"], minTier: "llm-judge", minScore: 65, golden: bp("evaluator-optimizer") },
  { id: "summarize", nl: "Summarize each item in this list, then combine the results.", expectedPatterns: ["map-reduce"], minTier: "state-predicate", minScore: 55, golden: bp("map-reduce") },
  { id: "plan-exec", nl: "Plan the task, execute the next step, reflect, and repeat until it's complete.", expectedPatterns: ["plan-execute-reflect"], minTier: "self-assess", minScore: 55, golden: bp("plan-execute-reflect") },
  { id: "digest", nl: "Build and send a daily digest on a schedule.", expectedPatterns: ["cron"], minTier: "state-predicate", minScore: 55, golden: bp("cron") },
  { id: "react-goal", nl: "Keep taking actions toward the goal until it's met.", expectedPatterns: ["react"], minTier: "self-assess", minScore: 55, golden: bp("react") },
];
