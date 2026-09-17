# Jev workflow designer implementation plan

Status: implemented; local validation complete; live smoke tests confirm nine representative selections. This is a small curated sample, not a general quality benchmark. Scope: optional authoring assistance, never runtime authority.

## User journey

1. Describe a goal and explicit constraints in a JSON brief (target, available effects,
   required external completion evidence, iteration/token/USD/wallclock caps, priorities).
2. `loopc recommend "goal" --brief brief.json --provider jev --out decision.json` evaluates
   the embedded recipe/blueprint catalog. Only the supplied brief and catalog metadata leave
   the machine. Offline mode makes no network request and labels heuristic ranking honestly.
3. Review three leading options, all rejected options and reasons, fit versus safety,
   uncertainty, missing inputs, and target capability warnings in the saved report.
4. `loopc design decision.json --select recipe:dependency-guardian --id dependency-watch
   --out ./dependency-watch` makes an explicit selection, rechecks hard constraints against
   the current catalog, applies caps, validates and verifies the scaffold, and writes a
   decision record, LoopSpec, fixture when available, and authoring handoff. No effects run.
5. Finish the listed inputs and goal-specific edits with an authoring agent, then use existing
   validate/verify/compile commands. Jev is not required for compilation or execution.

## Architecture and trust

- Core owns strict brief parsing, catalog descriptors, hard eligibility, deterministic ranking,
  centralized rubrics and weights, and scaffold construction. Core remains zero-I/O.
- Infer owns the bounded TypeSafe HTTP call and decision/design orchestration with verification.
- CLI and MCP expose the same functions. No new public package or runtime dependency.
- Jev answers typed per-candidate questions in a single request. It cannot invent candidates,
  edit caps, claim external grounding, run commands, or write a LoopSpec.
- Reports retain model/version, rubric version, input digest, provider token usage, numerical
  assessments, weights, exclusions, and limitations. Fit is not the Loopy safety score.
- Missing API key, invalid replies, timeout and rate limits produce actionable errors; there
  is no silent downgrade. A request is bounded and never automatically retried/billed twice.
- Offline mode is an explicit local heuristic alternative. Unknown evidence/tools are listed
  as unresolved, never inferred as facts. Tight scores trigger a review notice, not a claim
  of calibrated confidence. Explicit selection is required to create files.
- Output directories must be new; failed generation leaves no partial artifact. No execution,
  repository scanning, installation, or credential persistence occurs during design.

## Acceptance and validation

Cover constraint rejection, adversarial goals/provider output, malformed replies, usage validation,
no-key/offline behavior, bounded network I/O, deterministic ordering and explicit overrides,
cap application, provenance, scaffold validation/verification, non-overwrite behavior, CLI and MCP
round trips, and clean packed consumers. Run typechecks, full tests, deterministic evals, build,
docs generation/build, release parity, security audit, and packed onboarding smoke. Live Jev
quality comparison is separate from fixture correctness and requires a configured API key.

## Follow-up boundaries

A visual designer, generative free-form LoopSpec synthesis, runtime Jev routing, and automatic
activation are outside this authoring feature. Measure recommendation quality on labeled goals
before claiming improvement over the existing authoring skill.
