# @loopyc/cli

`loopc` — the [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy) command-line factory
for runnable, crash-resumable agent loops.

```bash
npm i -g @loopyc/cli

loopc blueprints                    # starting points, one per loop pattern
loopc new my-watch --blueprint poll-until
loopc validate my-watch.yaml        # refuses unbounded / unreachable loops
loopc verify   my-watch.yaml        # dry-run proof: bounded · deterministic · resume-stable
loopc score    my-watch.yaml        # 0-100 scorecard (termination grounding included)
loopc compile  my-watch.yaml --target all --out ./out
loopc run      my-watch.yaml -i status_url=https://...
```

The load-bearing rule: **the compiler will not emit an unbounded loop.** Termination is
required, caps are mandatory, and the dry-run proves both before anything real executes.
Compile targets: a standalone Node project (add `--vendor` for a zero-install bundle), a
supervised process, a coding-agent execution guide, a Claude Code-native slash skill, or a
workflow JSON.

Full command reference: [docs/cli.md](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/docs/cli.md).
