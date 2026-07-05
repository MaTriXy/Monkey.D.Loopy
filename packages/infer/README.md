# @loopyc/infer

Start from what you have: deterministic **FactPack extraction** for
[Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy).

Point it at an existing bash or JS/TS script (AST-based, no model calls) or a `.loopy` run
journal, and it extracts the loop-shaped facts — commands, conditions, sleeps, retries, state —
into a draft LoopSpec scaffold to refine with `loopc` or the `/loopy` authoring skill.

```bash
loopc infer-scaffold ./my-poll-script.sh     # via @loopyc/cli
```

See the [project README](https://github.com/MaTriXy/Monkey.D.Loopy#readme) for the full factory.
