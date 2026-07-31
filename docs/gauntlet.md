# Gauntlet workflows

A Gauntlet is the opinionated choice for a substantial deliverable that has several distinct
quality dimensions and deserves independent review. Monkey D Loopy breaks the goal into
workstreams, gives each one to a fresh builder, asks a different fresh critic to inspect the
real artifact, and repeats bounded rounds until the workstreams and the combined result clear
the stated bar.

The important idea is separation of duties: the agent that produced a change does not get the
only vote on whether it is good. The journal preserves what was attempted, what each critic
found, and why another round ran.

## At a glance

| Variant | Best for | Who decides completion? | Native score |
|---|---|---|---:|
| Creative Gauntlet | Qualitative work such as UX, clarity, coherence, design, and launch polish | A fresh agent critic | 87/B |
| Verified Gauntlet | Work with an executable test, policy, benchmark, schema, or other trusted judge | An external oracle | 100/A |

These are workflow-safety scores, not predictions of how good the finished artifact will be and
not the implementation-review score of Monkey D Loopy itself. A lower Creative score honestly
prices model judgment as weaker completion evidence; it does not mean its builders or critics are
less capable.

## When to recommend it

Choose Gauntlet when most of these are true:

- There is one meaningful final artifact or release, not merely a list of unrelated jobs.
- The outcome has multiple reviewable workstreams such as implementation, UX, documentation,
  evidence, safety, or launch readiness.
- Each workstream benefits from a builder and an independent critic with fresh context.
- A final integration pass matters because individually good parts can still conflict.
- The quality gain justifies more agent calls, time, and cost than a simple loop.

Typical uses include product launches, multi-file features, websites, reports, migration
packages, research deliverables, and release-readiness work.

Do **not** default to Gauntlet for every iterative task:

- Use `react` for one small act/observe loop.
- Use `evaluator-optimizer` for one draft repeatedly graded against one rubric.
- Use `map-reduce` for many independent items followed by a mechanical combination.
- Use `plan-execute-reflect` when the main problem is ordered dependent steps.
- Use `poll-until` when external status changes are the center of the workflow.
- Prefer an existing verified recipe whenever it already matches the user's outcome.

If the task is small, has only one quality dimension, or has a cheap objective test, recommend
the simpler loop. Gauntlet's extra builders, critics, history, and holistic review would be
ceremony rather than leverage.

## Choose the completion authority

Use **Creative Gauntlet** when the bar is qualitative and expert judgment is genuinely needed:
clarity, coherence, usability, design quality, argument strength, or launch polish. Its critics
are agents, so describe completion honestly as model-judged.

Use **Verified Gauntlet** whenever a trusted external command can decide whether the artifact is
complete: tests, policy checks, schema validation, benchmark thresholds, compliance scanners, or
another repository-owned judge. The external judge chooses completion; agents only perform the
bounded repairs it identifies.

When advising a user, an agent should state:

1. why Gauntlet fits better than a simpler pattern;
2. the proposed workstreams and shared final artifact;
3. the quality bar and who decides completion;
4. the additional cost and iteration caps; and
5. whether Creative or Verified grounding is being recommended.

If those answers are unclear, gather them before scaffolding. Do not select Gauntlet solely
because a task is described as “important.”

## Build a Creative Gauntlet

Gauntlet is a first-class `gauntlet` LoopSpec pattern for improving a real artifact through
bounded, sequential workstreams. Start with the creative blueprint:

```sh
loopc new my-launch --blueprint gauntlet
```

The generated LoopSpec asks for:

| Input | Meaning | Default |
|---|---|---|
| `goal` | The outcome the combined artifact must achieve | required |
| `bar` | The concrete quality standard critics apply | required |
| `references` | Source material or constraints builders and critics must consider | required |
| `artifact_path` | The real artifact every agent inspects | `output/artifact` |
| `threshold` | Minimum critic score for passing | `90` |
| `smoothing` | Whether to run the integration builder | `true` |

### Creative lifecycle

```text
inspect and decompose once
  → reset bounded round state
  → for each workstream, sequentially:
      fresh builder edits its declared scope
      → separate fresh read-only critic inspects the real artifact
      → journal score, gap, evidence, and workstream identity
  → if every workstream passes, smooth the combined artifact
  → fresh holistic critic reviews the complete result
  → finish at the threshold, or begin another bounded round
```

The blueprint uses a fresh read-only lead to decompose the goal, then a deterministic `reduce`
to run one fresh builder and one separate, fresh read-only critic per workstream. Builders and
critics inspect the actual `artifact_path`, not a claimed summary. A smoothing builder and a
holistic critic only run after at least one workstream has passed. Current v1 semantics rerun all
workstreams in later rounds because `reduce` has no filter primitive; prior reviews are supplied
so previously passing builders can make no change.

Creative Gauntlet is model-judged (`llm-judge`). Its raw weighted score is **86.5/100**; the
official native API rounds this to **87/100 (B)**. It is useful for artifact-grounded iteration,
but it is not oracle-verified.

Its journal state includes the decomposed workstreams, readable review log, structured review
history, pass count, latest workstream score and gap, final score and gap, round count, and
decomposition status. A crash or restart resumes from that journal rather than asking agents to
reconstruct progress from conversation.

## Build a Verified Gauntlet

For a trusted external completion authority, use the verified recipe:

```sh
loopc new my-launch --recipe verified-gauntlet
```

Its `judge_command` is a trusted executable name or path invoked as `cmd` plus fixed argv values,
never shell concatenation. It returns redacted status/evidence JSON; only `complete` or `no-op`
can terminate the oracle workflow. Evidence is untrusted data: builders ignore any instructions
inside it, verify claims against the artifact, and never perform ungated destructive actions.
The recipe is designed for a native score of **100/100** (manifest minimum 99), and caps repeated
external fingerprints after three deterministic attempts.

### Verified lifecycle

```text
run the trusted judge against the real artifact
  → normalize and validate its response
  → if actionable, run fresh builders over its bounded workstreams
  → run the judge again
  → only complete or no-op may finish the loop
  → repeated fingerprints exit through deterministic no-progress protection
```

The judge response is data, not a prompt. Malformed envelopes, hostile titles or scopes,
duplicate identifiers, terminal responses containing workstreams, and prompt-injection attempts
are rejected before they can reach a builder.

Both variants are manual, journaled, artifact-allowlisted (`output/**`), bounded to eight rounds,
and expose their state through the local operator control center. The gallery provides exact CLI
handoff commands; authoring remains with CLI and MCP.

## Why Creative scores 87, and how to raise it honestly

Creative Gauntlet already receives full native points for caps, observability, resumability, and
determinism. Its complete score breakdown is:

| Dimension | Points |
|---|---:|
| Termination safety: honest `llm-judge`, agent-grounded | 16.5/30 |
| Explicit caps, no-progress protection, and budgets | 25/25 |
| Journal plus completed observer | 15/15 |
| Resumability | 15/15 |
| Determinism | 15/15 |
| **Raw / official total** | **86.5 / 87 B** |

Changing `signal` from `llm-judge` to `oracle` or `state-predicate` without changing the evidence
does not improve the workflow. Monkey D Loopy traces which steps feed the exit predicate and
downgrades an agent-fed claim. Relabeling would only make the documentation dishonest.

There are three legitimate upgrade paths:

| Evidence added to completion | Honest grounding | Expected native score |
|---|---|---:|
| Keep qualitative agent judgment only | agent | 87/B |
| Require both agent judgment and an external executable gate | mixed | 91/A |
| Let an external predicate decide completion | external | 96/A |
| Let a trusted external oracle decide completion | external oracle | 100/A |

The recommended product boundary is therefore:

- Keep Creative Gauntlet at 87/B for genuinely qualitative work.
- Use Verified Gauntlet for 100/A whenever objective completion evidence exists.
- Add a distinct hybrid/guarded variant only if users need agent critique plus a mandatory
  external gate. Do not silently change Creative semantics merely to increase its score.

## Create, prove, compile, and inspect

```sh
# Scaffold one variant
loopc new my-launch --blueprint gauntlet
# or: loopc new my-launch --recipe verified-gauntlet

# Prove the contract before any real execution
loopc validate my-launch.yaml
loopc verify my-launch.yaml
loopc score my-launch.yaml

# Compile the narrowest required target
loopc compile my-launch.yaml --target standalone --out ./out

# After a run, inspect the durable journal
loopc inspect ./out
```

CLI and MCP can both discover and scaffold the variants. The Operator catalog features them
first and displays grounding, score, grade, schedule, and the exact creation command. The
Gauntlet board projects rounds, workstreams, cleared count, score and threshold, largest gaps,
budget use, and allowlisted artifacts from journal state.

Standalone and Babysitter enforce native mutation and judge-envelope behavior. Claude Code,
Claude Native, and n8n remain useful compilation targets but surface explicit warnings where
they cannot enforce the same oracle semantics; agents must preserve those warnings when advising
users.

## Explanation agents can give users

Use this short explanation when introducing the recommendation:

> A Gauntlet divides one substantial deliverable into reviewable workstreams. Fresh builders
> improve each part, separate fresh critics inspect the actual artifact, and a final review checks
> that the parts work together. It costs more than a simple loop, so we use it when independent
> review and cross-workstream quality are worth that cost.

Follow it with the proposed workstreams and the completion authority. The explanation is not a
substitute for those concrete decisions.
