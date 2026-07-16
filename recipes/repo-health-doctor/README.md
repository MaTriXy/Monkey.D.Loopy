# Repository Health Doctor

Use this recipe when a repository-owned command can emit `{"status":"...","evidence":...}`.
Valid statuses are `pending`, `actionable`, `complete`, and `no-op`. The external command—not
the agent—owns the completion signal. The agent runs only for `actionable`, makes a minimal
repair, and records its work at `report_path`.

Example: `loopc run repo-health-doctor.loop.yaml --input check_command=./scripts/doctor-json.sh`.
Keep the checker deterministic, redact credentials, and require human approval for destructive work.
