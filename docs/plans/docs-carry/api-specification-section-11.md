<!-- Carry to the docs repo: references/api-specification.md §11, the `task.created` row (line 681). Nominara-Dev-Docs-main has no .git, and docs/references/api-specification.md must stay byte-identical to the snapshot, so it is NOT edited here. Owner decision 2026-10-08: realtime task.created / task.moved send ids only. -->

| `task.created` | `{task_id, project_id}` | worker-rollup | ≤ 5 / s / project |

| `task.moved` | `{task_id, project_id}` | api | (no budget) |

Both events carry ids only (no title, statuses or actor): the gateway has workspace-room delivery only, so a project-scoped member would otherwise learn of a move and who made it. Clients refetch through the scoped REST read. Also carry to STORY-064-D AC4: "task.created and task.moved payloads are ids only".
