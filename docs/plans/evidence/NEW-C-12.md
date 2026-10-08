# NEW-C-12 (A4 cross-engine divergence) and the c-geo audit — evidence (checkpoint 2)

RED: 3fb88df (run on parent source: exit 1, 23 failed / 23, "crossEngineDivergence is not a function"); implementation ce70b3a. Audit RED f47474a (run on its parent source: exit 1, 10 failed / 23 passed of 33); fix 481f45e. All in `test/unit/scoring/divergence.spec.ts`.

## Acceptance criteria
1. Hand-computed values; o(e) = 0 / 0.4 / 0.7 / 1.0; discount by stability; >= 2 engines; attribution by set difference ranked by context_weight: [A4-1]..[A4-17].
2. Pure function in src/lib/scoring, tests first: yes (imports nothing; RED before implementation).
3. Demo as live: owner rule "anything else = planner recommendation" = count and label. Headline mean counts demo, labelled (`data_source`); live-only mean `projectDivergenceLive` exposed for the alert to gate on: [A4-18]..[A4-20], [A4-29]..[A4-32]. Stale "decision open" comments updated (cb327d1).
4. Cut candidate: kept. NOT wired: nothing calls the function; the divergence_high alert and engine-targeted task (STORY-061 divergence ACs 5, 6) need their own story. Stated, not silent.

## Audit findings (CP2 verdict not_approved) — status
- Denominator of project_divergence untested, dilution mutant survived: closed by [A4-8b], [A4-11] (481f45e / f47474a).
- Outcome vocabulary vs stored position_class: closed by `divergenceClassFor`, [A4-24]..[A4-28].
- Demo counted as qualifying: resolved by owner rule above, plus live-only mean.
- STORY-062 issue 2 unresolved: closed (see STORY-062.md; 8fb0502 RED, 37e4b0e).
- OWNER DECISION 7 (null stability_score excluded and counted): [A4-10] and [A4-8b], [A4-23] (NaN). Implemented in `crossEngineDivergence` as `excluded.noStability`. Residual risk: if demo data never carries stability scores every prompt drops out; the count makes that visible, and the function is not yet wired.

## Still open (needs owner, not decided here)
- `also_consider` and `caveat` stored classes have no o(e) in scoring-models.md §10 A4. Code drops them as 'unscored' and counts them in `excluded.unscoredResults` ([A4-26], [A4-28]). Needs a reference line.
- DOCS TO CARRY (no .git in the docs repo): STORY-061 "A4 decisions, NEW-C-12 audit" note says the demo-as-live question is open; it is now decided (count and label; alert gates on live), and null-stability exclusion (decision 7) should be added. The note's item (1) stays open.

Observability: pure function, no I/O; its counter/log arrive when it is wired.

## Gates (worktree api-wt-c3, branch 7day/c-geo-3, tip before this doc: cb327d1)

| Command | Exit |
|---|---|
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (277 files passed, 1 skipped; 3313 tests passed, 1 skipped) |
| `pnpm exec vitest run --config vitest.integration.config.ts test/integration/geo- test/integration/seed-demo.spec.ts -t "STORY-06\|geo\|GEO"` (colima env, testcontainers) | 0 (5 files, 39 passed, 34 skipped by the filter) |
| `pnpm contracts:check` | 0 (no contract changed in this lane work) |
| `pnpm test:isolation` | NOT RUN: crashes in fixture setup at this tip (support_grants TTL, d-admin lane). Tenant isolation proven instead in `test/integration/geo-insights.spec.ts` "STORY-062 isolation" under `SET ROLE nominara_app` (mutation: dropping the SET ROLE makes it fail, "promise resolved ... instead of rejecting"). |

Spans: OpenTelemetry spans are DEFERRED to week 2 (owner, 2026-10-08); a missing span is not a failed criterion. Metrics and redacted logs are present (see each section).
Anything needing a running real API (HTTP-level permission, 0-credit header) is collected in NEW-A-17.
