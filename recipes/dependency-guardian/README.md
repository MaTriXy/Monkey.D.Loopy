# Dependency Guardian

Point `evaluation_url` at a trusted service returning structured `status` and `evidence`.
The recipe does nothing for `no-op`, prepares a reviewable change for `actionable`, and exits
only after the service reports `complete` or `no-op`. It never merges, publishes, alters policy,
or treats agent output as proof that the dependency is safe.
