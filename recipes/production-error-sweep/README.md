# Production Error Sweep

Expose only an aggregated, redacted `summary_url`; keep authentication in environment bindings.
The recipe asks an agent for a reversible code repair only when the service reports `actionable`.
It cannot deploy and cannot close itself: the external summary must later report `complete` or
`no-op`. Use a human approval gate in the surrounding delivery workflow before production changes.
