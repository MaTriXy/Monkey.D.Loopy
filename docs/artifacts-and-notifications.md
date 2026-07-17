# Artifacts and notifications

Loop products are opt-in. A loop without an `artifacts` block exposes no files, and a loop with no
notification channels performs no external calls.

```yaml
artifacts:
  include: ["reports/**/*.md", "metrics/*.json"]
  exclude: ["reports/private/**", "**/.env*", "**/node_modules/**"]
  max_files: 1000
  max_bytes: 50000000

notify:
  policy: on-change # never | on-change | on-failure | always
  channels: [ops]
```

All patterns are artifact-root-relative POSIX globs. Validation rejects absolute/traversing paths,
secret/dependency allowlists, active HTML/XML/SVG content, duplicates, and URL-shaped channel
names. Defaults are 1,000 files and 50 MB when an artifact contract exists.

The operator walks without following symlinks, applies a hard denylist for runtime journals,
inputs, source/lock files, secrets, `.git`, and dependencies, then applies allowlist, denylist,
count, and byte ceilings. It accepts Markdown, JSON, UTF-8 text/CSV/logs, diffs/patches, and
signature-checked PNG/JPEG/GIF/WebP images. JSON must parse and text must not contain binary bytes.
Downloads are re-opened with no-follow semantics and must still match the indexed size and SHA-256.
Index failures are displayed and audited but never change the run result.

## Generic webhook channels

LoopSpec contains logical names only. Configure a channel in the operator environment:

```bash
export LOOPY_NOTIFY_OPS_URL="https://hooks.example/loopy"
export LOOPY_NOTIFY_OPS_TOKEN="..." # optional Bearer token
```

Channel names map to uppercase environment suffixes; punctuation becomes `_`. The URL must be
credential-free HTTP(S). Webhooks receive a bounded JSON summary with loop/run identity, status,
iteration, spec hash, artifact metadata, SHA-256, and authenticated local links—never artifact
contents, full state, transcripts, credentials, or the local operator token.

Delivery retries transient failures up to three attempts with exponential backoff and one stable
`Idempotency-Key`. A successful key is locally deduplicated. `on-change` also deduplicates an
unchanged status/state/artifact signature. Five consecutive failures suppress that loop/channel for
15 minutes. Every success, failure, missing configuration, streak, and suppression is attributable
in the owner-only operator audit log. Delivery failure cannot fail the underlying loop.
