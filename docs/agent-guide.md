# Using Monkey D Loopy with agents

Monkey D Loopy is designed to be authored *with* agents without asking those agents to enforce the
important guarantees in prose. An agent can propose the goal, inputs, state, steps, and evidence;
the validator and runtime remain responsible for boundedness, durability, and budget enforcement.

## Give an agent the right context

Use the smallest context that fits the task:

- [`llms.txt`](./llms.txt) is a compact map of every guide and its purpose.
- [`llms-full.txt`](./llms-full.txt) concatenates the canonical documentation for a context window
  or retrieval index.
- [LoopSpec](./loopspec.md) is the exact authoring contract.
- [MCP](./mcp.md) is the tool surface for agents that can call MCP servers.
- [Recipes](./recipes.md) are the strongest starting point for supported product workflows.

The raw endpoints are stable under the project site:

```text
https://matrixy.github.io/Monkey.D.Loopy/llms.txt
https://matrixy.github.io/Monkey.D.Loopy/llms-full.txt
```

## Recommended agent workflow

Ask the agent to follow this sequence. Each boundary corresponds to a real command or tool result,
not a promise in the prompt.

1. Choose a verified recipe when one matches the outcome; otherwise choose the closest structural
   blueprint.
2. Make external completion evidence explicit. Prefer shell exit codes, HTTP status, tests, or
   repository-owned structured output over the agent's self-assessment.
3. Draft the LoopSpec with realistic iteration, no-progress, token, dollar, and wall-clock caps.
4. Run `validate`; repair all hard errors before continuing.
5. Run `verify`; do not compile until boundedness, determinism, and resume stability pass.
6. Run `score`; explain every deduction and any agent-grounded termination cap.
7. Compile the narrowest target needed by the user. Use `--vendor` only when a zero-install
   standalone artifact is useful.
8. Keep generated journals and operator state out of source control unless the user intentionally
   wants a fixture.

## Prompt contract

This compact instruction works well after providing the relevant documentation:

```text
Turn this outcome into a Monkey D Loopy LoopSpec. Start from a verified recipe when one matches.
Use external evidence for completion, make every cap explicit, and preserve provider/tool choice.
Validate, verify, and score the spec before compiling it. Do not weaken a hard gate to make the
score pass. Report the selected termination evidence, cap behavior, compile target, and remaining
capability warnings.
```

## Use the MCP server

Install and register `@loopyc/mcp` as `loopc-mcp` in an MCP-capable agent host. The server exposes
the same factory operations as structured tools, including authoring context, validation,
verification, scoring, compilation, recipes, and inference.

The productive pattern is:

```text
discover recipes or blueprints
  → request authoring context
  → draft LoopSpec
  → validate
  → verify
  → score
  → compile
```

See the [MCP server reference](./mcp.md) for registration examples and exact tool names.

## Boundaries the agent must not blur

- A prompt is not a hard guarantee. Only validator and runtime controls count as enforcement.
- `llm-judge` and `self-assess` termination are weaker than external evidence and are scored as
  such.
- Verification uses mocked effects. It proves control-flow properties; it does not prove that a
  production API, shell command, or model will return good content.
- A Claude-native artifact can fall back to instructions when no standalone sibling exists. In
  that mode, durability and caps are agent-honored rather than runtime-enforced; capability
  warnings must remain visible.
- The local operator coordinates canonical runtimes. It does not become a second execution engine
  or rewrite journal history.

## Existing loops and scripts

For an existing shell, JavaScript, TypeScript, or `.loopy` journal, use inference to extract a
FactPack and draft spec. Treat inference as scaffolding: the agent still needs to name the real
completion evidence, state mutations, effect boundaries, and appropriate caps before validation.

Continue with the [`loopc` CLI reference](./cli.md) or the exact
[LoopSpec v0.1 reference](./loopspec.md).
