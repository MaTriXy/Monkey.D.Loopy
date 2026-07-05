# @loopy/runtime

The durable execution engine that compiled [Monkey D Loopy](https://github.com/MaTriXy/Monkey.D.Loopy)
loops run on. Zero dependencies.

Every standalone artifact emitted by `loopc compile` imports this package (or bundles it with
`--vendor`). It provides the event-sourced **journal** with a chained checksum, deterministic
**replay**, write-ahead **idempotent effects** (at-most-once for completed effects across
crashes), **durable sleep** (park the run, resume past the wake time), human **breakpoints**,
mandatory **caps** (iterations, no-progress fingerprint, token/USD/wallclock budget with real
cost metering), and pluggable agent harnesses — any LLM provider, any coding-agent CLI, nothing
hardcoded.

```
node loop.mjs run      # journals to .loopy/, crash-resumable
node loop.mjs resume   # picks up exactly where the journal ends
```

See the [runtime reference](https://github.com/MaTriXy/Monkey.D.Loopy/blob/main/docs/runtime.md).
