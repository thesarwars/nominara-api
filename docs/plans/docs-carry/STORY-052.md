# STORY-052 — the three remaining ACs, decisions taken, and doc changes (carry to the docs repo)

Update `stories/aux/STORY-052-aux-score-and-finding-lifecycle.md` status from `Partial — 7 of 12 ACs` to **`Partial — 10 of 12 ACs (1 and 9 open: both wait for STORY-051)`**, replacing rows 8, 10 and 11 of the 2026-10-12 table with the evidence below. Do not mark AC1 or AC9 met.

| AC | State | Evidence |
|---|---|---|
| 8 Stale after N audits without the finding, distinct from resolved | Met | `reconcileFindings` emits `stale` (`STALE_AFTER_AUDITS = 2`); `crawl-audit.handler.ts` counts the audits just before this one that could not observe the finding's file (`aux_audits.excluded_rules`, so no new column). `lifecycle.test.ts` "STORY-052 scenario 10", `crawl-audit-handler.spec.ts` "STORY-052 scenario 10" (stale; one miss is not two; a run broken by an observed audit; reopen on re-detection; wont_fix untouched; a stale finding leaves the subscore and the cap) |
| 10 Findings above task threshold enqueue task generation | Met | one `task.generate` job per audit, `{projectId, triggerKinds: ['aux_finding']}`, after COMMIT, when a NEW or REGRESSED finding is at or above its rule's `aux_rule_catalog.task_threshold`. Contract: `contracts/tasks/task-generate-job.schema.ts`, shared with the consumer (STORY-063). "STORY-052 scenario 11" |
| 11 Closing a critical or high finding emits a milestone | Met | `kind aux_status_change`, `source_type aux_finding`, `source_id` = the finding, `ON CONFLICT DO NOTHING` on `ux_milestones_source`. `milestoneKindFor` also returns `schema_fixed` for a `structured_data` resolution at any severity (preferred over `aux_status_change`: one pin per source). "STORY-052 scenario 12" |
| 1 Score computed exactly as specified | Partial | unchanged: the full score needs all six categories (STORY-051 over STORY-049's pages) |
| 9 Affected page counts | Partial | unchanged: the handler records 1 of 1 for site-file findings; real counts need page-level rules (STORY-051) |

## Decisions taken (each follows the planner's recommendation unless stated)

1. **Stale versus resolved.** The reference reads, literally, that both are "a later audit does not see the finding". They are told apart by whether the audit COULD look: a finding is `resolved` only when this audit got an answer from the place the finding lives (`inScope`), and `stale` when it did not, in this audit and in the one before it, consecutively. Derived from `aux_audits.excluded_rules`; no new column. Add one sentence to `aux-and-geo-analysis.md` section 3 and `schemas/aux.md` ("The lifecycle"): "`stale` applies when the place the finding lives could not be observed in two consecutive audits; `resolved` needs an audit that observed it and did not find the finding."
2. **A job per audit, not per finding.** The topology row says `taskgen:{project}:{rule}:{fingerprint}`. The evaluation is project-wide and idempotent and the payload names no rule, so a job per finding would repeat it. The AUX producer uses `taskgen:{project}:aux:{audit}`. Either amend the `system-architecture.md` section 4 row to `taskgen:{project}:{rule}:{fingerprint}` (rollup) / `taskgen:{project}:aux:{audit}` (AUX), or tell the builder to key per finding. **Open: owner/architect decision needed before merge; the code keeps the per-audit key until then.**
2a. **Technical notes.** `src/lib/queue/handlers/task-generate.handler.ts` (now validates against the shared payload contract) and `contracts/tasks/task-generate-job.schema.ts` (`TASK_TRIGGER_KINDS`, an enum pinned equal to the condition kinds) are part of this story; add them to its Technical notes.
2b. **Stale history** reads only audits created strictly before the one running, so a redelivered older job cannot treat a newer audit as its predecessor.
3. **One milestone per finding for ever** (`ux_milestones_source`). A finding that resolves, regresses and resolves again keeps its first pin, because the regression is visible on the finding. A structured_data finding that qualifies for both kinds gets `schema_fixed`. The alternative (change the unique key) is a migration and a decision for the owner.
4. **AUX-R-005 and AUX-R-006 stay in STORY-051.** AUX-R-005 is not evaluated at all (owner decision 2026-10-22). They remain named in `excluded_rules`, so the partial score stays honest.
5. **Not from the reference:** nothing numeric was added. `STALE_AFTER_AUDITS = 2` is the reference's "2 consecutive audits".

## Not done, and why

- A failed audit (every site file unreachable) does not itself stale anything: it writes no findings and reconciles nothing. It does COUNT as an unobserved audit for the next one.
- Stale rendering in the client (`AuxSection`) belongs to STORY-094.
