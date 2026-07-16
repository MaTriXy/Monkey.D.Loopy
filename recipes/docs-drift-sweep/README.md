# Documentation Drift Sweep

The repository-owned `drift_command` emits structured status and evidence. The agent verifies
that evidence against source files and edits only affected documentation. Re-run the checker
after changes: only its `complete` or `no-op` result ends the loop. Never include secret files
or unredacted credentials in the evidence payload.
