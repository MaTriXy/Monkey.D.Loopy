---
layout: home
title: Monkey D Loopy — Agent loops that know when to stop
titleTemplate: false

hero:
  name: Monkey D Loopy
  text: Agent loops that know when to stop
  tagline: Define a loop once. Prove it is bounded, deterministic, and resume-stable. Then compile it into a durable artifact that survives crashes without losing control of time, tokens, or cost.
  image:
    src: /images/monkey-d-loopy-logo-512.png
    alt: Monkey D Loopy
  actions:
    - theme: brand
      text: Build your first loop
      link: /#quickstart
    - theme: alt
      text: Give this to your agent
      link: /agent-guide
    - theme: alt
      text: Browse recipes
      link: /recipes

features:
  - icon: 🧱
    title: Bounded by construction
    details: Termination and caps are mandatory. Invalid or unreachable exit conditions are rejected before anything runs.
    link: /loopspec#terminate
    linkText: See the contract
  - icon: 🔁
    title: Crash-resumable
    details: Chained journals, deterministic replay, idempotent effects, durable sleep, and human breakpoints preserve control across restarts.
    link: /runtime#execution-resume-semantics
    linkText: Understand the runtime
  - icon: 🧪
    title: Proved before execution
    details: Mocked-effect verification tests boundedness, determinism, and resume stability without shell, network, or model side effects.
    link: /cli#loopc-verify-spec-yaml-fix
    linkText: Verify a spec
  - icon: 🧭
    title: Agent-native
    details: Use the CLI, the MCP server, or agent-readable documentation. Loopy checks grounding instead of trusting a model's claim that the work is done.
    link: /agent-guide
    linkText: Integrate an agent
  - icon: 📦
    title: Portable artifacts
    details: Compile one LoopSpec into standalone, babysitter, Claude Code, Claude-native, and n8n targets—with an optional zero-install runtime bundle.
    link: /cli#loopc-compile-spec-yaml-target-standalone-babysitter-claude-code-claude-native-n8n-all-out-dir-vendor
    linkText: Choose a target
  - icon: 🛡️
    title: Local-first operations
    details: Run a secured local control center, schedule through one authority, index bounded artifacts, notify safely, and evolve through deterministic gates.
    link: /operator
    linkText: Operate loops
---

## The load-bearing rule

Monkey D Loopy will not emit an unbounded loop. Every LoopSpec declares a termination signal and
mandatory iteration, no-progress, token, dollar, and wall-clock controls. The validator also traces
what feeds the exit predicate, so an agent cannot improve its safety score by merely relabeling its
own opinion as external evidence.

<div class="loopy-principles">
  <div class="loopy-principle"><strong>Bounded</strong>The loop has a reachable exit and hard limits even when the exit never arrives.</div>
  <div class="loopy-principle"><strong>Durable</strong>Every completed step can be reconstructed after a crash without repeating a completed effect.</div>
  <div class="loopy-principle"><strong>Grounded</strong>Real evidence—not just the agent grading itself—determines whether the outcome is complete.</div>
</div>

## Quickstart

Install the CLI with Node 22 or newer, scaffold a bounded pattern, and prove it before compilation:

```bash
npm i -g @loopyc/cli

loopc new deploy-watch --blueprint poll-until
loopc validate deploy-watch.loop.yaml
loopc verify deploy-watch.loop.yaml
loopc score deploy-watch.loop.yaml
loopc compile deploy-watch.loop.yaml --target standalone --out ./out/deploy-watch
```

Then run the emitted project. Its journal is the source of truth for inspection and resume:

```bash
cd out/deploy-watch/standalone
npm install
node loop.mjs run
node loop.mjs inspect
```

Prefer a complete product workflow? Start from one of the [verified recipes](./recipes.md), which
adds provenance, evidence requirements, safety boundaries, and adversarial fixtures on top of the
same LoopSpec and runtime guarantees.

## A useful mental model

```text
goal or existing script
        ↓
   LoopSpec data  ─── validate ─── verify ─── score
        ↓
 compiled artifact
        ↓
 durable runtime ─── journal ─── inspect / resume / operate
```

Loopy is deliberately not a hosted workflow engine. It is a factory and runtime contract for one
bounded agent loop. You keep the provider, coding agent, deployment environment, and artifacts;
Loopy supplies the safety rails and durable execution semantics.

## Documentation for humans and agents

This site is generated from the repository's canonical Markdown. Agents can consume the compact
[`llms.txt`](./llms.txt) index or the consolidated [`llms-full.txt`](./llms-full.txt) context file.
For the recommended authoring sequence and MCP integration, start with
[Using Loopy with agents](./agent-guide.md).
