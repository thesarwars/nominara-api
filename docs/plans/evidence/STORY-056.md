# STORY-056 — displacement detection and the D1 impact score (CP2 close-out, lane c-comp)

Branch 7day/c-comp-3 from integration/7day f201f35. Observability: metric `nominara_rollup_displacements_persisted_total` and a redacted
log line (workspaceId, projectId, date, count) in `refreshProjectDisplacements`. **OpenTelemetry spans are DEFERRED to week 2
(owner decision 3); a missing span is not a failed criterion this week.**

## Acceptance criteria (track-plans.json)

1. RED first, own commit, scenarios 1-7. Test: `test/unit/analytics/displacement.spec.ts` (scenarios 1-5) and
   `test/unit/scoring/displacement-impact.spec.ts` (scenarios 6, 7). RED commits `deb2fd7` (fails at import: modules absent),
   `5b6e57f` (audit RED), `364105d` (this change: **5 failed / 35 passed of 40, exit 1**, the topic-rank test failing 93 vs 98).
2. Pure functions in `src/lib/scoring/displacement-impact.ts` and `src/lib/analytics/displacement.ts`, importing nothing:
   `test/unit/scoring-purity.spec.ts` (green in `pnpm test:unit`).
3. **Golden-set gate: UNAVAILABLE.** No golden-set runner exists for the D1 scoring change, so the gate was not run.
   `scoring_version` is stamped on each row (`SCORING_VERSION`), was not bumped, and there is no dual-compute. Stated in code at
   `TOPIC_RANK_BY_INTENT` in `src/lib/rollup/refresh-project-displacements.ts` (commit `768893f`) and here.
4. **Spec ambiguity `rank_of_topic_by_intent` — RAISED, owner to confirm.** scoring-models.md section 9 names it and defines no
   ordering. The previous code silently ranked `topic_clusters` by commercial_intent (QA: unflagged, untested). Now the planner
   recommendation: rank 1 for every prompt, flagged in code (`768893f`) and pinned by
   `test/integration/refresh-project-displacements.spec.ts` > "CP2 STORY-056 · rank_of_topic_by_intent is 1 for every prompt,
   even one in a lower-intent cluster (flagged spec reading)" (prompt in a 0.4-intent cluster beside a 0.9 cluster still scores 98;
   cluster ranking would give 93). **Owner question: keep rank 1, or define the cluster ordering in the reference.**

## CP2 audit findings (all four closed before this change, verified here)

| Finding | Closed by | Proof |
| --- | --- | --- |
| caveat-to-caveat charged 0.70 | `6266fb3` | `displacement-impact.spec.ts` "a caveat-to-caveat move is not a new caveat demotion (row null)" |
| render_downgraded scored with class-change row and full position loss | `6266fb3` | "a render_downgraded event takes the render-only row even when the class also changed"; "a multi-kind change is scored per event" |
| numeric pins dropped on 3 of 5 class_penalty constants | `5b6e57f` | "scenario 6b — every §9 class_penalty constant is pinned exactly" (all five, `toBeCloseTo(.., 9)`) |
| presence_lost from any class takes 1.00, unflagged | `6266fb3` | flagged in the doc comment on `classPenaltyKindFor`; pinned by "presence_lost keeps the recommendation_to_absent row for every before class (flagged reading, pinned)". Spec-owner ruling still needed. |

QA mutation survivor (`restoresSlot` position check always true) is covered only by the integration test "STORY-056 #10 · a position
loss recovers only when the position is regained, not on any later capture" — which ran and passed here (below).

## Gates (api-wt-c1, HEAD 768893f unless noted)

| Command | Exit |
| --- | --- |
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (277 files + 1 skipped; 3313 tests + 1 skipped) |
| `pnpm contracts:check` | 0 |
| vitest integration: refresh-project-displacements, competitor-confirm-cap, competitor-panel, competitor-track, milestone-competitor-removed-migration | 0 (5 files, 58 tests) |

Scenarios 11 (milestone on recovery after a completed task) and 13 (no-cooldown alert) remain deferred, named, not faked.
Scenario 12 (detection lag) has no test. Evidence needing a running real API is collected in NEW-A-17.
The STORY-056 story file still reads `Backlog`; the docs repo has no .git here, so that status edit is for the owner to carry.
