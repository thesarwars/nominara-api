# STORY-065 — goal kinds, the rollup refresh, contribution ordering, achievement (carry to the docs repo)

Update `stories/tasks/STORY-065-goals-and-progress.md` status from `Partial — 5 of 11 ACs` to **`Partial — 9 of 11 ACs (2 and 11 built but not wired into the rollup)`** until the one-line wiring below lands, then `Done`. Replace rows 1, 2, 4, 5, 6 and 11 of the 2026-10-12 table with the evidence below.

| AC | State | Evidence |
|---|---|---|
| 1. Goal kinds, each with metric, value, optional engine or cluster scope | Met | six kinds creatable, one metric each; `custom` still refused. `src/modules/tasks/goals.spec.ts` (per-kind table), `test/integration/task-goals.spec.ts` "[STORY-065 #1] a goal of each kind captures its baseline ..." |
| 2. Baseline at creation; current refreshed by the rollup | **Built, NOT WIRED** | `refreshProjectGoals` (`src/lib/rollup/refresh-project-goals.ts`) re-measures every active goal; `task-goals.spec.ts` "[STORY-065 #2] the rollup step ...". The call is not yet in the rollup handler (see "Wiring" below) |
| 4. Tasks group and order by contribution | Met | `sort=goal`: older goal first, then the contribution tier, then impact. `test/integration/project-tasks.spec.ts` "STORY-065 · contribution ordering" |
| 5. Contribution relative to the goal's metric | Met | "[STORY-065 #5] a high-impact task irrelevant to the goal ranks BELOW a lower-impact task that feeds the goal's metric" |
| 6. Reaching the target sets achieved + timestamp; goal retained | **Built, NOT WIRED** | "[STORY-065 #6] reaching the target ...": inclusive, sufficient sample only, one system-actor `goal.achieved` audit row, idempotent |
| 11. Progress refresh in the rollup, not on read | **Built, NOT WIRED** | reads never recompute ("[STORY-065 #12]"); the refresh is the step above |

## Wiring (the one thing left, and it is in a file this change may not touch)

`src/lib/queue/handlers/rollup-metric-daily.handler.ts` belongs to another stream in this wave. After the `denormalizeProject` call (the goals read what it wrote), add:

```ts
await refreshProjectGoals(tx, payload.projectId);   // import from ../../rollup/refresh-project-goals.js
```

It runs inside the rollup's tenant transaction and project lock, reads only this database, and is idempotent (a second pass over unchanged data rewrites `current` with the same figures, and an achieved goal is never touched again). Until that line lands, `goals.current` does not move and no goal is achieved.

## Decisions taken (each follows the planner's recommendation)

1. **One metric per kind**, stated on a 0-100 scale (shares and rates are stored as fractions and read as percentages, 3 places):

| Kind | Metric | Source | `engine_key` | `prompt_cluster_id` |
|---|---|---|---|---|
| `engine_score` | `visibility_score` | `projects.visibility_blended` (+ `cells_30d`), or one engine's `metric_daily` row | allowed | refused |
| `topic_authority` | `visibility_score` | `topic_clusters.visibility_score`; n unknown, so always `insufficient` until a cluster-level n exists | refused | required |
| `citation_presence` | `citation_share` | `metric_daily` (`all`, or one engine) x 100 | allowed | refused |
| `rendering_quality` | `rendering_quality` | `projects.rendering_quality`, n = the attribute-capable engines' 30-day cells; or one engine's row | allowed | refused |
| `sentiment_recovery` | `sentiment_score` | `projects.sentiment_score` (+ `cells_30d`), or one engine's row; null with no mentions, which reads as insufficient | allowed | refused |
| `prompt_recommendation` | `presence_rate` | `prompt_stability` over the cluster's live prompts: latest window per prompt and engine, weighted by `sample_count`, x 100 | allowed | required |

   The metric in the request must be the kind's metric (a mismatch is a 400). Per-engine goals read that engine's `metric_daily` rows; an engine with none is unmeasured (null), never the project's figure. `prompt_recommendation` has no source until `prompt_stability` is produced (nothing writes it yet), so such a goal reads `insufficient`; `topic_authority` has none until topic clusters exist (D2).
2. **`custom` stays a 400** until a metric source exists. A typed-in "current" would break "the baseline is never typed in".
3. **Contribution is a tiered sort**, not a weight: inside a goal, tasks whose rule feeds the goal's metric (by `task_generation_rules.trigger_kind`, table in `src/lib/goals/contribution.ts`) and whose engine / cluster scope the goal covers come first, by impact; the rest follow, by impact. A dimension a task does not name (no engines, no cluster) is project-wide and counts. A task with no rule is never relevant. **The trigger-to-metric table is a product judgement (NOT FROM THE REFERENCE) for the owner to confirm**; it is the only place the mapping lives.
4. **Achievement direction is derived at creation and stored in `goals.target.direction`** (`up` when the target is at or above the baseline, `down` when below; an unmeasured baseline is `up`, since every goal metric today is higher-is-better). No migration. Reaching is inclusive. A goal created before this reads as `up`.
5. **Achievement needs a sufficient sample** (n >= 30): a value past the target on fewer cells, or an unmeasured one, is not an achievement. While insufficient, `current` still moves (the customer sees the n) and `progress_pct` is left as it was and read as null. A goal whose baseline was unmeasured shows no progress percentage until it is achieved (there is nothing to measure from; the baseline is never back-filled).
6. **The automatic achievement is audited as the system actor** (`goal.achieved`, `actor_type system`, resource the goal, no title in the state).

## Cursor note

`sort=goal` changed its keyset keys (goal epoch, tier, impact, created_at). A cursor issued before the deploy is read with the new meaning and can mis-page once; cursors are short-lived and no data is lost. Nothing else in the cursor shape moved.

## schemas/tasks-and-goals.md

`goals.target` jsonb is now `{metric, target_value, direction, engine_key?, prompt_cluster_id?}`; `metric` is one of `visibility_score | citation_share | rendering_quality | sentiment_score | presence_rate`, `direction` is `up | down`. No column changed.
