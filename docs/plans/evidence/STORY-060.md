# STORY-060 — evidence (checkpoint 2)

## Acceptance criteria

1. RED first: form distribution per engine, brand position-class share with prior window, insufficient below minimum. `test/unit/geo/structure.spec.ts`: "#7 · the dominant form...", "per engine: ...", "#9 · position class movement is trended against the prior window", "no prior brand answers: prior is null, not 0", "#10 · below the minimum ... suppresses itself", "boundary: exactly the minimum is sufficient", "the minimum is the catalogue's stated 30".
2. Writes `geo_analyses` 'structure' through `refresh-project-geo.ts`. Checkpoint-1 failure was that nothing called it. Now called from the rollup handler, the demo seed and the purge. Proof: `test/integration/geo-structure-wiring.spec.ts` "a Gemini window parsed by the real parser is analysed by the rollup handler, as live data", "a second handler run replaces the row rather than adding one", "a window under the minimum is persisted as insufficient"; `test/integration/seed-demo.spec.ts` "STORY-060 · the seed computes the A3 structure row from its own facts...".
   - RED 8d844e0 (on parent source): exit 1, 3 failed / 2 passed (wiring: "a Gemini window parsed by the real parser..." and "a window under the minimum is persisted as insufficient"; seed-demo: the STORY-060 seed test). Fix c7096ab.
3. page_forms [] and template null, verdict no_action with a reason, never a fabricated gap: structure.spec "#8 · a table-dominant cluster never fabricates a gap".
4. Only parser columns (answer_form, position_class): same unit and wiring specs read only those.
5. Demo engines from seeded mention_facts, Gemini from real parser output: wiring spec (real `capture-parse` handler then rollup) and the seed-demo test; per-engine data_source "mixed when an engine has both kinds of row" (structure.spec).

## Checkpoint-2 finding closed (QA issue 4: the purge check was vacuous)
The old purge assertion passed with the purge refresh removed (the seed-created project is deleted outright). New test "STORY-060 · --purge on a PRE-EXISTING project recomputes A3 over what is left" (commit e2f4355) uses a surviving project. Mutation (comment out `refreshProjectGeoWindows` in `purgeOneProject`): fails, "expected 6 to be +0"; with the code: passes.
QA issue 2 (stale comment in rollup-metric-daily.handler.ts) fixed in cb327d1.
QA issue 3 (cost of 3 windows x 2 analyses): measured per window, not unmeasured — each recompute logs `nominara_geo_structure_recompute_duration_ms` / `nominara_geo_sentiment_recompute_duration_ms` with the window. No budget threshold has been set; left for the load review.

Observability: counters `nominara_geo_structure_recompute_total`, duration log lines (project_id, counts, window; no answer text).

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

## Audit fixes (checkpoint-2 audit)
- Isolation claim corrected: the earlier "tenant isolation proven instead" line is replaced by the real `test:isolation` / `test:isolation:breakers` runs and the direct `geo_analyses` RLS test (see the gate table; STORY-062.md has the correction).
- Purge on a later day (finding 3). RED a358317: "STORY-060 audit · --purge on a LATER day deletes the seed's geo_analyses rows outright" on a PRE-EXISTING project (a seed-created one is deleted with its rows, which hides the defect), Date faked +24 h: exit 1, 1 failed, "no sufficient (demo-derived) row survives: expected 6 to be +0". Fix 4179d3b: `purgeOneProject` deletes the project's `geo_analyses` rows before `refreshProjectGeoWindows`. Green re-run and mutation check (remove the DELETE, expect the same failure): NOT RUN, the disk gate stopped container specs (see "Disk gate" in NEW-C-15.md). Re-run `pnpm exec vitest run --config vitest.integration.config.ts test/integration/seed-demo.spec.ts -t "STORY-060 audit"` before merge.
- Judgement to confirm: the DELETE is unconditional per project listed by `listSeededProjects`; a purge of a project that is no longer listed (no marker, no demo capture) never reaches it.

## Checkpoint-3 fix pass (branch 7day/c-geo-4, from integration/7day fee788e)
Finding: purge recompute must clear rows even when purge runs on a later day. Already on the merged tree: `purge.ts` deletes the project's `geo_analyses` before `refreshProjectGeoWindows` (4179d3b) and the test "STORY-060 audit · --purge on a LATER day deletes the seed's geo_analyses rows outright ..." (Date faked +24 h, PRE-EXISTING project) is present. No code change needed.
- Mutation re-run (replace the `DELETE FROM geo_analyses` in `purgeOneProject` with a comment, restored after): `-t STORY-060` -> 1 failed, 3 passed, "no sufficient (demo-derived) row survives: expected 6 to be +0". Unmutated: all 4 STORY-060 tests pass.

## D2 entity (A2) and structure-match (A3) lane, review round 2 (branch story/060-entity-structure)

Status of each story AC after this lane. "Met" means data flows end to end in production; "pure only" means the logic and its persistence exist but nothing yet supplies the input.

| AC (story line) | Status | What flips the open ones |
|---|---|---|
| Entity: each node checked, URL and missing fields recorded (L20) | **Open, pure only** | `writeEntityNodes` / `deriveNodeRecord` have no caller: no profile-probe job exists and no source of the brand's `sameAs` exists, so `entity_nodes` stays empty and no score is published. Needs an owner decision on probe sources and their access terms, then a probe job behind a port, run outside any transaction (ADR-0003). |
| Presence and completeness separate (L21) | Met (unit + integration, over rows written by `writeEntityNodes`) | n/a |
| sameAs link coverage recorded (L22) | **Open, pure only** | Same as L20: needs the brand's `sameAs` source. |
| Authority score exactly §10 (L23) | Met for the formula (hand-computed 66.3); published only once all seven nodes are checked, so **open in production** | Probe job (L20). |
| Disambiguation risk separate (L24) | Met (computed from `mention_facts`; no profile data needed) | Judging is the v1 case heuristic, an owner-confirmable reading. |
| High risk suppresses the score, surfaces the alias task (L25) | Met as a finding carrying `TG-ENTITY-ALIAS` and a suppressed score | A task is not generated: `TG-ENTITY-ALIAS` is not yet a `task_generation_rules` row. Needs owner approval of the code, then the rule row. |
| Missing high-weight node: alert and task (L26) | **Open** | The finding carries `TG-ENTITY-NODE`, which is a disabled `pending_analysis` row; `entity_node_missing` appears only in the alert catalog and deep links and is never evaluated. Needs the rule enabled and alert-rule evaluation for `entity_node_missing`, plus the probe job. |
| Category co-occurrence vs competitors (L27) | Met over `corpus_passages` (real once STORY-058 passages exist; stand-in passages in tests) | Real embeddings are not involved; real cited-corpus volume is. |
| Structure: form distribution per cluster/engine (L31), position-class movement (L32) | Met (from the earlier lane) | n/a |
| Structure-match gap with template (L33) | **Open** | `loadStructureInput` never supplies `pages`, so the gap never fires. Needs a page source from STORY-050 wired in, a cluster-to-landing-page map, a spec-list template alternative, and `TG-STRUCTURE-TEMPLATE` approved and inserted as a rule row. |
| Evidence base and self-suppression (L34), free and unmetered (L35) | Met | n/a |

The unit test "#6" asserts the finding and its rule code. It does not assert a generated task or an alert, and must not be read as meeting L26.

### Review round 2 fixes
- Shared refresh path: `refreshProjectGeoWindows` now persists 9 rows per project (structure + entity + sentiment, three windows). The three counts in `geo-freshness` (two) and `geo-lever-rank` were updated 6 to 9, the `entity` rows are not filtered out. Every integration spec calling the refresh was run: geo-entity, geo-freshness, geo-lever-rank, geo-sentiment, geo-structure, geo-structure-wiring, geo-insights, seed-demo, rollups-aux-tasks-geo-tools (logs `plans-7day/logs/060-int-r2-*.log`).
- `termPattern`: now escapes only regex metacharacters and bounds by lookaround (`(?<![[:alnum:]_])...(?![[:alnum:]_])`), so ".NET" and "C++" match and non-ASCII letters are never backslash-escaped. Evidence against the finding's stated mechanism: on pgvector:pg18 the OLD pattern did NOT throw "invalid escape" for `\é`; the mutation run (old pattern) failed the integration hazard test with "expected 3 to be 5", i.e. the ".NET Hub" brand alias never matched. The throw could not be reproduced here, the symbol-edge miss was. The unit hazard test still forbids a backslash before any letter or digit, as protection against the theory.
- Per-analysis isolation inside the rollup transaction was NOT added: a failed statement aborts a Postgres transaction, so a try/catch around one analysis would leave the rest of the rollup running on an aborted transaction. It would need a savepoint per analysis; left as a follow-up decision.
- `judgeNameMatch` now treats a span inside a domain (TLD follows) or URL (scheme or `www.` earlier in the same token, or a markdown link target) as about the brand; hazard tests added.

### Owner questions recorded (constants and readings not in any reference)
1. `ENTITY_MIN_NAME_MATCHES = 30` and `ENTITY_MIN_CATEGORY_PASSAGES = 8` (reuses A1's passage minimum): confirm. Below 30 the disambiguation risk is "unmeasured" and the Entity Authority score is WITHHELD with a stated reason (round 3; previously published). Decide whether instead the score should publish when the raw ratio is <= 0.20 despite the thin count.
2. Rule codes `TG-ENTITY-ALIAS` and `TG-STRUCTURE-TEMPLATE`: approve and add as `task_generation_rules` rows; enable `TG-ENTITY-NODE`.
3. Category terms are derived from `category_slug` and `verticals`: confirm.
4. Name-match judging is the v1 case heuristic (lowercase span of a capitalised alias, minus domains/URLs): confirm, or fund a model-assisted judge behind the same signature.
5. Entity risk does not separate demo-seed `mention_facts` from live ones (structure does, via `data_source`): decide whether demo-derived risk must be flagged.
6. Co-occurrence is not windowed and is recomputed once per window (3x per rollup, same result): a single computation per rollup is a cheap follow-up, not done here.
7. Process: Entity Authority (scoring-models §10) and the A2 suppression logic are a scoring function; `dangerous-area-auditor` must review as second engineer before merge.

### Review round 3 fixes
- Major: `buildEntity` now withholds the authority score (score null, `authority.suppressed` true, reason names the 30-match minimum) whenever disambiguation is "unmeasured"; the "entity-ready" verdict is not emitted in that state (it would claim risk is not high). The unit test was rewritten to assert score null and the reason, and fails without the fix (66.3 published).
- `loadEntityInput` joins `answer_captures` with LEFT JOIN: a mention whose capture is gone is still a name match. New integration test fails without it (25 of 30 counted, below the minimum).
- `insideUrlOrDomain`: a span followed by `](` (markdown link text) is the brand; hazard case added.
- Follow-up for L33: when the page source is wired, it must be per cluster (cluster to landing page), NOT a union; today `structure.ts` aggregates page forms across all pages, so a table on any page would suppress the gap for every cluster.
- L25/L33 stay task-pending until `TG-ENTITY-ALIAS` / `TG-STRUCTURE-TEMPLATE` are approved; until then the high-risk alias finding ranks as a lever whose task is null. `dangerous-area-auditor` review is still owed; the STORY-060 status block is to be updated on merge.

| Gate (round 3, HEAD after this commit) | Result |
|---|---|
| `pnpm test:unit` | EXIT 0, 438 files passed + 1 skipped, 5649 tests passed + 1 skipped (`060-r3-unit.log`) |
| `pnpm lint` / `pnpm typecheck` | EXIT 0 / EXIT 0 |
| integration geo-entity 11, geo-freshness 5, geo-lever-rank 16, geo-insights 16, rollups-aux-tasks-geo-tools 46 | all EXIT 0 (`060-r3-*.log`) |
