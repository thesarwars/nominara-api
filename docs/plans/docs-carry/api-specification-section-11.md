<!-- Carry to the docs repo: references/api-specification.md §11, the `task.created` row (line 681). Nominara-Dev-Docs-main has no .git, and docs/references/api-specification.md must stay byte-identical to the snapshot, so it is NOT edited here. Owner decision 2026-10-08: realtime task.created / task.moved send ids only. -->

| `task.created` | `{task_id, project_id}` | worker-rollup | ≤ 5 / s / project |

`task.moved` keeps `{task_id, project_id, from_status, to_status, actor_id}`: it never carried a title; the two statuses are the enumerated workflow vocabulary, not tenant text. Clients refetch the task through the scoped REST read for anything else.
