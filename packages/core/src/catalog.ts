/**
 * Embedded blueprint catalog: curated, parameterizable starting-point LoopSpecs.
 * `loopc new --blueprint <name>` scaffolds from these. There is one blueprint per
 * advertised LoopPattern, which also serves as an executable sanity check that the
 * IR can express each pattern. The value of the factory compounds with the gallery.
 */

export interface Blueprint {
  name: string;
  pattern: string;
  description: string;
  yaml: string;
}

const POLL_UNTIL = `loopspec: "0.1"
id: deploy-watch
meta:
  name: deploy-watch
  description: Poll a deploy status; if red, let an agent push a fix; exit when green.
pattern: poll-until

inputs:
  status_url: { type: string, required: true }

state:
  store: journal
  vars:
    status: { type: "enum[pending,green,red]", init: pending }
    attempt: { type: int, init: 0 }

body:
  - id: check
    kind: http
    request: { method: GET, url: "\${inputs.status_url}" }
    save: { status: "$.state" }
  - id: triage
    when: "\${state.status == 'red'}"
    kind: agent
    harness: cli  # any coding agent via LOOPY_AGENT_CMD
    prompt: "Deploy failed (attempt \${state.attempt}). Diagnose and push a minimal fix."
    on_done: { incr: attempt }
  - id: wait
    when: "\${state.status == 'pending'}"
    kind: sleep
    for: 5m

terminate:
  signal: state-predicate
  until: "\${state.status == 'green'}"
  on_exit: { kind: shell, cmd: "echo deploy \${state.status}" }

caps:
  max_iterations: 288
  no_progress: { fingerprint: "\${state.status}", max_repeats: 12 }
  budget: { tokens: 200000, usd: 5.0, wallclock: "24h" }
  on_cap_exceeded: breakpoint

schedule: { mode: forever }
`;

const LOOP_UNTIL_DRY = `loopspec: "0.1"
id: bug-sweep
meta:
  name: bug-sweep
  description: Repeatedly hunt for issues until two consecutive passes find nothing new.
pattern: loop-until-dry

state:
  store: journal
  vars:
    found: { type: int, init: 1 }
    dry_passes: { type: int, init: 0 }

body:
  - id: hunt
    kind: agent
    harness: cli  # any coding agent via LOOPY_AGENT_CMD
    prompt: "Find one NEW issue not already fixed. Return a JSON object whose field 'new' is the count of new issues found this pass."
    save: { found: "$.new" }
  - id: count-dry
    when: "\${state.found == 0}"
    kind: shell
    cmd: ":"
    on_done: { incr: dry_passes }
  - id: reset-dry
    when: "\${state.found > 0}"
    kind: shell
    cmd: ":"
    on_done: { set: { dry_passes: 0 } }

terminate:
  signal: state-predicate
  until: "\${state.dry_passes >= 2}"

caps:
  max_iterations: 50
  no_progress: { fingerprint: "\${state.found}", max_repeats: 5 }
  budget: { tokens: 200000, usd: 5.0, wallclock: "2h" }
  on_cap_exceeded: exit-clean
`;

const EVALUATOR_OPTIMIZER = `loopspec: "0.1"
id: draft-refine
meta:
  name: draft-refine
  description: Generate, score against a rubric, and refine until the score clears the bar.
pattern: evaluator-optimizer

inputs:
  goal: { type: string, required: true }

state:
  store: journal
  vars:
    score: { type: number, init: 0 }
    rounds: { type: int, init: 0 }

body:
  - id: improve
    kind: agent
    harness: cli  # any coding agent via LOOPY_AGENT_CMD
    prompt: "Improve the artifact toward: \${inputs.goal}. Current score \${state.score}."
    on_done: { incr: rounds }
  - id: evaluate
    kind: agent
    harness: llm  # provider-agnostic; pure judgment, returns JSON
    prompt: "Score the artifact from 0 to 1 against the rubric for: \${inputs.goal}. Return a JSON object whose field 'score' is that number. (Supply your own rubric/oracle.)"
    save: { score: "$.score" }

terminate:
  signal: llm-judge
  until: "\${state.score >= 0.85}"

caps:
  max_iterations: 8
  budget: { tokens: 200000, usd: 5.0, wallclock: "1h" }
  on_cap_exceeded: breakpoint
`;

const REACT = `loopspec: "0.1"
id: react-task
meta:
  name: react-task
  description: A reason-act-observe loop that runs until the agent self-reports the goal is met.
pattern: react

inputs:
  goal: { type: string, required: true }

state:
  store: journal
  vars:
    done: { type: boolean, init: false }

body:
  - id: act
    kind: agent
    harness: cli  # any coding agent via LOOPY_AGENT_CMD
    prompt: "Goal: \${inputs.goal}. Take the single next action toward it. Return a JSON object whose boolean field 'done' is true only when the goal is fully met."
    save: { done: "$.done" }

terminate:
  signal: self-assess
  until: "\${state.done == true}"

caps:
  max_iterations: 15
  budget: { tokens: 200000, usd: 5.0, wallclock: "1h" }
  on_cap_exceeded: breakpoint
`;

const PLAN_EXECUTE_REFLECT = `loopspec: "0.1"
id: plan-execute-reflect
meta:
  name: plan-execute-reflect
  description: Plan, execute the next step, then reflect on completion — repeat until complete.
pattern: plan-execute-reflect

inputs:
  goal: { type: string, required: true }

state:
  store: journal
  vars:
    complete: { type: boolean, init: false }
    step_no: { type: int, init: 0 }

body:
  - id: plan-or-execute
    kind: agent
    harness: cli  # any coding agent via LOOPY_AGENT_CMD
    prompt: "Goal: \${inputs.goal}. If no plan exists yet, create one; otherwise execute the next planned step (step \${state.step_no})."
    on_done: { incr: step_no }
  - id: reflect
    kind: agent
    harness: llm  # provider-agnostic; pure judgment, returns JSON
    prompt: "Reflect on progress toward: \${inputs.goal}. Return a JSON object whose boolean field 'complete' indicates whether the goal is fully achieved."
    save: { complete: "$.complete" }

terminate:
  signal: self-assess
  until: "\${state.complete == true}"

caps:
  max_iterations: 20
  budget: { tokens: 300000, usd: 8.0, wallclock: "2h" }
  on_cap_exceeded: breakpoint
`;

const MAP_REDUCE = `loopspec: "0.1"
id: map-reduce-summarize
meta:
  name: map-reduce-summarize
  description: Fan out over a list of items, collect a per-item result, then combine once.
pattern: map-reduce

inputs:
  items: { type: json, required: true }

state:
  store: journal
  vars:
    results: { type: list, init: [] }
    done: { type: boolean, init: false }

body:
  - id: collect
    kind: reduce
    over: "\${inputs.items}"
    as: item
    body:
      - id: note
        kind: shell
        cmd: "echo processing \${item}"
        on_done: { append: { results: "\${item}" } }
  - id: finalize
    kind: agent
    harness: llm  # provider-agnostic; pure summarization
    prompt: "Combine these per-item results into one final summary: \${state.results}."
    on_done: { set: { done: true } }

terminate:
  signal: state-predicate
  until: "\${state.done == true}"

caps:
  max_iterations: 5
  budget: { tokens: 200000, usd: 5.0, wallclock: "1h" }
  on_cap_exceeded: exit-clean
`;

const CRON = `loopspec: "0.1"
id: cron-digest
meta:
  name: cron-digest
  description: One-shot run intended to be fired on a schedule by the host (e.g. system cron, a systemd timer, or a cloud scheduler).
pattern: cron

state:
  store: journal
  vars:
    sent: { type: boolean, init: false }

body:
  - id: build-and-send
    kind: agent
    harness: cli  # any coding agent via LOOPY_AGENT_CMD
    prompt: "Build today's digest and send it."
    on_done: { set: { sent: true } }

terminate:
  signal: state-predicate
  until: "\${state.sent == true}"

caps:
  max_iterations: 1
  budget: { tokens: 100000, usd: 2.0, wallclock: "30m" }
  on_cap_exceeded: exit-clean

schedule: { mode: cron, cron: "0 9 * * *" }
`;

const BLUEPRINTS: Record<string, Blueprint> = {
  react: { name: "react", pattern: "react", description: "Reason-act-observe until the goal is met.", yaml: REACT },
  "plan-execute-reflect": {
    name: "plan-execute-reflect",
    pattern: "plan-execute-reflect",
    description: "Plan → execute next step → reflect, until complete.",
    yaml: PLAN_EXECUTE_REFLECT,
  },
  "evaluator-optimizer": {
    name: "evaluator-optimizer",
    pattern: "evaluator-optimizer",
    description: "Generate → score against a rubric → refine until the bar is cleared.",
    yaml: EVALUATOR_OPTIMIZER,
  },
  "loop-until-dry": {
    name: "loop-until-dry",
    pattern: "loop-until-dry",
    description: "Repeat discovery until N consecutive passes find nothing new.",
    yaml: LOOP_UNTIL_DRY,
  },
  "map-reduce": {
    name: "map-reduce",
    pattern: "map-reduce",
    description: "Fan out over items, collect per-item results, then combine once.",
    yaml: MAP_REDUCE,
  },
  "poll-until": {
    name: "poll-until",
    pattern: "poll-until",
    description: "Poll an external status; act on change; exit on a target state.",
    yaml: POLL_UNTIL,
  },
  cron: { name: "cron", pattern: "cron", description: "One-shot run fired on a host schedule.", yaml: CRON },
};

export function listBlueprints(): Blueprint[] {
  return Object.values(BLUEPRINTS);
}

export function getBlueprint(name: string): Blueprint | undefined {
  return BLUEPRINTS[name];
}
