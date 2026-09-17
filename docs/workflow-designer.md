# Workflow designer with Jev

**Source preview:** these commands/tools are not in published 0.8.0. See
[availability and setup](./availability.md) before trying them.

Turn a goal into a structured choice between Loopy recipes and blueprints, then create a
validated scaffold. Jev is an optional authoring service from TypeSafe; the resulting loop
has no Jev runtime dependency.

The path is **brief → constraints → comparison → explicit selection → scaffold → verification**.
The designer selects existing workflow structures. It does not invent an executable implementation
of your goal: an authoring agent or developer finishes the prompts, evidence integration, and inputs.

## Try it without an API key

```sh
loopc recommend "Prepare policy-compliant dependency updates for review" \
  --provider offline --out decision.json
loopc design decision.json --select recipe:dependency-guardian \
  --id dependency-watch --out ./dependency-watch
```

Offline mode is a deterministic lexical baseline. It searches catalog words and prefers less
coordination; it cannot understand arbitrary natural language as Jev can. It reports no model
confidence. A low-fit or close ranking asks you to review the alternatives.

The report displays the three leading choices and retains all eligible and excluded candidates
in JSON. You may explicitly select any eligible candidate, including one outside the top three.
`--json` prints the full report for tooling. No eligible candidates, or a leading goal-fit score below
2/4, returns no recommendation (`recommendedId: null`), exit code 2, and still
writes the report, if requested. Invalid input or provider failure returns a nonzero exit code.

## Use Jev

Set `TYPESAFE_API_KEY` in your environment using your normal secret manager. Then:

```sh
loopc recommend "Prepare policy-compliant dependency updates for review" \
  --brief brief.json --provider jev --out decision.json
```

Choosing `--provider jev` sends the supplied brief and embedded catalog descriptors to TypeSafe.
Loopy does not inspect your repository or upload files. Do not include secrets in the goal or brief.
The API key is sent only in the Authorization header to the fixed HTTPS TypeSafe endpoint and
is never stored in the decision report. Provider error bodies are not echoed.

The default model is pinned to `jev-1.13.0`; `--model jev-latest` opts into TypeSafe's moving alias.
The response model ID is saved. All eligible candidates' fit and simplicity questions are batched
in one request. The request has a 30-second total timeout and 256 KB response limit, rejects redirects,
and makes no automatic retries. Rate-limit/overload errors ask you to retry later. There is no
silent offline fallback. With no eligible candidates, no API call is made.

The response records provider-reported input/output tokens. Workflow caps apply to execution,
not to this separate authoring call. The designer does not infer dollar cost or claim an authoring
USD cap. See TypeSafe's [API reference](https://docs.typesafe.ai/api) and
[models](https://docs.typesafe.ai/models) for the provider's contract and pricing.

## Supply a brief

```json
{
  "goal": "Prepare policy-compliant dependency updates for review",
  "target": "standalone",
  "completionEvidence": "external",
  "availableEffects": ["agent", "http"],
  "requireExternalCompletion": true,
  "requireRuntimeGuarantees": true,
  "caps": {
    "maxIterations": 5,
    "tokens": 40000,
    "usd": 2,
    "wallclock": "30m"
  },
  "priorities": { "fit": 3, "simplicity": 1 }
}
```

The positional goal, when supplied, overrides the brief's goal. Unknown fields are rejected.

| Field | Meaning |
|---|---|
| `completionEvidence` | `external`, `agent`, or `unknown` (default). Your declaration of available evidence, not proof that it works. |
| `availableEffects` | Optional allowlist of `agent`, `shell`, `http`. Missing means unconfirmed; an empty list excludes workflows requiring these effects. It does not check installed binaries or credentials. |
| `requireExternalCompletion` | Excludes workflows whose completion is not externally grounded. Also requires an explicit `external` evidence declaration. |
| `requireRuntimeGuarantees` | Defaults to true. Rejects targets that cannot enforce journals, replay, iteration and token/USD/wallclock caps. Set false only after reviewing capability warnings. |
| `caps` | Optional tighter limits applied to the selected scaffold. They never increase a catalog cap. Omitted limits retain catalog defaults. |
| `priorities` | Positive fit/simplicity weights, default 3:1. Stored with the report; edit the brief and recommend again to change them. |

The current effect allowlist describes step families, not individual tool permissions. Review
harness permissions and external evidence services before real execution.

## Understand the decision

Loopy filters eligibility deterministically before contacting Jev. Jev answers two five-level
questions per eligible candidate: goal fit and minimal sufficient coordination. Loopy validates
answer types, ranges, probability distributions, legends, usage, and score consistency (allowing
for independently rounded two-decimal provider values), then
computes a weighted suitability score. A model response cannot introduce a new candidate, change
caps, turn agent judgment into external grounding, or override an exclusion.

Suitability is **not** the Loopy safety score, a success probability, or a claim that the choice
is globally optimal. Confidence describes the provider's distribution, not calibrated correctness.
The report includes numerical components and weights rather than inventing a model-authored
explanation. Scores within five points are flagged for review; this is a presentation policy,
not a statistically calibrated threshold. Rubrics live in `packages/core/src/recommend.ts`.

Reports preserve the normalized brief, model, rubric/factory versions, token usage, exclusions,
and input/catalog digests. Digests detect drift; they are not signatures or proof of authenticity.
Saved reports are advisory input, never execution authority. Selection rechecks current constraints.

## Complete the scaffold

`loopc design` requires an explicit candidate ID, a kebab-case loop ID, and a **new** output
directory. It refuses existing destinations. It produces:

- `loop.yaml`: selected catalog workflow, goal metadata, target, and tightened caps.
- `decision.json`: original comparison, explicit selection, verification, and safety score.
- `fixtures.json`: for recipes, terminal external evidence derived from the catalog's success fixture.
- `README.md`: remaining inputs, warnings, and exact validate/verify/compile commands.

Terminal fixtures exercise completion, not every repair transition. Existing recipe regression
fixtures cover the broader lifecycle. Blueprints without fixtures may stop under caps during dry-run;
the verification report and handoff disclose whether natural completion was reached.

```sh
cd dependency-watch
# Review and adapt loop.yaml, then provide the required evaluation_url input at runtime.
loopc validate loop.yaml
loopc verify loop.yaml --fixtures fixtures.json
loopc compile loop.yaml --target standalone --out compiled
```

The dependency recipe uses an external evaluation URL; it does not silently invent an audit
service. Editing a goal in metadata alone does not implement it. The authoring handoff makes
these remaining steps explicit. No shell, HTTP, or agent effects run during mock verification.

## Improve a workflow over multiple rounds

The refinement path is **current YAML → feedback and evidence → authored proposals → checks →
Jev comparison → retained or revised draft → another round**. The user or coding agent writes
1–4 concrete proposals; Jev evaluates their actual source. Loopy never rewrites prompts from a
score, automatically runs a workflow, or activates a revision.

Ask your coding agent: “Improve this workflow using the failures from the last run. Draft two
alternatives, compare them with Jev, and show me the selected revision and its changes.” With MCP,
the agent can use `refine_workflow` directly. With the CLI, prepare a request from files:

```js
// prepare-refinement.mjs (run with node)
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const current = readFileSync('workflow/loop.yaml', 'utf8');
const proposal = readFileSync('proposal.yaml', 'utf8');
// Same YAML digest used by revisionDigest() in @loopyc/infer.
const digest = createHash('sha256').update(JSON.stringify(current)).digest('hex');
writeFileSync('refinement.json', JSON.stringify({
  brief: {goal: 'Produce an accurate article with source-backed claims', completionEvidence: 'agent'},
  current,
  proposals: [{id: 'claim-checking', yaml: proposal}],
  feedback: 'Make the evaluator identify unsupported claims and give actionable corrections.',
  // Optional: include only observations actually obtained from this exact revision.
  // evidence: [{revisionDigest: digest, summary: 'Describe measured results here.'}],
  evidence: []
}, null, 2), {mode: 0o600});
```

```sh
node prepare-refinement.mjs
loopc refine refinement.json --provider offline --out revisions/check-1
loopc refine refinement.json --provider jev --out revisions/round-1
```

`--provider jev` explicitly transmits the supplied brief, eligible workflow YAML, feedback, and
evidence to TypeSafe. Unlike catalog recommendation, this includes your workflow source: remove
embedded secrets and unrelated/private data first. It does not discover files or read journals.
Fixtures are used locally and are not sent to Jev. Each round makes at most one bounded API call,
with no automatic retries; if every proposal is excluded, it makes none. Offline mode only checks
proposals and retains the current version; it does not score semantic improvements.

Each new directory includes `loop.yaml` with the **exact selected bytes**, `decision.json` with
the complete request, changed field paths, checks, scores, model, usage and digests, optional
`fixtures.json`, and a handoff. Existing directories are never overwritten. `--json` also prints
the report. A retained current version is a successful review (exit 0), not a provider failure.

For the next round, set `current` to `revisions/round-1/loop.yaml`, add new proposals and feedback,
and run:

```sh
loopc refine next-refinement.json --provider jev \
  --previous revisions/round-1/decision.json --out revisions/round-2
```

The previous report must be unchanged and its selected YAML must match the new baseline exactly.
Each round records its number and parent digest. Keep prior directories to retain the full chain
and to return to an earlier draft; no workflow is activated by refinement. Comparisons always
rescore the current version alongside proposals. Scores from different rounds, briefs, or models
are not a trend or evidence of steadily increasing quality.

Before Jev sees a proposal, Loopy requires validation with explicit caps, matching brief constraints,
mock verification, no decrease in safety score, and no loss of natural completion under the same
fixtures. This refinement path preserves completion rules, caps, inputs, state, target, gates,
schedules, external effects and their relative order. It permits prompts, metadata, pattern labels,
and agent-task sequencing changes under existing agent contracts; it rejects new harness/permission/
state-write contracts and environment references. Broader changes to those protected controls need
separate authoring and review. These checks do not prove that arbitrary agent behavior is safe or
that a revised prompt produces better results.

Jev must prefer a proposal by at least 5 suitability points, with fit at least 2/4, no lower fit than
the current version. Otherwise the current version stays
selected. Provider confidence below 0.5 is a review warning, not an acceptance gate. These are conservative, uncalibrated selection rules, not a guarantee of optimization.
Review the source diff and test the selected draft on representative tasks before execution.

A request is limited to 256 KB, four proposals (48,000 characters each), 6,000 feedback characters,
and eight evidence summaries of 4,000 characters each. Each evidence item carries the digest of a
revision in that comparison; unknown digests are rejected. Evidence is explicitly user-supplied,
not independently verified. Optional `fixtures` has the same `agent`, `shell`, and `http` response
shape used by `loopc verify`. It tests mocked structural behavior, not real task quality.

## MCP and coding agents

`recommend_workflow` accepts `brief`, `provider`, optional `model`, and `allowExternal`.
Offline is the default. Jev requires `allowExternal: true` and a server-side `TYPESAFE_API_KEY`;
clients must obtain the user's provider choice before transmitting the brief. Never put API keys
in MCP arguments.

`design_workflow` accepts the JSON report as a string, `selection`, and `id`. It returns the
scaffold YAML, fixtures, verification, safety score, and authoring handoff inline. It writes no
files and executes no real effects. The existing `validate_loop`, `verify_loop`, and `compile_loop`
tools finish the authoring path after goal-specific edits.

`refine_workflow` accepts `request` (the object above), optional `previous` (the previous refinement
report serialized as JSON), `provider`, `model`, and `allowExternal`. It returns all revision checks,
rankings, selected ID/digest and source inline. Find the selected bytes in `checks` by `selectedId`.
Jev requires `allowExternal: true`; authorization already given for the same scope need not be
requested again each round. Each call is one round, not an unbounded background optimization loop.

The TypeSafe [agent skill](https://docs.typesafe.ai/agent-skill) can help an authoring agent
understand TypeSafe decisions, but installation is not required to use Loopy's integration.

## Validation limits

Deterministic tests cover API contracts, adversarial responses, hard exclusions, selection,
scaffolding, and packaged CLI behavior. They do not establish that Jev selects better workflows
than another model or a human. Compare against labeled goals before tuning rubrics or making
quality or speed claims. Live API availability and quality require separate credentialed checks.


## Run the checked-in refinement example

From a source checkout's repository root:

```sh
node --import tsx packages/cli/src/index.ts refine examples/jev-refinement.json \
  --provider offline --out .loopy/docs-example/round-1
node --import tsx packages/cli/src/index.ts refine examples/jev-refinement.json \
  --provider offline --previous .loopy/docs-example/round-1/decision.json \
  --out .loopy/docs-example/round-2
```

The example compares a generic article prompt with an explicit accuracy rubric. Its feedback is
an authoring hypothesis, not invented run evidence. Offline rounds retain the current YAML and
exercise validation, verification, saving and lineage. Each destination must be new. To compare
with Jev, use a fresh output directory, `--provider jev`, and an explicitly configured environment.
A Jev round can select a proposal, so subsequent requests must use its selected YAML as `current`;
do not blindly reuse the original example after the selected version changes.
