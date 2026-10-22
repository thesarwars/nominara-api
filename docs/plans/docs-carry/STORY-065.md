# STORY-065 — goal kinds, the rollup refresh, contribution ordering, achievement (carry to the docs repo)

Update `stories/tasks/STORY-065-goals-and-progress.md` status from `Partial — 5 of 11 ACs` to **`Done — 11 of 11 ACs`** (the goal refresh is wired into the rollup handler; ACs 2, 6 and 11 are enforced by a handler-level test). Replace rows 1, 2, 4, 5, 6 and 11 of the 2026-10-12 table with the evidence below.

| AC | State | Evidence |
|---|---|---|
| 1. Goal kinds, each with metric, value, optional engine or cluster scope | Met | six kinds creatable, one metric each; `custom` still refused. `src/modules/tasks/goals.spec.ts` (per-kind table), `test/integration/task-goals.spec.ts` "[STORY-065 #1] a goal of each kind captures its baseline ..." |
| 2. Baseline at creation; current refreshed by the rollup | Met | `refreshProjectGoals` (`src/lib/rollup/refresh-project-goals.ts`) re-measures every active goal; `task-goals.spec.ts` "[STORY-065 #2] the rollup step ...". Called by `rollup-metric-daily.handler.ts` after `denormalizeProject`; "[STORY-065 #11] the ROLLUP HANDLER (not the step alone) moves current and achieves a goal" |
| 4. Tasks group and order by contribution | Met | `sort=goal`: older goal first, then the contribution tier, then impact. `test/integration/project-tasks.spec.ts` "STORY-065 · contribution ordering" |
| 5. Contribution relative to the goal's metric | Met | "[STORY-065 #5] a high-impact task irrelevant to the goal ranks BELOW a lower-impact task that feeds the goal's metric" |
| 6. Reaching the target sets achieved + timestamp; goal retained | Met | "[STORY-065 #6] reaching the target ...": inclusive, sufficient sample only, one system-actor `goal.achieved` audit row, idempotent |
| 11. Progress refresh in the rollup, not on read | Met | reads never recompute ("[STORY-065 #12]"); the refresh is the step above |

## Wiring (done)

`src/lib/queue/handlers/rollup-metric-daily.handler.ts` calls `await refreshProjectGoals(tx, payload.projectId)` right after `denormalizeProject` (the goals read what it wrote). It runs inside the rollup's tenant transaction and project lock, reads only this database, and is idempotent (a second pass over unchanged data rewrites `current` with the same figures; an achieved goal is never touched again). The wiring is a SHARED-file edit (the plan's collision note): merge order against the 042/063 edits to the same handler is a one-line conflict at most.

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
4. **Direction is a property of the metric, not of where the goal started** (`GOAL_METRIC_DIRECTION`, `src/lib/rollup/refresh-project-goals.ts`). All five goal metrics are higher-is-better, so every goal is `up` and the table has no `down` entry until a lower-is-better metric exists; `goals.target.direction` is stored as `up` and the refresh reads the metric, not the stored value. **At creation, a `target_value` at or below a baseline measured on a sufficient sample (n >= 30) is a `400`** (it is already met or behind; it must never become a goal that getting worse "achieves"). An unmeasured or under-sampled baseline cannot say so, so the goal is created and is achieved only once a sufficient sample is at or above the target. Reaching is inclusive. No migration. A regression is never recorded as achieved (tested).
5. **Achievement needs a sufficient sample** (n >= 30): a value past the target on fewer cells, or an unmeasured one, is not an achievement. While insufficient, `current` still moves (the customer sees the n) and `progress_pct` is left as it was and read as null. A goal whose baseline was unmeasured shows no progress percentage until it is achieved (there is nothing to measure from; the baseline is never back-filled).
6. **The automatic achievement is audited as the system actor** (`goal.achieved`, `actor_type system`, resource the goal, no title in the state).

## Cursor note

`sort=goal` changed its keyset keys (goal epoch, tier, impact, created_at). A cursor issued before the deploy is read with the new meaning and can mis-page once; cursors are short-lived and no data is lost. Nothing else in the cursor shape moved.

## schemas/tasks-and-goals.md

`goals.target` jsonb is now `{metric, target_value, direction, engine_key?, prompt_cluster_id?}`; `metric` is one of `visibility_score | citation_share | rendering_quality | sentiment_score | presence_rate`, `direction` is `up | down`. No column changed.

## Open owner confirmations (recorded, not decided here)

- **The trigger-to-metric table** (`GOAL_METRIC_TRIGGERS`, `src/lib/goals/contribution.ts`) is a product judgement, NOT FROM THE REFERENCE. Contribution ordering (AC5) rests entirely on it. The owner should confirm or amend it; record the decision here or in the decisions file.
- **`topic_authority` goals cannot be achieved until D2 provides a cluster-level n.** A cluster has no cell count of its own (the project's n is not the cluster's), so `cells` is null, the goal stays `insufficient`, and the achievement rule (n >= 30) can never be met.
- **`sort=goal` tie-break:** the keyset's first key is the goal's `created_at` epoch, so two goals with an identical `created_at` (only reachable by inserting two goals in one transaction: a seed script or a future batch import) would have their tasks interleaved and share a contribution tier. `createGoal` inserts one goal per request, so it is unreachable today. Fixing it widens the cursor keyset (a goal id key); do it when a bulk goal import is built.
