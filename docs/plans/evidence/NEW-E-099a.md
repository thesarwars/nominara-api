# NEW-E-099a — portal overview, growth-map, matrix (STORY-099 part A)

Branch `7day/e-portal-3`. No migration (the `portal_scope_*` policies on metric_daily, milestones, projects, competitors
already exist). Dangerous area (RLS / tenant context).

Commits: contract `d4093d9`; RED `313a701`; GREEN `22a8344`.

## READ THIS FIRST — what was and was not run

- **The integration spec `test/integration/portal-reads-http.spec.ts` (15 tests) was WRITTEN AND COMMITTED BUT NOT RUN.**
  `df -h /System/Volumes/Data` showed 6.1 to 6.6 GiB free; the rule is to stop below 8 GiB, so no testcontainers spec was
  started. Every row below that cites it is therefore **unproven**, not passing. Typecheck and lint pass on it.
- **The RED run is unit-only.** At `313a701` the two unit specs fail to load (module not found, `Test Files 2 failed`, exit 1).
  The integration spec's RED state was not observed for the same reason.
- Tenant isolation here rests on the integration spec running as the real `nominara_portal` pool; it has to be run (disk
  permitting) before this merges. `test:isolation` is not runnable at this tip (known support_grants fixture crash).
- Evidence that needs a running real API is collected in NEW-A-17.

## Criteria

| Criterion | Proof | Result |
|---|---|---|
| RED tests first, covering STORY-098 s10-14, s22 and STORY-099 s3, s4, s8, s10, s15-16 | Unit: `src/lib/portal/portal-view.spec.ts`, `src/modules/portal/portal-cache.spec.ts`. Integration: `test/integration/portal-reads-http.spec.ts`. RED `313a701`: unit 2 files failed to load, exit 1. | unit RED confirmed; integration RED not observed |
| s10 out-of-scope project or tab is 403 `project_out_of_scope` | unit "STORY-098 s10 ... assertPortalTab"; integration "STORY-098 s10 · an out-of-scope project, and a tab outside scope_tabs..." | unit pass; integration NOT RUN |
| s11 hide_competitors: Competitor A/B/C, comparison suppressed | unit "s11 · hide_competitors: labels become Competitor A/B/C..." and the visible-control case; integration "s11" (2 tests, also asserts the competitor-named milestone is dropped) | unit pass; integration NOT RUN |
| s12 hide_costs: no quota/capture-count/cost field, asserted by key scan | unit `findCostFields` (3 tests) and "no point carries cells"; integration "s12 · hide_costs: a key scan of every portal payload...". The service also scans each payload under hide_costs before storing it and throws if anything is found. | unit pass; integration NOT RUN |
| s13 timeframe_lock cannot be widened by `?timeframe=` | unit `resolvePortalTimeframe` (4 tests across the ladder); integration "s13" (overview and growth-map return 400 `validation_failed`; lock is what is served and reported) | unit pass; integration NOT RUN |
| s14 `visible_in_portal=false` milestones absent, filtered in SQL | `GrowthMapService.milestones` adds `($5::boolean = false OR visible_in_portal = true)`; integration "s14" | integration NOT RUN |
| STORY-099 s3 every mutating verb on /portal/* refused | the controller declares GET only; integration "s3" (POST/PUT/PATCH/DELETE on all three paths are 4xx and nothing is written) | integration NOT RUN |
| STORY-099 s4 scope in the request is ignored | `.strict()` query schemas; scope only from the cookie and the token row; integration "s4" (unknown query key 400, scope header changes nothing) | contract test pass (`portal-read.schema.test.ts`); integration NOT RUN |
| STORY-099 s8 only scoped projects and sections render | integration "s8" (two tests) | NOT RUN |
| s22 / STORY-099 s15 two tokens never share a cache entry (key includes token_id) | unit `portalCacheKey` and `PortalCache` (7 tests); integration "s22" (open and hidden tokens, both orders) | unit pass; integration NOT RUN |
| STORY-099 s16 private, non-cacheable, search-excluded | headers set by `PortalContextInterceptor` (098b); integration "s16" re-asserts them on the new routes | NOT RUN |
| Reads run on the nominara_portal pool under the portal GUCs; RLS enforces scope independently | `@PortalRoute()` on all three handlers (the interceptor from 098b opens the READ ONLY nominara_portal transaction); integration spec runs on the real portal pool | NOT RUN |
| Scorecards and growth-map logic reused, not forked | `PortalReadsService` calls `ScorecardsService`, `GrowthMapService`, `MethodologyService`, `AgencyService`; the only edits to the first two are an optional `days` override and `portal` options | by construction |
| Overview carries the methodology footer per project; theme cannot remove it | `PortalReadsService.overview` builds the footer from `MethodologyService.footer` unconditionally; integration "s10 · the methodology footer is on every overview project..." | NOT RUN |
| dangerous-area-auditor reviews as second engineer | not done in this lane run | PENDING (merge step) |
| Mutation check | with the token id removed from the cache key, the timeframe widening check disabled, and the cost-key match removed: 4 unit tests failed, 16 passed; files restored, 20 pass | done (unit only) |

## Decisions the owner should see

1. **Rollups only is not met by the reused services.** `ScorecardsService` (via `aggregateRange`) and the growth-map
   failure-day / provenance reads query `answer_captures` and the fact tables. The portal role has `portal_scope_*`
   policies on them, so scope still holds, and only aggregates leave. Reusing them is what the criterion asks ("reused
   rather than forked"); meeting "rollups only" would mean a second, rollup-only implementation. Same tension as the CP2
   NEW-E-100a finding. STORY-099 part B's "no fact-table access" scenario (14) cannot pass with this design as it stands.
2. **`timeframe` rule**: a request wider than the lock is a 400 `validation_failed` (path `timeframe`); a narrower one is
   honoured; none gets the lock. The default with no lock is 30d. The story says "Refused" without a code; say if 403 is wanted.
3. **hide_costs and the footer.** The methodology footer (mandatory, unremovable) carries `sample_size` and
   `live_capture_ratio`. They are kept under hide_costs: they describe the statistical basis, not cost. The per-day
   `cells` count is removed from every growth-map point for every token (contract change in `d4093d9`).
4. **hide_competitors** relabels competitor series (and their ids) and drops competitor-named milestones. The baseline
   series and the brand-vs-baseline gap are kept (they name nobody). The portal overview has no comparison table to suppress.
5. The portal 24h window is served through an `opts.days` override on the two analytics services (their query enums have no `24h`).
6. Outside the story's named files, touched minimally: `ShareTokensService.resolveSession` (token policy re-read per request,
   `isSessionLive` now delegates), `PortalContextInterceptor`/`PortalSessionContext.policy`, `AgencyService.themeForPortal`,
   `WorkspacesService.displayName`, `ProjectsService.namesFor` (each owning service answers for its own table).

## Observability

- Metric: `nominara_portal_reads_total{tab,cache}`. Log line `portal.read` with workspace id, token id, tab, cache, duration;
  no names, labels or figures. **Not unit- or integration-verified beyond the code path** (the integration spec does not assert it).
- Spans: **OpenTelemetry spans are deferred to week 2 by owner decision**; a missing span is not a failed criterion this week.

## Gates (on `22a8344`)

- `pnpm lint` exit 0
- `pnpm typecheck` exit 0
- `pnpm test:unit` exit 0 (280 files passed, 1 skipped; 3338 tests passed, 1 skipped)
- `pnpm contracts:generate` then `pnpm contracts:check` exit 0; `pnpm contracts:diff` against the previous file reports `minor`
- `pnpm test:integration` for the spec above: **NOT RUN** (disk under 8 GiB)
- `pnpm test:isolation`: not runnable at this tip; merge step runs it

## Audit round (checkpoint-2 audit findings) — status

Commits: RED `a932e56` (9 failed | 13 passed in portal-view.spec.ts, exit 1; every negative case asserts ZodError so the RED is the missing
`parsePortalPayload`, not a coincidental throw); GREEN `712ebd8`. Gates at GREEN: `pnpm lint` exit 0, `pnpm typecheck` exit 0,
`pnpm test:unit` exit 0 (283 files passed, 3369 tests passed, 1 skipped).

CORRECTION to the "READ THIS FIRST" block above: the integration spec was reported as not run because of the disk rule; the auditor ran it
on colima and it is RED (11 of 15), all three portal reads failing on the real `nominara_portal` role. That means every "integration NOT RUN"
row above is **unproven and, for the three reads, known failing**, not "pending".

| Finding | State |
|---|---|
| 1 [blocker] portal reads fail on `nominara_portal` | **NOT FIXED. BLOCKED.** `df -h /System/Volumes/Data` shows 4.5 GiB free (rule: stop under 8 GiB), so no testcontainers spec can be run and the RED/GREEN cannot be observed against the real role. The fix touches the analytics SQL (engineConfig's join of the entitled view, catalog and overrides) and cannot be done responsibly unobserved. Needs: free the disk to 8 GiB or more, and the owner picks the route (below). |
| 2 [major] isolation gate cannot run | **Not this lane's.** `test/isolation/support/three-tenant-fixture.ts` seeds support_grants with a 1-day expiry against the 4-hour cap; the d-admin lane owns the fixture. Nothing changed here. Merge must not proceed until it lands and the suites run. |
| 3a allow-list on the way out | **DONE.** `parsePortalPayload` in `src/lib/portal/portal-view.ts`, applied in `PortalReadsService.cached` before the cache and before serving. Tests: "NEW-E-099a audit · parsePortalPayload" (9 cases: captures, n_captures, runs_used, capture_total, top-level key, matrix engine key, growth-map point still carrying cells, task row key, and the valid shapes pass). The key scan stays as a second line. Caveat: it is not exercised against real payloads until the integration spec runs; a real payload with a key the strict schema lacks would 500 (fail closed). |
| 3b footer `sample_size` under hide_costs | **OWNER RULING NEEDED.** Not decided here. Evidence for the ruling: NFR-AGY-05 / the report footer list in integrations-and-sharing.md names data-through, scoring version, weight overrides, engines, timeframe, live-capture ratio and the note; `sample_size` is NOT in that list. So dropping it under hide_costs would not breach NFR-AGY-05 (live_capture_ratio is a ratio, not a count). Needs: ruling, then a portal footer schema without `sample_size` for hide_costs, a RED test, and the exemption test in portal-view.spec.ts inverted. |

### Finding 1 — the two routes, for the owner
(a) Resolve in the interceptor's app-pool step and pass in: timezone and workspace name (one `workspaces` read), the theme (`AgencyService.themeForPortal`
on the app tx), and the entitled-engine rows (`project_entitled_engines` + `engines` + `project_engines` overrides) for the scoped projects;
`resolveWindow`, `GrowthMapService.resolveWindow` and `ScorecardsService.engineConfig` take them as an optional argument. No migration, no ADR; scope stays
RLS-enforced on every fact table. Cost: the entitled/measured join in engineConfig is split into a view read (app pool) and a measured read (portal pool).
(b) Portal SELECT policies on workspaces and brand_themes (ADR required for brand_themes, which was deliberately removed from PORTAL_READABLE_TABLES) plus
a grant on the view and policies on its underlying tables: a migration the story did not name.
Recommendation: (a). Blocked on disk before either can be proven.

## Finding 1 closed — integration spec now run and GREEN (supersedes every "integration NOT RUN" row above)

The disk rule is satisfied (13 to 18 GiB free at run time), so `test/integration/portal-reads-http.spec.ts` was run on colima
(`DOCKER_HOST` and `TESTCONTAINERS_RYUK_DISABLED` set). Route (a) from the finding was taken: no migration, no ADR, no new policy.

- RED observed at tip `6ba523a`: `Tests 11 failed | 4 passed (15)`, exit 1. Cause: the services read `workspaces` (timezone, name,
  scoring version, overrides), `brand_themes`, `project_entitled_engines` and `project_engines`, none of which `nominara_portal`
  can read, so every portal read was `404 no such project` or an empty body.
- Fix `08415fe`: `PortalContextInterceptor` reads those facts on the APP pool, in the same short workspace-scoped transaction as the
  per-request token liveness check (a dead token ends before any is read), via the owning services (`WorkspacesService.portalFacts`,
  `AgencyService.themeForPortal`, `ProjectsService.portalEngines`), and puts them on `PortalSessionContext.facts`
  (`src/lib/portal/portal-facts.ts`). `resolveWindow`, `ScorecardsService`, `GrowthMapService` and `MethodologyService.footer` take them
  as an optional argument; the agency path is unchanged and every fact table is still read on the portal pool under RLS.
  `ScorecardsService.engineConfig` swaps only its two relation sources (view and override table) for the pre-read rows on the portal path.
- A second defect surfaced once the reads ran: `findCostFields` matched the overview's own `hide_costs` policy flag, so the overview
  was a 500 under hide_costs. RED `8124c1c` (1 failed | 22 passed in `portal-view.spec.ts`, exit 1), GREEN in `08415fe`. The exemption is
  exactly the top-level key `hide_costs` holding a boolean; a figure under that name, or the key nested, still trips the scan.
- Harness: `test/support/api-harness.ts` `extras` now accepts `imports` (it previously replaced `ApiModule`, so it is merged), and
  `portal-context-http.spec.ts` imports the three modules the interceptor now depends on. Mechanical, no assertion changed.

### Gates on `08415fe` (exit codes read)

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test:unit` | exit 0, 283 files passed | 1 skipped; 3370 tests passed | 1 skipped |
| `test/integration/portal-reads-http.spec.ts` | exit 0, 15 of 15 (all rows s3, s4, s8, s10 to s16, s22, matrix null path now proven over real HTTP on the real `nominara_portal` role) |
| `portal-context-http`, `portal-session-http`, `portal-tasks-http`, `share-tokens-http` | exit 0, 10, 18, 14, 16 passed |
| `scorecards`, `growth-map`, `methodology-footer` integration (agency path unchanged) | exit 0, 29, 14, 11 passed (run before the harness-only edits; no src change since) |
| `pnpm test:isolation` | not run: known `support_grants` fixture crash, d-admin lane; the merge step runs it. Tenant isolation here is proven by the portal-reads and portal-context specs, which run as `nominara_portal` |

### Updated criteria state

Every row of the Criteria table that read "integration NOT RUN" is now **integration pass** on `08415fe`, except:
- dangerous-area-auditor second-engineer review: still PENDING (merge step).
- Observability: the counter `nominara_portal_reads_total` and the redacted `portal.read` log line exist; the integration spec does not assert them. Spans deferred to week 2 (owner decision).
- Finding 3b (footer `sample_size` under hide_costs): still needs the owner ruling stated above; unchanged.
- "Rollups only" tension (Decision 1 above): unchanged and still the owner's call.
- Evidence needing a running real API (live portal against a real stack) is collected in NEW-A-17.

## Audit round 3 (2026-10-08): leak on growth-map, 0112 operator note

- Finding 1 [blocker], hide_competitors leak through a task_completed milestone: fixed at `eba7de6`
  (`GrowthMapService.milestones`: NOT EXISTS over tasks by source_type='task' AND source_id with source_displacement_id set;
  the dead `source_type IS DISTINCT FROM 'competitor'` predicate is removed). Test:
  `test/integration/portal-reads-http.spec.ts` "STORY-098 s11 · hide_competitors: a task_completed milestone of a
  displacement-born task ..." (asserts tasks and growth-map bodies both lack "Globex", plus the unhidden control).
  RED commit `e181a1c`. **NOT RUN, so NOT OBSERVED RED OR GREEN**: `df -h /System/Volumes/Data` showed 6.3 GiB free (rule: stop
  under 8 GiB), so no testcontainers spec was run. Needs: free the disk to 8 GiB, then run
  `pnpm exec vitest run --config vitest.integration.config.ts test/integration/portal-reads-http.spec.ts` at `e181a1c`
  (expect the new test red) and at `eba7de6` (expect green).
- Finding 2 [major], 0112 / README G-4 / ADR-0002 wording: now state a SUPERUSER migration identity is required and a
  non-superuser path is not designed (no test added, since none is claimed). 0112 edit is comment-only; the runner keeps no checksum.
- Gates at `eba7de6`: `pnpm lint` exit 0, `pnpm typecheck` exit 0, `pnpm test:unit` exit 0 (283 files passed, 1 skipped; 3370 tests).
  Isolation suites are run at merge. Real-API evidence is collected in NEW-A-17.

## Checkpoint-3 fix pass (branch `7day/e-portal-4`, from integration/7day fee788e)

RED `3a0483a` (6 failed, 50 passed in `src/lib/portal` + `src/modules/portal`, exit 1; the failures are the sample_size assertions and the
missing `toPortalFooter`, not a coincidental throw). Fix `2c403e3`.

| Item | Proof | Result |
|---|---|---|
| All three portal reads run on the REAL `nominara_portal` role and pass | `test/integration/portal-reads-http.spec.ts` builds its app with `DATABASE_URL_PORTAL` set to user `nominara_portal` (lines 24-26). Re-run on the merged tip before any change: `portal-reads-http` + `portal-tasks-http` 30 passed, exit 0. After the fix: `portal-reads-http` 17 passed (15 + the e181a1c leak test + the new sample_size test). The route taken is audit route (a) from "Finding 1": workspace-level facts read on the APP pool and passed in; NO grant or policy was added, `PORTAL_READABLE_TABLES` is unchanged, so nothing is a bypass and `conventions.ts` / `db:rls-generate` needed no change. | pass |
| e181a1c / eba7de6 hide_competitors leak (previously never observed) | integration "STORY-098 s11 · hide_competitors: a task_completed milestone of a displacement-born task ..." now observed GREEN on the merged tip (it is in the 17). Its RED was not re-observed (the fix was already merged). | GREEN observed |
| hide_costs drops `sample_size` from the footer (owner decision 2026-10-08) | unit `portal-view.spec.ts`: "STORY-098 s12 · owner decision 2026-10-08: sample_size ... scan flags it", "hide_costs: a footer that still carries sample_size fails closed", "hide_costs: a footer without sample_size is served, and every other footer field is still required", "costs visible: the footer keeps sample_size ... fails closed", "toPortalFooter drops exactly sample_size ..."; `portal-reads.service.spec.ts` "owner decision 2026-10-08 · hide_costs: the served footer has no sample_size ...", "costs visible: the served footer keeps sample_size (including 0)"; integration "NEW-E-099a owner decision 2026-10-08 · hide_costs: the methodology footer carries no sample_size on the wire; with costs visible it does" (asserts the raw body does not contain the string `sample_size`). The exemption test that said the footer's `sample_size` is not a cost field was INVERTED, as 3b prescribed; `live_capture_ratio` stays clean. | pass |
| Allow-list wiring into the service, proved by mutation | `src/modules/portal/portal-reads.service.spec.ts` (6 tests, stubs emit keys the cost-key scan does not list). Mutations on `portal-reads.service.ts`: M1 drop the `parsePortalPayload` call -> 3 failed; M2 hardcode `hideCosts:false` into it -> 2 failed; M3 stop calling `toPortalFooter` -> 2 failed; M4 parse against the wrong tab schema -> 3 failed. All restored (git status clean). | pass |
| Contract | `portalMethodologyFooterSchema` (sample_size optional: what clients type against) plus the two strict server shapes `portalOverviewCostsVisibleSchema` / `portalOverviewCostsHiddenSchema`. `parsePortalPayload` now REQUIRES `{hideCosts}` (no default). `contracts:diff` of the regenerated document against HEAD: `patch`; `/portal/overview` is not in `contracts/baseline/openapi.previous-minor.json`, so it is a new endpoint and no baseline break. `contracts:check` exit 0. | pass |

Gates on `2c403e3`: `pnpm lint` exit 0; `pnpm typecheck` exit 0; `pnpm test:unit` exit 0 (303 files passed, 1 skipped; 3707 tests passed, 1 skipped);
integration `portal-reads-http`, `portal-tasks-http`, `portal-context-http`, `portal-session-http`, `methodology-footer` exit 0 except the one test fixed in this pass (70 tests; final re-run of `portal-reads-http` 17/17);
`pnpm test:isolation:breakers` exit 0 (24 passed); `pnpm test:isolation` exit 1: 52 passed, 1 failed, `test/isolation/namespacing.spec.ts` ISO-14, "un-namespaced object key construction site(s): src/modules/reports/scheduled-reports.service.ts:234". That file is the e-reports lane's and is not in this branch's diff (`git diff integration/7day..HEAD` touches only portal files, the contract, the openapi document and tests), so it fails identically at fee788e. It is NOT fixed here (outside the lane); e-reports must namespace that key. Every portal, RLS, role and share-token isolation spec passed.
