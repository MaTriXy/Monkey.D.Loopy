# Operator Platform Roadmap

- Status: **approved for implementation**
- Scope: productization after the current LoopSpec/compiler/runtime foundation
- Competitive input: [Loopany](https://github.com/superdesigndev/loopany-platform), reviewed
  2026-07-16

## 1. Outcome

Monkey D Loopy should become the safest way to author **and operate** recurring agent work:

> Define the loop once, prove its guarantees, then run and observe it anywhere.

The project already owns the difficult correctness layer: a declarative LoopSpec, mandatory
termination and caps, deterministic verification, grounding analysis, crash-resumable journals,
cost enforcement, and multiple compile targets. The next product layer should make those
guarantees easy to discover and operate without replacing them with a hosted workflow engine or
prompt-only control plane.

The roadmap therefore adds four product capabilities in order:

1. trustworthy runtime and release hygiene;
2. verified, outcome-oriented recipes;
3. an optional local operator and control center;
4. artifact, notification, and guarded-evolution workflows.

A remote team control plane is a later option, not a prerequisite.

The active delivery goal covers Phases 0–5 through the `0.5.0` release. Phase 6 remains a
separately approved product and threat-model decision and is not part of the current Definition of
Done.

## 2. Product thesis

The competitive distinction is not “we also schedule agents.” It is:

| User need | Typical loop platform | Monkey D Loopy target |
|---|---|---|
| Start quickly | Canned prompt | Verified recipe compiled from LoopSpec |
| Know it stops | Convention or agent promise | Required termination, caps, and boundedness proof |
| Know “done” is real | Agent self-report | Grounding analysis and external-evidence score |
| Survive interruption | Process retry | Journal replay, safe stop, and explicit uncertain-effect handling |
| Control cost | Post-hoc usage display | Enforced token, USD, iteration, no-progress, and wallclock caps |
| Operate many loops | Hosted dashboard | Local-first control center over canonical journals |
| Improve a loop | Agent rewrites instructions | Candidate spec diff gated by validate, verify, score, and approval |
| Move between tools | Platform daemon | Portable artifacts plus an optional operator |

The short positioning line is:

> Other tools schedule agent loops. Monkey D Loopy proves them safe, then runs them anywhere.

## 3. Design constraints

These are release gates, not aspirations.

### 3.1 The runtime stays canonical

- `@loopyc/runtime` remains the only execution-semantics authority.
- The operator calls the runtime; it does not reimplement caps, replay, effects, or termination.
- Compiled standalone artifacts continue to run without an operator.
- `--vendor` continues to produce a zero-install artifact.
- Existing compile targets remain useful independently of any dashboard.

This refines the M9 scheduling decision rather than reversing it: host-native installable triggers
stay supported and artifact-only remains the default. The future operator is an **opt-in second
scheduler** for users who want centralized local operations.

### 3.2 Local-first and offline by default

- The first operator binds to loopback only.
- Starting the control center makes no network call unless a configured loop does.
- Journals and artifacts stay on the user's machine.
- No account, cloud service, or remote database is required.
- Remote access must not be enabled until authentication and a threat model ship together.

### 3.3 Safety must be visible

The operator UI must surface the properties that differentiate the project:

- verification result and score;
- termination signal and grounding tier;
- cap configuration and remaining budget;
- current iteration and no-progress fingerprint;
- journal integrity and replay status;
- pending breakpoint, sleep, or uncertain effect;
- provider/model usage and cost provenance.

A generic green/red run list is insufficient.

### 3.4 No prompt-only feature may weaken a hard guarantee

- Recipes are real LoopSpecs, not prose pasted into an agent.
- Evolution creates a candidate; it never silently mutates the active spec.
- A generated candidate cannot reduce termination strength, grounding, or caps without an explicit
  human waiver.
- Arbitrary agent-authored JavaScript is not a LoopSpec step kind.
- UI and notification features consume journals; they do not invent a second status truth.

### 3.5 Protocols before platforms

Local operator APIs and journal-derived views should be versioned before any remote control plane
is attempted. The remote platform, if built, must use the same protocol and treat the local
operator as the execution authority.

### 3.6 No telemetry by default

- The local operator emits no analytics, crash reports, or usage telemetry unless explicitly
  configured.
- Provider calls made by loops remain governed by each LoopSpec and are not operator telemetry.
- Diagnostic export is a deliberate command that previews and redacts the bundle before writing it.

## 4. Target architecture

```text
LoopSpec
   |
   +-- @loopyc/core -------- validate / normalize / plan / capability matrix
   +-- @loopyc/verify ------ interpret / boundedness / determinism / score
   +-- @loopyc/runtime ----- execute / journal / replay / caps / effects
   |          |
   |          +-- standalone artifact (still independent)
   |          +-- @loopyc/operator (optional)
   |                    |
   |                    +-- registry + scheduler + run controller
   |                    +-- local HTTP/event API
   |                    +-- control-center web assets
   |
   +-- @loopyc/cli -------- authoring + operator lifecycle commands
   +-- @loopyc/mcp -------- authoring + read/control tools with scoped authority
```

### 4.1 Proposed new package

`@loopyc/operator` owns:

- an opt-in `loopyd` process;
- a registry of installed LoopSpecs and artifact locations;
- schedule evaluation and dispatch;
- run, step, pause, approve, resume, stop, and inspect operations;
- a journal-derived read model;
- a loopback HTTP API plus event stream;
- bundled static control-center assets.

It must not own:

- LoopSpec validation or lowering;
- execution semantics;
- provider SDK logic;
- a second journal format;
- remote team authentication in the first release.

### 4.2 CLI surface

The planned operator-facing commands are:

```text
loopc recipes
loopc new <id> --recipe <recipe>
loopc operator install <spec-or-artifact>
loopc operator up|status|down
loopc operator list
loopc operator run|pause|resume|stop <loop-id>
loopc ui
loopc evolve <loop-id> [--from-runs <n>]
```

Names are part of the implementation review: do not ship aliases or a second command vocabulary
until this surface has been tested end to end.

### 4.3 Local state layout

The proposed operator state is inspectable files under `~/.loopy/operator/`:

```text
config.json
registry/<loop-id>.json
events/<date>.jsonl
pid
token
```

Run truth remains in each artifact's `.loopy/` journal. Registry updates use a lock plus atomic
write/rename; operator actions append an audit event. An embedded database is deliberately deferred
until measured registry or query scale requires one.

### 4.4 Decisions fixed by plan review

The following policies are fixed before implementation so later phases do not invent conflicting
semantics.

#### Forced-interruption recovery

A graceful stop is honored only at a journal-safe boundary. If the process is forcibly interrupted
after an effect's `pending` record but before `done`, resume enters a non-terminal **uncertain**
pause. It must never silently retry and must never convert uncertainty into a permanent generic
failure.

Recovery requires one explicit action:

- `retry` — re-run with documented at-least-once risk;
- `assume-done` — provide/confirm the recovered result when the external system proves completion;
- `abort` — terminate intentionally while preserving the uncertain record.

The action, actor, reason, and original effect identity are journaled. The operator presents these
choices but the policy lives in `@loopyc/runtime` and is available without the operator.

#### One scheduler authority per loop

An installed loop records `host` or `operator` as its scheduling authority. Operator install detects
generated host-trigger files and refuses to enable its schedule until the user explicitly hands off
authority. Switching back disables operator dispatch before printing host-install instructions.
This prevents cron/systemd/launchd/GitHub Actions and `loopyd` from firing the same loop twice.

#### Version and migration policy

- Public workspace packages share one release version through `0.x`.
- Operator API responses include an API version; registry files include a schema version.
- The operator reads supported old journal/registry versions without rewriting them on inspection.
- Mutating migration is explicit, backed up, atomic, and covered by downgrade diagnostics.
- A newer unsupported format is read-only and visibly version-skewed, never guessed.

#### Control-center implementation boundary

- `@loopyc/operator` owns the Node service and bundled assets.
- `apps/control-center` owns a React/Vite web application compiled into those assets.
- The browser never reads journals directly; the versioned operator API serves the canonical read
  model.
- All API routes, including reads, require the local token because prompts, paths, and artifacts may
  be sensitive.
- The service binds to loopback, denies cross-origin access by default, validates `Origin` on
  mutations, caps request bodies, and creates token/config files with owner-only permissions.

#### Initial platform support

- macOS and Linux support foreground and managed-background operator lifecycle in `0.3.0`.
- Windows supports the foreground service and control center in `0.3.0`; managed background startup
  is deferred until it has native lifecycle and CI coverage.
- Every unsupported lifecycle command fails with a useful command/path, never a silent no-op.

#### Recipe/artifact sequencing

Phase 1 recipes document and test expected output conventions using existing loop state/files, but
do not depend on the future `artifacts:` field. Phase 4 migrates those conventions into a validated
artifact contract without changing the recipe's termination or evidence semantics.

#### Initial notification surface

`0.4.0` ships a bounded generic webhook adapter with multiple named channel configurations. Vendor-
specific adapters are later additions over the same interface. Shell-command notification adapters
are excluded because they would add a second code-execution surface.

## 5. Delivery plan

Each phase has an independent user outcome and a hard exit gate. Later phases do not begin merely
because earlier code exists; their exit gate must pass.

### Phase 0 — Trust and release baseline (`0.1.1`)

**Outcome:** the published packages match the repository and the runtime is safe to supervise.

Work:

1. Fix non-Claude usage-envelope budget poisoning ([#8](https://github.com/MaTriXy/Monkey.D.Loopy/issues/8)).
2. Add journal-safe external stop semantics and documented uncertain-effect recovery
   ([#9](https://github.com/MaTriXy/Monkey.D.Loopy/issues/9)).
3. Make agent timeout/buffer limits configurable with distinguishable failure diagnostics
   ([#6](https://github.com/MaTriXy/Monkey.D.Loopy/issues/6)).
4. Publish the merged Claude-native target and all six packages from one versioned release
   ([#7](https://github.com/MaTriXy/Monkey.D.Loopy/issues/7)).
5. Add a release-parity CI check: package versions, CLI help, generated target list, and docs agree.

Exit gate:

- a model-produced `usage` object cannot alter a trusted meter;
- a requested stop at every journal boundary is resumable;
- a forced kill in the uncertain window produces the recoverable `uncertain` pause and supports
  explicit retry, assume-done, or abort recovery;
- agent limit failures name the limit that fired;
- packed tarball smoke tests cover `claude-native`;
- npm and repository surfaces report the same version and targets.

### Phase 1 — Verified recipe catalog (`0.2.0`)

**Outcome:** a user can go from a recognizable goal to a high-quality runnable loop in minutes.

Recipes are distinct from the existing blueprints:

- a **blueprint** demonstrates one structural loop pattern;
- a **recipe** is an opinionated product use case with inputs, schedule, evidence source, expected
  artifacts, safety rationale, and a minimum score.

First catalog:

1. `repo-health-doctor` — inspect, fix one proven issue, verify, and stop;
2. `dependency-guardian` — evaluate dependency PRs against the exact head without auto-merging by
   default;
3. `docs-drift-sweep` — compare changed code to documentation and produce no activity on zero drift;
4. `production-error-sweep` — separate actionable errors from noise without copying secrets;
5. `release-follow-up` — watch a concrete observation source until a finish condition is met;
6. `market-signal-monitor` — produce one evidence-linked report per scheduled period.

Repository shape:

```text
recipes/<name>/recipe.json
recipes/<name>/<name>.loop.yaml
recipes/<name>/README.md
recipes/<name>/fixtures/
```

CLI/MCP work:

- `loopc recipes` / `list_recipes`;
- `loopc new <id> --recipe <name>` / `new_loop` recipe option;
- recipe metadata included in generated `loop.lock`;
- CI verifies every recipe and rejects score or capability regressions.

Exit gate:

- every recipe validates, verifies, compiles, and scores at least 90;
- termination is externally grounded where the use case permits it;
- every scheduled recipe has max-iteration, no-progress, USD/token, and wallclock protection;
- fixture tests include success, no-op, cap, and malformed-evidence cases;
- expected output conventions work without relying on the Phase 4 `artifacts:` field;
- a fresh user can create and run one recipe in under five minutes from the README path.

### Phase 2 — Read-only local control center (`0.3.0-alpha.1`)

**Outcome:** users can see all installed loops and understand their safety/run state without reading
JSONL manually.

Work:

- create `@loopyc/operator` with registry, loopback server, and read model;
- add `operator install`, `operator up|status|down`, `operator list`, and `ui`;
- index existing journals without rewriting them;
- show loop cards, run timeline, score, grounding, caps, cost, breakpoints, sleeps, and integrity;
- add live updates through an event stream with polling fallback;
- include an explicit “source of truth” link/path for every displayed state.

Exit gate:

- importing an existing artifact is non-mutating;
- the read model produces the same terminal/current state as runtime replay for a corpus of journals;
- corrupted, truncated, uncertain, locked, and version-skewed journals are visible and never shown
  as healthy;
- server binds to loopback and requires its local token for every route, including reads;
- CORS, Origin validation, request-size caps, and owner-only token/config permissions have
  regression coverage;
- startup to useful dashboard is under two seconds for 100 loops / 10,000 journal events.

### Phase 3 — Operator scheduling and control (`0.3.0`)

**Outcome:** users can safely operate multiple loops from one local process.

Work:

- add scheduler and run controller on top of `@loopyc/runtime`;
- implement run, step, pause, approve, resume, and stop;
- preserve host-native scheduler files as a supported alternative;
- enforce exactly one recorded scheduler authority per loop and require explicit handoff;
- add per-loop concurrency policy and missed-run policy;
- add daemon crash recovery, stale PID/lock handling, and version-skew diagnostics;
- audit every operator mutation in the operator event log and target run journal where applicable.

Defaults:

- one in-flight run per loop;
- no catch-up storm: retain only the newest missed invocation unless configured otherwise;
- stop is graceful first, forceful only after an explicit timeout;
- operator shutdown waits for journal-safe boundaries;
- no automatic daemon installation or background startup during `npm install`.

Exit gate:

- duplicate dispatch cannot create two active runs for one loop;
- sleep/wake and machine restart preserve schedule state;
- stop/resume red-team tests cannot poison an otherwise recoverable journal;
- every action is attributable by timestamp, actor surface, loop, run, and spec hash;
- artifacts remain runnable when removed from the operator.

### Phase 4 — Artifact and notification contracts (`0.4.0`)

**Outcome:** useful loop products are visible and can reach users without turning the loop folder
into an unbounded sync surface.

Proposed additive LoopSpec fields:

```yaml
artifacts:
  include: ["reports/**/*.md", "metrics/*.json"]
  exclude: ["**/.env*", "**/node_modules/**"]
  max_files: 1000
  max_bytes: 50000000

notify:
  policy: on-change   # never | on-change | on-failure | always
  channels: [ops]
```

The exact schema requires its own design review. Required behavior:

- allowlisted artifacts only, with file/count/byte ceilings;
- secrets and unsafe paths rejected at validation and ingestion boundaries;
- Markdown, JSON, text, images, and diffs first; no arbitrary HTML execution;
- notification adapters receive a bounded summary and local artifact links by default;
- channel credentials come from environment/config references, never LoopSpec literals;
- retries, deduplication keys, failure streak suppression, and delivery audit events;
- the first external adapter is a generic webhook; shell-command delivery is not supported.

Exit gate:

- adversarial path, symlink, MIME, HTML, and secret-leak corpus passes;
- artifact indexing cannot block or fail the underlying loop run;
- notification retries cannot duplicate a success beyond the documented delivery semantics;
- zero configured channels means zero external calls.

### Phase 5 — Guarded evolution (`0.5.0`)

**Outcome:** loops can improve from evidence without silently weakening their guarantees.

Pipeline:

```text
recent journals + current LoopSpec
  -> candidate LoopSpec in an isolated workspace
  -> semantic spec diff
  -> validate
  -> verify
  -> score
  -> capability / grounding / cap regression check
  -> representative fixture evals
  -> human approval
  -> atomic activation + rollback pointer
```

Hard rules:

- the active spec is never edited in place before approval;
- a candidate cannot remove caps, weaken termination, lower grounding, expand env access, add
  artifact paths, or increase budget without an explicit highlighted waiver;
- evolution receives bounded summaries by default and opens full transcripts only when requested;
- untrusted run/artifact content is labeled as data, never instructions;
- activation records old/new spec hashes, score diff, approver, and reason;
- rollback is one command and does not alter historical journals;
- the candidate authoring path may use the existing provider-agnostic LLM/agent harnesses, but the
  comparator and every activation gate are deterministic code.

Exit gate:

- a red-team corpus proves prompt-injected run content cannot bypass the regression gate;
- failed or rejected evolution leaves the active loop byte-for-byte unchanged;
- score and capability changes are reproducible from stored evidence;
- the operator can display candidate, active, rejected, and rolled-back revisions distinctly.

### Phase 6 — Optional team control plane (`1.0 candidate`, separate decision)

**Outcome:** teams can coordinate local operators without giving the server code-execution authority.

This phase does not start until a dedicated protocol and threat-model review approves it.

Minimum boundaries:

- local operator remains the execution authority;
- remote service schedules, authenticates, stores explicitly selected metadata/artifacts, and
  notifies; it does not execute LLMs or repository code;
- device enrollment, scoped leases, revocation, RBAC, retention, audit, and encryption ship
  together;
- remote sync is opt-in per loop and deny-by-default per artifact path;
- self-hosting is supported before a managed hosted promise is made.

## 6. Implementation slices

Keep PRs independently reviewable. Do not combine the roadmap into one platform rewrite.

| Slice | Suggested branch | Depends on | Deliverable |
|---|---|---|---|
| P0.1 | `fix/usage-meter-trust` | none | #8 fix + adversarial tests |
| P0.2 | `fix/journal-safe-stop` | none | #9 stop/recovery contract + tests |
| P0.3 | `fix/agent-exec-limits` | none | #6 configuration + diagnostics |
| P0.4 | `chore/release-0.1.1` | P0.1–P0.3 | #7 parity gate + publish |
| P1.1 | `feature/recipe-contract` | P0.4 | recipe schema/catalog loader |
| P1.2 | `feature/verified-recipes` | P1.1 | first six recipes + eval corpus |
| P1.3 | `feature/recipe-cli-mcp` | P1.1 | CLI/MCP authoring surface |
| P2.1 | `feature/operator-read-model` | P0.2 | canonical journal-derived state |
| P2.2 | `feature/local-control-center` | P2.1 | loopback API + read-only UI |
| P3.1 | `feature/operator-scheduler` | P2.1 | scheduler + registry |
| P3.2 | `feature/operator-controls` | P0.2, P3.1 | safe mutations + UI controls |
| P4.1 | `feature/artifact-contract` | P2.1 | schema, index, render, hardening |
| P4.2 | `feature/notifications` | P3.1, P4.1 | adapters + delivery policy |
| P5.1 | `feature/guarded-evolution` | P1, P2, P3 | candidate/gates/approval/rollback |

The built-in `pi` harness ([#5](https://github.com/MaTriXy/Monkey.D.Loopy/issues/5)) shipped as
an independent `0.7.1` feature after the release baseline. It is useful but is not a dependency
for the operator architecture.

## 7. Cross-cutting verification

Every phase keeps the existing CI sequence and adds the relevant checks:

```text
typecheck -> unit/integration tests -> deterministic evals -> build -> packed-consumer smoke
```

Additional permanent suites:

- journal corpus: normal, torn tail, corrupted, uncertain, paused, sleeping, cap-cleared, old-version;
- recipe corpus: success, no-op, malformed evidence, cap, prompt-injected evidence;
- operator concurrency: duplicate trigger, crash during claim, crash during effect, restart, stale lock;
- API security: loopback/auth, path traversal, body limits, token scope, version skew;
- UI regression: state derived from fixtures, narrow/desktop layouts, keyboard and screen-reader flow;
- evolution adversarial: cap weakening, grounding downgrade, env expansion, artifact expansion, hidden
  instruction in history.

## 8. Success measures

Product:

- first verified recipe running in less than five minutes;
- a user can explain why a loop stopped from the control center without reading raw JSONL;
- at least 80% of new loops start from a verified recipe or blueprint;
- zero-network local start and zero-account usage remain possible.

Trust:

- 100% of shipped recipes pass validate, verify, score, and fixture evals in CI;
- 100% of operator mutations are auditable;
- no UI state can contradict runtime replay for the journal corpus;
- no published package/README/CLI target drift;
- safety or capability regressions block evolution and releases.

Operational:

- useful UI in under two seconds at the Phase 2 reference scale;
- no duplicate active run per loop under the supported concurrency policy;
- graceful stop succeeds at journal-safe boundaries and forced interruption is explicit;
- notification and artifact failures do not corrupt or misreport the underlying run.

## 9. Explicit non-goals through `0.5.0`

- hosted multi-tenant SaaS;
- arbitrary distributed workflow graphs or fleet fan-out;
- exactly-once effects across external systems;
- automatic repository-wide file sync;
- executable user-authored dashboard HTML/JavaScript;
- silent self-modification;
- replacing Temporal, Inngest, Restate, or Kubernetes;
- requiring the operator to run a compiled artifact.

## 10. First implementation decision

Start with Phase 0, not the dashboard. The control center depends on trustworthy stop and meter
semantics, and the public package must match repository claims before new product surfaces amplify
the discrepancy.

After `0.1.1`, implement the recipe contract before the operator UI. Recipes create an immediate
user-facing win and provide realistic fixtures for designing the operator read model and dashboard.

The first code branch after this planning branch should be:

```text
fix/usage-meter-trust
```

It is the smallest high-severity slice, has a crisp adversarial test, and establishes the release
baseline without coupling unrelated product work.

## 11. End-to-end Definition of Done

The active goal is complete only when all of the following are true:

1. Phases 0–5 meet every exit gate; deferred items are explicitly outside those phases rather than
   silently incomplete.
2. Runtime, recipe, operator, artifact/notification, UI, and evolution adversarial suites are part
   of normal CI, not one-off local checks.
3. macOS and Linux end-to-end flows cover install → schedule → execute → observe → stop/recover →
   notify → evolve → approve → activate → rollback. Windows covers the documented foreground flow.
4. Standalone and vendored artifacts still run with the operator absent, and every existing compile
   target passes its capability-honesty tests.
5. Public CLI, MCP, API, registry, artifact, notification, and evolution contracts are documented
   with migration/version behavior.
6. Package versions, generated help, README, `SPEC.md`, package READMEs, examples, and npm contents
   agree at each published release.
7. The implementation is merged to `main`, required CI is green at the merged head, release tags
   through `0.5.0` are cut, and all public packages—including `@loopyc/operator` once introduced—are
   verified from clean packed consumers.
8. Open roadmap issues are closed with evidence or moved to a named later milestone with a written
   reason that does not violate an exit gate.
9. The final competitive claim is demonstrated, not asserted: at least one shipped recipe is shown
   in the control center with externally grounded termination, enforced budgets, crash recovery,
   an artifact, a delivered notification, and a safely approved evolution revision.

External release credentials or marketplace configuration can block publication even after code is
ready. Such a block is reported with the exact missing external action; it does not permit marking
the goal complete.
