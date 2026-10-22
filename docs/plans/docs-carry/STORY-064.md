# STORY-064 — the four remaining ACs, decisions taken, and doc changes (carry to the docs repo)

Update `stories/tasks/STORY-064-task-api-events-and-refs.md` status from `Partial — 9 of 13 ACs` to **`Done — 13 of 13 ACs`**, replacing the 2026-10-12 table's rows 5, 9, 10 and 12 with the evidence below. One caveat belongs in the story: the dedupe collapses on the **displayed** `code` (see the fourth item under Decisions taken).

| AC | State | Evidence |
|---|---|---|
| 5. Dismissal reappears after the period | Met | `task.resurface` (daily sweep) reopens a dismissed task whose `resurface_at` has passed: status `todo`, reason and date cleared, open count restored, a system `reopened` event. `test/integration/task-resurface.spec.ts` ("[STORY-064 #6] advancing past the re-surface date reopens the task ...") |
| 9. Queue merges readable projects, impact-ranked, one index | Met | `test/integration/action-items.spec.ts` "[STORY-064 #10]": EXPLAIN of the exact statement (`ACTION_ITEMS_SQL`) with `enable_seqscan = off` shows exactly one scan of `tasks`, on `ix_tasks_open`. See the fifth item under Decisions taken for what "one index" means once the rows are grouped |
| 10. Cross-project dedupe with a project count | Met | `ACTION_ITEMS_SQL` (`groups` / `reps`); `action-items.spec.ts` "[STORY-064 #11]" and the six cases around it. `project_count` and `projects` are on the contract |
| 12. Bulk assign, status change, snooze; snooze needs a reason and a date | Met | `POST /v1/workspaces/{id}/tasks/bulk`; `test/integration/task-bulk.spec.ts` ("[STORY-064 #13]" at the contract, and the all-or-nothing cases at the service) |

## api-specification.md §3 — one new route

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/workspaces/{id}/tasks/bulk` | `task:move` (manager scoped) | Body `{ action: "assign", task_ids, assignee_id \| null }`, `{ action: "status", task_ids, status: "todo" \| "in_progress" }` or `{ action: "snooze", task_ids, reason, snooze_until }`. 1 to 100 unique ids. Idempotent (`Idempotency-Key`). `200 { updated, tasks }`. All-or-nothing: `404` if any id is absent, another tenant's or soft-deleted; `403` naming the scope if any is outside a scoped caller's projects; `409` if a `done` task is in a status or snooze batch; `400` for a missing reason or date, or a date that is not in the future. Audited as `task.bulk_updated` against the workspace |

## system-architecture.md §4 — one added queue row (and any prose that counts the queues)

| Queue | Producer | Worker group | Concurrency | Retry | Priority | Idempotency key | Tenant-scoped |
|---|---|---|---|---|---|---|---|
| `task.resurface` | cron daily 02:10 UTC (STORY-064 AC5) | rollup | 1 | 3x exp (2s, 4s, 8s) | 9 | `taskresurf:{yyyy_mm_dd}` | no |

Not tenant-scoped: the tick has no workspace to name. Cross-tenant discovery (task ids only) runs on the owner connection; each reopen is applied in ONE tenant's context as the runtime role. Advisory-locked single-flight. The hour is a chosen quiet window, not a reference transcription; add it to the schedule tables beside `domain.reverify` (`10 2 * * *`).

**Deploy invariant (same as `domain.reverify`):** discovery reads `tasks` across tenants, so `DATABASE_URL` must be a role that bypasses FORCE RLS (the superuser in compose and in the test container). A role that does not would resurface nothing, and `nominara_tasks_resurfaced_total` would read zero every day.

## Decisions taken (each follows the planner's recommendation unless stated)

1. **Snooze is a dismissal with a caller-chosen `resurface_at`** (no `snoozed_until` column, no fifth status, no migration). The `dismissed` event carries `{ snooze: true, reason, resurface_at }`; the open count drops; it returns through the same sweep. Reason and date are both required (the contract), the date must be in the future (no upper bound: the 180-day cap this change first had was NOT FROM THE REFERENCE and was dropped; the owner can add a bound by story).
2. **Resurface mechanism: a workspace-agnostic scheduled sweep, not a rollup step** (instruction for this wave; the planner had recommended a rollup step). A rollup only visits a project on the days it rolls up, so a quiet project would never see its tasks return. A read-time rule was rejected: a read cannot write the audited `reopened` event.
3. **Bulk status offers `todo` and `in_progress` only.** `done` is its own endpoint (completion captures a baseline); a bulk dismissal is a snooze, which carries its own date. A bulk status change of a dismissed task reopens it (`reopened`), exactly as `PATCH` does. Each task is patched by the same code as `PATCH /tasks/{id}`, so a batch writes the same events a single patch would; a task already in the requested state writes nothing and is not counted in `updated`.
4. **Dedupe key = the displayed `code` (`COALESCE(aux_findings.rule_code, tasks.rule_code)`) AND `affected_url`.** The AC says "rule and affected URL"; an AUX-derived task's displayed rule is the AUX rule, so that is what groups. A task with no code or no URL is keyed on its own id and never collapses. The row shown is the highest-impact task of the group (ties by severity, age, id), so paging is keyed on it and skips or repeats nothing; `project_count` counts DISTINCT readable projects and `projects` lists them (the row's own first, then by name). The count is taken after the scope predicate, so it cannot reveal a project outside a scoped role's reach.
5. **One index, once rows are grouped.** The scan of `tasks` is one scan of `ix_tasks_open` (asserted by EXPLAIN with sequential scans disabled, since a 20-row fixture is below the planner's own index threshold). Grouping means every open task of the workspace is read before the first row can be returned: that is the price of a count that is true, and it is bounded by the workspace's open tasks, not by the page size. No index was added.

## Contract change the client must pick up

`GET /workspaces/{id}/action-items` rows gain `project_count` (integer >= 1) and `projects` (array of `{ id, name, slug }`, length = `project_count`). Additive. The Command Center badge (`components/command-center/ActionItems.tsx`, `useActionItems.ts`, `tests/action-items.test.tsx`) is not built in this change; it follows the regenerated `@nominara/client`. The bulk/snooze UI belongs to STORY-094 / STORY-089.

## STORY-089 (carried from STORY-169): its "impact within severity" wording still contradicts FR-GD-02 (impact first); the queue implements FR-GD-02.

## Known gaps and follow-ups (recorded, not built)

- **Resurfaced tasks send no realtime or notification event.** The `task.resurface` sweep writes the system `reopened` event and refreshes the open count, but does not emit the task-moved realtime event a `PATCH` reopen emits; an open dashboard shows the task on its next load. Data, tenancy and audit are unaffected. Follow-up story if live refresh matters.
- **`ACTION_ITEMS_SQL` groups before it pages**, so each page request reads and aggregates every open task of the workspace (cost grows with open-task count, not page size). The ORDER BY inside the MATERIALIZED `open_tasks` CTE only steers the planner onto `ix_tasks_open`. Fine at current sizes; add a cap or a covering index if agency workspaces grow.
- The single-index test uses `enable_seqscan = off` on a small fixture: it proves one `ix_tasks_open` scan can serve the statement, not that the planner picks it at production sizes.
