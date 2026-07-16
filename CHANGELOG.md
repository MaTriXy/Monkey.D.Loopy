# Changelog

## 0.1.1 — 2026-07-16

- Prevent model-authored usage fields from altering trusted token and cost meters.
- Add journal-safe graceful stop and audited `retry`, `assume-done`, or `abort` recovery for
  effects interrupted between their pending and completed records.
- Make built-in agent timeout and output-buffer limits configurable and diagnosable.
- Publish the Claude-native compile target with synchronized package, CLI, generated-artifact,
  documentation, and packed-consumer release gates.
