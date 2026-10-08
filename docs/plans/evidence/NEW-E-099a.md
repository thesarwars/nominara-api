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
