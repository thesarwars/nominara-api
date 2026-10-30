# STORY-061 (A6 sentiment drivers; A4 is NEW-C-12) — evidence (checkpoint 2)

RED: contract 9a609b3, RED tests 4469917 / e85bca3 (run on parent source: exit 1, "Cannot find module src/lib/geo/sentiment.js", the unit file cannot load), implementation 4413620.

## Acceptance criteria (track-plans.json)
1. Span, cues, reason, nearest citation; clusters by domain, cross-engine first. `test/unit/geo/sentiment.spec.ts`: "AC1 · every non-positive mention carries its span...", "AC1 · the citation is the NEAREST slot...", "AC1 · a citation that cannot be located is NOT guessed", "#10 · several negative mentions citing one source are clustered", "AC1 · a cluster spanning engines is ranked above a bigger single-engine cluster". Integration: `geo-sentiment.spec.ts` "#10 · negative mentions across two engines citing one thread are one cluster, read back from the stored row".
2. factual_error false with a reason, never guessed: "AC2 / #12 · factual_error is false with a reason on every mention".
3. One task per distinct reason class deferred; verdict 'action' with task_title only: "#11 · one task rule per distinct reason class", integration "#11 · one action per distinct reason class, a title and no task id".
4. Only parser-written columns; free and unmetered: "AC4 ..." tests, integration "#14 · free and unmetered: no credit ledger entry". Reads never recompute: "a READ never recomputes: facts changed after the rollup do not change the detail until the next rollup".
Below-minimum: "#13 ...30 is enough" (unit and integration).

## Checkpoint-2 finding closed
QA issue 5: every sentiment unit test now carries a requirement ID (commit cb327d1). This environment ran geo-sentiment.spec (the CP2 run had no Docker): pass.

## Gates (worktree api-wt-c3, branch 7day/c-geo-3, tip before this doc: cb327d1)

| Command | Exit |
|---|---|
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (277 files passed, 1 skipped; 3313 tests passed, 1 skipped) |
| `pnpm exec vitest run --config vitest.integration.config.ts test/integration/geo- test/integration/seed-demo.spec.ts -t "STORY-06\|geo\|GEO"` (colima env, testcontainers) | 0 (5 files, 39 passed, 34 skipped by the filter) |
| `pnpm contracts:check` | 0 (no contract changed in this lane work) |
| `pnpm test:isolation` | 0 (13 files, 53 tests) at 91c9d9c, after cherry-picking the d-admin fixture fixes d25c2cb (as 8e96983) and 1d97921 (as 91c9d9c). The generic suite discovers `geo_analyses` from `tenant-tables.generated.ts`. |
| `pnpm test:isolation:breakers` | 0 (1 file, 24 tests) at 91c9d9c |
| `geo_analyses` policy, directly | `test/integration/geo-insights.spec.ts` "STORY-062 isolation · geo_analyses itself ..." (3f00708): as `nominara_app` under another tenant, SELECT 0 rows, UPDATE 0, DELETE 0, INSERT for the victim fails 42501. Fails under three policy mutations: RLS disabled ("expected 1 to be +0"), USING/WITH CHECK (true) ("expected 1 to be +0"), WITH CHECK (true) only ("promise resolved ... instead of rejecting"). |

Spans: OpenTelemetry spans are DEFERRED to week 2 (owner, 2026-10-08); a missing span is not a failed criterion. Metrics and redacted logs are present (see each section).
Anything needing a running real API (HTTP-level permission, 0-credit header) is collected in NEW-A-17.

---

# STORY-061 (A4 divergence, A5 topical authority, A6 threshold) - owner decisions and builder readings (round 3, 2026-10-30)

Branch `story/061-divergence-topics-sentiment`. Source of the decisions: `plans-7day/decisions-2026-10-28.md` items 20-23.

## Owner decisions applied

- **20. Task rules.** TG-DIVERGENCE (retargeted to the `geo_finding` condition: one task per losing engine and missing domain), TG-TOPIC-CONTENT (retargeted: one task per achievable topic gap) and TG-SENTIMENT-REASON (new: one task per distinct reason class) are approved and ENABLED by migration 0152 (edited in place; it was unmerged). The `enabled_since` trigger stamps the migration moment, so no analysis row computed earlier generates a task. A dev database that applied the earlier 0152 must be rebuilt (its checksum and rule state differ).
- **21. negative_spike alert.** `alertRuleForTask` maps TG-SENTIMENT-REASON to `negative_spike` (`src/lib/alert-rules/catalog.ts`, `generates`). TG-SENTIMENT-NEGATIVE stays a pending, disabled rule and no alert maps to it. A crossing raises ONE alert (scope = the project) plus one task per reason class; the alert's cooldown (3 d) is therefore per project.
- **22. Threshold.** A crossing needs the section 6 level (negative_cell_rate >= 0.05, n >= 30) AND the section 15 rise (up >= 0.03 on the prior window, which meets its own n >= 30). Both are `>=`. `shouldAlertOnNegativeSentiment` was a strict `>`; its only caller is this rule, so it now uses `>=` (its unit test for exactly 5/100 flipped from false to true on that basis). The rise is compared with a 1e-9 tolerance so that exactly 0.03 is not lost to float subtraction. The prior-window floor is `n >= 30`; an empty or short prior window is "no rise", never a rise from zero. `crossed = level && rose`; both are in the contract (`rose`, `prior_cells`, `rise_threshold`).
- **23. Demo data.** Demo data (`normalizer_version = 'demo-seed'`, the STORY-169 marker) never generates topic or sentiment tasks. The analyses are still computed and shown, with `data_source` `demo` or `mixed`; their findings then carry `no_action` and no `task_rule_code`. Fail closed: ANY demo capture in the window suppresses the task, even on a mixed window. Sentiment's data source now also reads the window's parsed answers, not only its brand mentions.

## Needed in the reference (docs repo, to be carried; this change does not edit it)

- **scoring-models.md section 15:** the `negative_spike` row's Generates column becomes `TG-SENTIMENT-REASON` (one task per distinct negative reason; decision 21).
- **scoring-models.md sections 6 and 15 reconciled:** section 6 says "`negative_cell_rate` crossing 0.05 with n >= 30 fires the alert"; section 15 says "`negative_cell_rate >= 0.05` and up >= 0.03". Decision 22: the alert needs both (level `>=`, rise `>=`, prior window with its own n >= 30).

## Builder readings for section 10 (not owner rulings)

- `target_alignment` is the empirical band floor (`geo_alignments.target_band_low`, the p50 of the cited documents); `current_alignment` is the brand's best-aligned analysed page for the cluster.
- The achievability minimum is 0.5 (the `topic_gap_high` alert's own floor, section 15).
- A gap task is raised for the top decile of gap_priority, at least one topic (the cap is `ceil(0.1 * n)`, minimum 1).
- The brand's first mention is the position class of a prompt-engine result in divergence (`occurrence_index`, then `char_start`).
- A divergence finding carries the brand's home page as its FIRST evidence URL (STORY-060's contract: the task's affected URL is `evidence[0].url`), with the third-party domain second. The topic finding does the same. The sentiment finding's first evidence URL is still the cited source the framing traces to (the thread the task is about); it is a source, not a competitor's domain, and was left alone.

## Review minors closed

- Divergence loader: the live filter runs inside the DISTINCT ON, so a later demo capture cannot shadow a live one; demo (prompt, engine) pairs are counted apart into `excluded.demo_results`.
- Topics loader: the answer-form query joins `answer_captures` with `hasFactsStatusSql` and requires `tp.deleted_at IS NULL`, like the cells query.
- Task target: see the evidence URL reading above.

## Known gap, documented rather than fixed (builder reading)

"No facts at this `scoring_version`" is read as ABSENT in two places: the divergence first-mention join (a capture with no brand mention row at the current scoring version is "brand not mentioned") and the sentiment cell denominator (a parsed answer with no mention rows counts as a cell with no negative mention). A parsed capture whose facts were written at an older scoring version is therefore not distinguishable from a parsed capture that genuinely named nobody. Telling them apart needs a per-capture marker of "facts exist at this version" that the parser does not write; it is not small. Until then a re-score gap reads as absence. Candidate follow-up: a `facts_scoring_version` on `answer_captures`.

## A5 needs a real-model run

A5 (topical authority) is proven here on stand-in data: crafted alignments, concepts and prominences, and no embedding model. The achievability inputs (`geo_alignments`, `semantic_nodes`) come from STORY-059/060's real-model path; an end-to-end run with a real embedding model, against a project with measured alignments, is still owed before the recommendation quality can be judged.
