# listProjectGoals cursor envelope (checkpoint-6, owner decision 2026-10-09 pm #3)

- GET /v1/projects/{id}/goals now takes the standard `cursor`/`limit` query and returns `{ data, pagination, meta }`, same shape as listApiKeys. Keyset on (created_at DESC, id DESC) with a microsecond cursor key; a foreign or malformed cursor is a 400 validation failure.
- Contract: `goalListQuerySchema` in contracts/tasks/goal-response.schema.ts (own commit). openapi regenerated; breaking-changes.json entry `2026-10-09-project-goals-cursor-envelope`.
- Tests (test/integration/task-goals.spec.ts): page boundary (limit 2 over 5 goals: pages 2/2/1, no skip, no repeat, last page cursor_next null) and malformed-cursor rejection. Both were RED first (separate commit), then green.
- Existing observability on the goals module is unchanged (read-only list; no new metric needed beyond the route's standard request span/metric).
- Frontend: the goals screen must read `data` plus `pagination` (follow `cursor_next`); carried to the fe lane.
