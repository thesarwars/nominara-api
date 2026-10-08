# NEW-A-14 — analytics query alignment (engines on growth-map)

Branch 7day/a-gemini-3. Commits: contract 9225a41, RED f4176b0, implementation c2a500b.
Migrations: none. Tracing: metrics/log only this week; OpenTelemetry spans are deferred to week 2 (owner decision), so no span is claimed.

## RED
Commit f4176b0. `pnpm vitest run test/unit/analytics/engine-filter.spec.ts` exit 1, "no tests" (4 tests unrun): the failure is the missing module `src/lib/analytics/engine-filter.ts`. The three new cases in test/integration/growth-map.spec.ts were committed in the same RED commit; they are NOT run (see AC2).

## Acceptance criteria
1. Contract first: growthMapQuerySchema gains `engines` (comma list or `all`, narrowing only). Landed alone in 9225a41 (`contracts/analytics/growth-map-response.schema.ts`, `engineFilterSchema`; `all` beside a key and empty tokens are 400; `.strict()` kept so `topics` is still a 400). Proven by test/unit/analytics/engine-filter.spec.ts: "NEW-A-14 AC1 — the growth-map query accepts engines...", "...stays strict...", "...absent and `all` mean no narrowing...". openapi regenerated: no diff (query params are not in the generated document).
2. engines=gemini returns only gemini series; unentitled engine narrows to nothing, never widens.
   - Unit (run, green): "NEW-A-14 AC2 — narrowing keeps only entitled engines and never widens".
   - Integration, test/integration/growth-map.spec.ts: "NEW-A-14 AC2 — engines=chatgpt plots only chatgpt's measurements and lists only chatgpt", "...engines=all is the unfiltered payload", "...an engine the project is not entitled to narrows to nothing and never widens". **NOT RUN**: free space on /System/Volumes/Data is 7.4 GiB (< 8 GiB rule), so testcontainers was not started. They typecheck and lint clean. They must be run on a host with space (merge step). The SQL (`narrowedSeriesRows`, per-engine rows blended with the rollup's own project_engines weights, restricted to the entitled set from project_entitled_engines) is therefore unverified against Postgres. Tenant isolation: all reads go through the ambient tenant transaction; no tables or policies changed.
   - Note: the test engine used is chatgpt (the fixture's seeded engines); the gemini name in the story is an example of any entitled key.
3. In api mode, an engine filter on Overview, Matrix or Growth Map never yields a 400. API side done: growth-map accepts engines (list or all); scorecards already accepted engines and now also treats `all` as no filter (previously it narrowed to nothing). The FRONTEND half is NOT done in this lane (outside api worktree): app lib/api/analytics.ts must stop sending `topics` to scorecards and growth-map (both schemas are .strict(), so it is a 400) and hide the topic filter until STORY-047. Matrix: this API has no /matrix route yet, so that screen cannot be exercised here. Real-API verification belongs to NEW-A-17.

## Gates (in api-wt-a1)
- pnpm lint: exit 0
- pnpm typecheck: exit 0
- pnpm test:unit: exit 0 (278 files passed, 1 skipped; 3317 tests passed)
- pnpm test:integration (growth-map spec): not run, disk under 8 GiB
- pnpm test:isolation: not run; no tenant table touched
