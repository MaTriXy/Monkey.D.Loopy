# `loopc` — CLI reference

`loopc` is the deterministic factory CLI. Until a global binary build ships, invoke it via:

```bash
pnpm exec tsx packages/cli/src/index.ts <command> [args]
# (shown below as `loopc <command>`)
```

Release `0.1.1` reports its synchronized factory version with `loopc --version`.

All commands exit non-zero on failure (parse error, validation failure, or a failed verify).

---

### `loopc blueprints`
List the built-in starting-point templates (one per pattern).

```bash
loopc blueprints
```

### `loopc new <id> [--blueprint <name>] [--pattern <pattern>] [--from-shell "<cmd>" --until "<expr>"] [--out <file>]`
Scaffold a LoopSpec. With `--blueprint`, copies that blueprint with `id` substituted; with
`--from-shell` (+ required `--until`), scaffolds a loop that runs a command each iteration,
saves its output to `state.out`, and exits on the condition; otherwise writes a minimal
template for `--pattern` (default `react`). Writes to `<id>.loop.yaml` unless `--out` is given.

```bash
loopc new deploy-watch --blueprint poll-until --out deploy-watch.yaml
loopc new poller --from-shell "curl -s $URL/health" --until '${state.out.ready == true}'
```

### `loopc validate <spec.yaml>`
Run the two-tier validator. Prints errors (compile-blocking) and warnings. Exit 1 if invalid.

```bash
loopc validate deploy-watch.yaml
```

### `loopc verify <spec.yaml> [--fix]`
Dry-run the loop through the real runtime with **mocked effects** (no side effects). Proves it
is **bounded under caps** and **deterministic on replay**, and reports whether it terminates
naturally under empty mocks. `--fix` writes explicit caps into the file if it relied on
auto-injected ones. Exit 1 if not bounded/deterministic/resume-stable.

```bash
loopc verify deploy-watch.yaml --fix
```

### `loopc score <spec.yaml>`
Run verify, then grade five weighted dimensions (termination safety, caps, observability,
resumability, determinism) into a 0–100 letter grade.

```bash
loopc score deploy-watch.yaml
```

### `loopc compile <spec.yaml> [--target standalone,babysitter,claude-code,claude-native,n8n|all] [--out <dir>] [--vendor]`
Validate, then lower the spec to runnable artifact(s). Refuses to compile an invalid spec.
Target defaults to the spec's `target.runtime` (or `standalone`); `--target all` emits every
target. Output goes to `<out>/<target>/` (default `out/<id>/<target>/`). Prints any capability
warnings (e.g. soft budget enforcement / `http→curl` on the babysitter target).

`--vendor` (standalone target only) makes the artifact **zero-install**: it bundles
`@loopyc/runtime` into a single local `runtime.bundle.mjs` (via esbuild), rewrites `loop.mjs` to
import from that bundle, and drops the `@loopyc/runtime` dependency from the emitted
`package.json`. The result runs with **plain `node loop.mjs run` — no `npm install`, empty
`node_modules`** — so a compiled loop is portable to any machine with Node, even one that has
never seen this monorepo. Using `--vendor` with any non-standalone target (or `--target all`) is
an error.

Targets:
- **standalone** — a complete Node project on `@loopyc/runtime` (hard caps, journal, resume).
- **babysitter** — a durable `@a5c-ai/babysitter-sdk` process (proven on a live run).
- **claude-code** — a markdown **prose execution guide** (`<id>.loop.md`) + Mermaid flow for an
  agent to follow. No runtime; caps are agent-honored (capability warnings make this explicit).
- **claude-native** — a Claude Code project skill at `.claude/skills/<loop>/SKILL.md`, invokable
  as `/<loop>`. It prefers a sibling standalone artifact for hard guarantees, and otherwise runs
  from the embedded LoopSpec contract with Claude-honored caps.
- **n8n** — a best-effort **importable workflow** (`<id>.n8n.json`) scaffold; you wire the exit
  condition/state (n8n's model differs — heavily caveated in the generated README).

```bash
loopc compile deploy-watch.yaml --target all --out ./out/deploy-watch
```

**Standalone output** is a complete Node project (`loop.mjs`, `package.json`, `README.md`,
`loop.lock`, `.gitignore`, plus `SKILL.md` when `target.emit` includes `skill`) that depends
only on `@loopyc/runtime`. Run it:

```bash
cd out/deploy-watch/standalone && npm install
node loop.mjs run      # run until termination or a cap
node loop.mjs step     # advance exactly one iteration (for cron / Stop-hook / CI drivers)
node loop.mjs resume   # resume from the journal after a crash/pause
node loop.mjs stop --reason "maintenance"  # request a journal-safe graceful stop
node loop.mjs recover --retry --reason "verified safe" # resolve uncertainty explicitly
node loop.mjs doctor   # preflight checks
```

With `--vendor` the standalone output additionally includes `runtime.bundle.mjs` (the whole
runtime, bundled) and the `npm install` step is unnecessary — `node loop.mjs run` works straight
out of the directory with an empty `node_modules`.

**Babysitter output** is an installable project (`process.mjs` + `package.json` depending on
`@a5c-ai/babysitter-sdk`) — a durable process for [babysitter](https://github.com/a5c-ai/babysitter).
`npm install`, then drive it with the SDK CLI (`run:create --non-interactive` → `run:iterate` +
`task:post`, or `harness:yolo` for a real agent run) — see the generated `README.md`. This target
has been verified end-to-end against the real SDK.

**Claude-native output** is a Claude Code project skill:

```text
.claude/skills/<loop>/SKILL.md
.claude/skills/<loop>/reference/loopspec.json
.claude/skills/<loop>/loop.lock
.claude/skills/<loop>/scripts/run-standalone.mjs
README.md
loop.lock
loop.source.yaml
```

Copy the generated `.claude/` directory into the repository where the loop should be available,
then start Claude Code from that project and invoke the loop by skill directory name:

```text
/<loop> run '{"input_name":"value"}'
/<loop> step
/<loop> resume
/<loop> inspect
/<loop> doctor
/<loop> approve
```

The generated skill first tries to hand off to a sibling standalone artifact via
`scripts/run-standalone.mjs`. That path preserves the runtime-enforced guarantees: journal,
deterministic replay, caps, durable sleep, breakpoints, and budget metering. If no standalone
artifact is present, the skill falls back to the embedded LoopSpec contract in
`reference/loopspec.json`; Claude can still run the loop natively, but caps and state updates are
agent-honored soft guarantees. `loopc compile` prints those capability warnings so the boundary is
visible before users ship the artifact.

### `loopc run <spec.yaml> [--out <dir>] [--inputs <file.json>] [--approve] [--yes] [--run-id <id>]`
Run a loop directly (validates first — refuses an invalid/unbounded spec). Executes real
effects through the runtime, journaling to `<out>/.loopy/runs/<run-id>` (default `.loopy`), and
prints the `RunResult`. Inherits `process.env` (a local dev command, mirroring the compiled
`node loop.mjs run` — unlike the env-scrubbed MCP `run_loop`). `--inputs` loads a JSON file;
`--yes`/`--auto-approve` auto-approves human breakpoints; `--approve` approves a pending
cap-breakpoint and continues. Exits non-zero only on a failed run.

```bash
loopc run my-loop.yaml --out ./run --inputs inputs.json
```

### `loopc inspect <dir> [--tail <n>] [--run-id <id>]`
Inspect a run directory: status/iteration, the latest snapshot state, and the last `n` journal
events (default 10). Errors if no journal exists under the dir.

```bash
loopc inspect ./run --tail 20
```

### `loopc schedule install <artifact-dir>`
For a compiled artifact whose `schedule.mode` is recurring (`cron`/`forever`/`watch`), the
standalone target emits a `schedule/` dir (crontab line, systemd `.service`+`.timer`, launchd
plist, GitHub Actions workflow). This command reads it and prints the **platform-appropriate**
install snippet (no daemon, no side effects — it just shows you what to install).

```bash
loopc schedule install ./out/deploy-watch/standalone
```

### `loopc reprint <artifact-dir> [--target <t>] [--out <dir>]`
Recompile an existing artifact under the **current** factory. Reads the embedded
`loop.source.yaml` (written by `compile`), re-validates, and re-emits — to the same target
(from `loop.lock`) and in place by default, or to `--target` / `--out`. Use it to refresh
generated artifacts after upgrading Monkey D Loopy.

```bash
loopc reprint ./out/deploy-watch/standalone
```

### `loopc targets`
Print the per-target capability matrix (✓ enforced · ~ soft · ✗ unsupported), so you can see
at a glance which guarantees each compile target provides.

### `loopc infer-scaffold <script-or-journal> [--out <draft.yaml>]`
Deterministically extract a **FactPack** from an existing script (JS/TS via the TypeScript AST,
or bash) or a `.loopy` journal, and emit a **draft** LoopSpec — candidate pattern + steps + a
loop-condition hint, with secrets flagged. The draft has TODOs and is **not guaranteed valid**:
complete it (map the exit to a real state signal, fill placeholders), then `validate`/`verify`.
`verify` proves *bounded*, not *faithful* — review the draft against the source.

```bash
loopc infer-scaffold ./watch.sh --out watch.loop.yaml
```

## Typical flow

```bash
loopc new my-loop --blueprint loop-until-dry --out my-loop.yaml
# edit my-loop.yaml
loopc validate my-loop.yaml
loopc verify   my-loop.yaml --fix
loopc score    my-loop.yaml
loopc compile  my-loop.yaml --target all --out ./out/my-loop
```
