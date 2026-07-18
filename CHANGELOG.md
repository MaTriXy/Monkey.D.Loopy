# Changelog

## 0.6.0 — 2026-07-18

- Added `loopc quickstart`, a non-destructive one-command journey that scaffolds, validates,
  scores, executes, inspects, and vendors a safe first loop without a model or external API.
- Added a packed-tarball clean-room onboarding gate so the documented first-run promise is tested
  against the packages users actually install.
- Replaced the failing input-less deploy-poller walkthrough with a deterministic first-loop guide,
  a zero-context agent handoff, and copy-paste npm MCP setup for Codex and Claude Code.
- Made the documentation navigation and agent release index read the synchronized package version
  instead of carrying a stale hard-coded release.

## 0.5.1 — 2026-07-18

- Patched the CLI's runtime `esbuild` dependency to `0.28.1`, closing the Windows development-server file-read advisory for npm consumers.
- Constrained build-tool resolutions to patched, compatible esbuild and Vite releases.
- Upgraded Vitest to the patched 3.2 line and added a zero-vulnerability audit gate to CI.

## 0.5.0 — 2026-07-17

- Ship six verified, externally grounded recipes with adversarial fixtures and CLI/MCP discovery.
- Add the optional `@loopyc/operator` with a checksum-verified journal read model, secured loopback
  control center, explicit scheduler handoff, durable claims, and journal-safe run controls.
- Add allowlisted artifact contracts and generic-webhook notifications with path/secret/MIME
  defenses, ceilings, idempotency, retries, deduplication, and failure-streak suppression.
- Add guarded evolution: isolated candidates, semantic diffs, deterministic validation/verification/
  score/capability regression gates, exact waivers, representative fixture replay, human approval,
  active revision visibility, and byte-for-byte rollback without journal mutation.
- Preserve standalone and vendored artifact independence plus honest behavior across standalone,
  babysitter, Claude Code, Claude-native, and n8n targets.
- Gate the release with 177 deterministic eval cases, repository-wide tests/builds, seven-package
  parity, clean packed consumers, and an end-to-end recipe/operator/notification/evolution proof.

## 0.1.1 — 2026-07-16

- Prevent model-authored usage fields from altering trusted token and cost meters.
- Add journal-safe graceful stop and audited `retry`, `assume-done`, or `abort` recovery for
  effects interrupted between their pending and completed records.
- Make built-in agent timeout and output-buffer limits configurable and diagnosable.
- Publish the Claude-native compile target with synchronized package, CLI, generated-artifact,
  documentation, and packed-consumer release gates.
