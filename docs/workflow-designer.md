# Workflow designer with Jev

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
`--json` prints the full report for tooling. No eligible candidates returns exit code 2 and still
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
answer types, ranges, probability distributions, legends, usage, and score consistency, then
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

## MCP and coding agents

`recommend_workflow` accepts `brief`, `provider`, optional `model`, and `allowExternal`.
Offline is the default. Jev requires `allowExternal: true` and a server-side `TYPESAFE_API_KEY`;
clients must obtain the user's provider choice before transmitting the brief. Never put API keys
in MCP arguments.

`design_workflow` accepts the JSON report as a string, `selection`, and `id`. It returns the
scaffold YAML, fixtures, verification, safety score, and authoring handoff inline. It writes no
files and executes no real effects. The existing `validate_loop`, `verify_loop`, and `compile_loop`
tools finish the authoring path after goal-specific edits.

The TypeSafe [agent skill](https://docs.typesafe.ai/agent-skill) can help an authoring agent
understand TypeSafe decisions, but installation is not required to use Loopy's integration.

## Validation limits

Deterministic tests cover API contracts, adversarial responses, hard exclusions, selection,
scaffolding, and packaged CLI behavior. They do not establish that Jev selects better workflows
than another model or a human. Compare against labeled goals before tuning rubrics or making
quality or speed claims. Live API availability and quality require separate credentialed checks.
