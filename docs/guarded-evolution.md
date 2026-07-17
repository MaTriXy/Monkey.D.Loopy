# Guarded evolution

Guarded evolution evaluates a complete candidate LoopSpec without changing the installed artifact.
Activation is a separate, attributable human decision. The deterministic comparator—not an agent or
model—decides which changes are fatal and which require an exact waiver.

## Lifecycle

```text
current LoopSpec + bounded journal summaries
  → isolated candidate directory
  → validate + verify + score + semantic diff
  → cap / grounding / capability regression gates
  → recipe fixture replay
  → human activate or reject
  → atomic source replacement + rollback pointer
```

Candidate directories live under the owner-only operator state root at
`~/.loopy/operator/revisions/<loop-id>/<candidate-id>/`. Each contains mode-`0600` copies of the base
and candidate YAML plus a schema-`1` evidence record. Proposing, failing, or rejecting a candidate
does not write to the artifact. Inspection never migrates a record implicitly; a newer record schema
must be handled by a compatible operator version.

The evidence record stores hashes, bounded semantic changes, scores, grounding classes, gate
results, representative fixture results, and at most five journal-derived run summaries. It never
passes journal event bodies, artifact contents, prompts, or transcripts to the comparator. Runtime
and artifact data are evidence, not instructions.

## Deterministic gates

The following conditions are fatal and cannot be waived:

- invalid YAML, LoopSpec validation failure, or a changed loop ID;
- failed boundedness, determinism, or resume-stability verification;
- a failing representative fixture for a verified built-in recipe.

The following require their exact displayed gate IDs in an approval:

- weaker termination signal or grounding;
- higher iteration/no-progress/cost/wallclock ceilings or a weaker cap action;
- new environment references;
- wider artifact includes, removed excludes, or larger artifact ceilings;
- new notification channels;
- lower score;
- capabilities newly used where any of the five compile targets cannot enforce them.

Unknown waiver IDs are rejected. Waivers, the approver, reason, old/new hashes, and score evidence
are written to the append-only operator audit log. Activation and rollback both refuse to run while
the scheduler owns an active claim or any host/standalone journal has a live lock.

Activation atomically replaces `loop.source.yaml`, conditionally updates the registry hash, and then
writes the active rollback pointer. A failed registry update restores the prior source bytes.
Rollback restores the stored base YAML byte-for-byte and does not rewrite historical journals.

## CLI

```bash
loopyd evolve propose my-loop ./candidate.loop.yaml --actor alice
loopyd evolve approve my-loop candidate-1700000000000-abc123 \
  --actor alice --reason "reviewed score, diff, and fixtures"

# A regression approval names every required gate explicitly.
loopyd evolve approve my-loop candidate-1700000000000-def456 \
  --actor alice --reason "approved temporary budget increase" \
  --waive budget-tokens,budget-wallclock

loopyd evolve reject my-loop candidate-1700000000000-ghi789 \
  --actor alice --reason "insufficient external grounding"
loopyd evolve rollback my-loop --actor alice --reason "restore known-good revision"
```

## Local API

Every route uses the same loopback token/cookie authentication, same-origin check, JSON content
type, and 64 KiB request ceiling as the rest of `/api/v1`.

| Method | Route | Body / result |
|---|---|---|
| `POST` | `/api/v1/loops/:id/evolution/candidates` | `{ yaml, actor? }` → isolated candidate |
| `GET` | `/api/v1/loops/:id/evolution/candidates` | all candidate, active, rejected, rolled-back, and superseded records |
| `POST` | `/api/v1/loops/:id/evolution/candidates/:candidate/actions` | `{ action: "activate"|"reject", actor?, reason, waivers? }` |
| `POST` | `/api/v1/loops/:id/evolution/rollback` | `{ actor?, reason }` → rolled-back record |

The bundled control center exposes the same lifecycle. It shows score and grounding movement,
semantic changes, deterministic gates, fixture results, bounded evidence counts, decisions, and
distinct revision states. Required waiver IDs must be entered exactly before activation is enabled.

Candidate authoring is deliberately separate from activation. A person or any provider-agnostic
agent harness may produce the YAML; neither receives authority to bypass the deterministic gates.
