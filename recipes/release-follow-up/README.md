# Release Follow-up

Use an authoritative status endpoint that returns `pending`, `actionable`, `complete`, or `no-op`.
When action is required, the agent may prepare a reversible remediation and report, but cannot
publish, promote, merge, or roll back. Completion always comes from release gates, making the
recipe suitable for long-running, resumable follow-up rather than optimistic fire-and-forget.
