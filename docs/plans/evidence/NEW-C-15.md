# NEW-C-15 evidence — brand-presence verification by fetching the cited URL

Branch `7day/c-geo-3`. RED commit `db1c59a`; implementation commit `0026f14`.
No endpoint, no migration (uses NEW-C-4's `verified_at`, migration 0044), no frontend change, no new dependency.

## RED proof (commit db1c59a, before any implementation)

- `pnpm vitest run test/unit/sources/verify-presence.spec.ts`: **exit 1**, "Test Files 1 failed (1) / Tests no tests" — the import of `src/lib/sources/verify-presence.ts` could not resolve (module absent), the stated reason.
- `pnpm vitest run test/unit/queue`: **5 failed | 157 passed** (group crawl membership, group partition, topology additions, topology group counts, handler registry) — the queue `source.verify_presence` was absent from the topology and registry.
- `test/integration/source-presence-verify.spec.ts` was committed in the RED commit but **could not be run** (see "Not run").

## Acceptance criteria

1. **A queue job fetches the top URL per domain through the guarded fetcher and matches it against the brand alias automaton; cached 30 days, so a second run inside the window does not fetch again.**
   - Queue `source.verify_presence` (crawl group, tenant-scoped, signed payload) + `src/lib/queue/handlers/source-verify-presence.handler.ts`; default fetcher is `guardedFetch` (no other network path in the file). Matching uses `matchEntities` (the Aho-Corasick automaton with word boundaries, negative aliases and link exclusion) over the page's visible text.
   - `test/unit/sources/verify-presence.spec.ts`: "STORY-054 scenario 5: the brand is on the fetched page, so presence is recorded true", "...an alias (not the display name) also counts", "STORY-054 scenario 6: ... a negative alias suppresses the match", "...a word boundary is required (Acmeville is not Acme)", "...a brand that appears only inside a link target or script is not a mention".
   - Cache: "STORY-054 scenario 7: a domain verified inside the window is NOT fetched again", "...one millisecond inside thirty days is still cached", "...at exactly thirty days the cache has expired and the domain is fetched again", "is thirty days".
   - DB-level (integration, written, not run): "STORY-054 scenario 7: a second run inside the 30-day window does not fetch again", "...after the window the domain is fetched again".
2. **Records present or absent with verified_at; a fetch failure stays null.**
   - Unit: "STORY-054 AC4: a 404 is a FAILED fetch (null), never an asserted absence", 500, network error, "STORY-054 AC11: a refusal from the guarded fetcher is a failed fetch carrying only the refusal reason", non-text (PDF), no usable alias (never fetches). Empty 200 page is absent.
   - Integration (not run): scenario 5 writes true + `verified_at` on every index row of the domain; scenario 6 writes verified false and gap_severity becomes critical (recomputed through `refreshProjectSourceIndex`, which carries verified presence); "a fetch failure stays null ... writes no verified_at"; "a failed re-check does not erase an earlier verified value"; idempotent re-run; tenant isolation under `SET ROLE nominara_app` (another workspace gets null and nothing is fetched).
3. **Demo `.example` domains always stay unverified; only Gemini's real citations verify.**
   - `isDemoDomain` / `selectPresenceChecks`: unit "a demo .example domain is never fetched, even when unverified", the `isDemoDomain` table (incl. `example.com`, `myexample.org` are not demo).
   - Candidates come only from index rows of `LIVE_CITATION_ENGINES = ["gemini"]`. Integration (not run): "a demo .example domain is never fetched and stays unverified (null)", "a real-looking domain cited only by a demo engine is not fetched".
4. **Cut candidate number 2.** Built, not cut.

## Mutation checks (unit, restored after each)
- cache comparison `<` -> `<=`: 1 test fails. 404 mapped to "absent": 2 fail. `.example` suffix test loosened to `example`: 1 fails. `<script>` stripping removed: 1 fails. Cache check disabled: 2 fail.

## Gates (worktree api-wt-c3)
- `pnpm test:unit`: exit 0, 279 files passed / 1 skipped, 3355 passed / 1 skipped.
- `pnpm lint`: exit 0. `pnpm typecheck`: exit 0.
- `pnpm test:integration test/integration/source-presence-verify.spec.ts test/integration/worker-group-bootstrap.spec.ts` (colima DOCKER_HOST, 14 GiB free): **exit 0**, 2 files / 27 tests passed. This supersedes the earlier "not run" notes above; every integration test named under the acceptance criteria now has a passing run.
- `test:isolation`: not run (no tenant table touched; tenant isolation asserted in the integration spec under `nominara_app`).

## Observability
- Metric: `nominara_sources_presence_checks_total{outcome=present|absent|failed|skipped_demo|skipped_cached|skipped_no_url, reason}` (verified in code only; no assertion on the counter yet).
- Log: `source_presence_verified` carries workspace ID, project ID and counts only — never the brand name, URL or page text.
- OpenTelemetry span: DEFERRED to week 2 by owner decision (3); a missing span is not a failed criterion this week.

## Decisions and open items
- **New queue `source.verify_presence`** is not in system-architecture.md §4. Added by the precedent of `audit.verify` and `identity.sweep_unverified` (topology.spec.ts `ADDED_BEYOND_REFERENCE` records the reason). §4 needs a row in the docs repo.
- **Producer not wired.** Nothing enqueues `source.verify_presence` yet: a worker handler cannot enqueue after commit, and no per-project scheduler exists (NEW-A-13 sweep). The handler is live and tested; an owner/planner decision is needed on the trigger (after `rollup.metric_daily`, or the capture sweep). Until then no verification runs in a deployed system.
- The handler holds the job transaction while it fetches (same shape as `crawl.audit`/`crawl.discover`); bounded to 25 domains per run, each fetch to the guarded fetcher's 20 s timeout.
- Evidence needing a real API and real Gemini citations (an actual domain fetched end to end) is collected in NEW-A-17.

## Audit fixes (checkpoint-2 audit, finding 4)
- `isDemoDomain` now matches the RFC 2606 names: `example`, `test`, `invalid`, `localhost` TLDs and `example.com`/`example.net`/`example.org` with every subdomain (the seed writes `<name>.example.com`). Lookalikes (`notexample.com`, `example.com.evil.io`, `example.io`) stay real. RED a8d867a: `test/unit/sources/verify-presence.spec.ts` "isDemoDomain", exit 1, 10 failed / 33 passed. Fixtures that used `reviews.test` as a "real" domain now use `reviews.dev` (`.test` is reserved).
- Candidates exclude demo-marked captures: a domain qualifies only through a `citation_facts` row on a live engine whose capture is not `normalizer_version = 'demo-seed'` (a citation with no capture row still counts, as in the existing fixtures).
- Producer wired: `rollup.metric_daily` enqueues `source.verify_presence` through `afterCommit` (key `srcver:{project}:{local day}`, the topology's own pattern); enqueue failure is logged and counted, never thrown; skipped when there is no ambient tenant transaction (direct calls in tests). Metrics `nominara_sources_presence_requested_total`, `nominara_sources_presence_request_failed_total`; log lines carry `workspace_id` and `project_id` only. Spans deferred to week 2.
- Tests written (4e808c1): `source-presence-verify.spec.ts` "NEW-C-15 audit: a demo `<name>.example.com` domain ...", "... cited ONLY by a demo-marked capture ...", "... demo-marked capture AND a real live capture is still verified", and the producer block (enqueue once after commit with the key; rollback enqueues nothing; failing enqueue does not fail the rollup; gone project enqueues nothing); `seed-demo.spec.ts` "NEW-C-15 audit · seed, then verify".
- Disk gate: before these integration specs could run, free space on /System/Volumes/Data fell from 9.3 GiB to 3 GiB (other lanes' containers; this lane ran isolation x2 and one integration file earlier). Per the hard rule (under 8 GiB: stop and report) the integration specs above were NOT RUN, so their RED state and green state are both unobserved. The implementation (34bc60a) is covered by: `pnpm lint` 0, `pnpm typecheck` 0, `pnpm test:unit` 0 (279 files, 3369 tests passed, 1 skipped). To do before merge: run `test/integration/source-presence-verify.spec.ts` and `test/integration/seed-demo.spec.ts`, plus a RED check by stashing 34bc60a's `src/` changes.

## Audit-fix integration runs (supersedes the "NOT RUN" disk-gate note above; 20 GiB free on 2026-10-08)
- RED for 34bc60a, observed: with `src/` restored to 4e808c1 (pre-fix), `pnpm test:integration test/integration/source-presence-verify.spec.ts` -> **exit 1, 4 failed | 14 passed (18)**. `src/` then restored to 34bc60a.
- GREEN with 34bc60a: `pnpm test:integration test/integration/source-presence-verify.spec.ts test/integration/seed-demo.spec.ts` -> **exit 0**, 4 files / 136 tests passed (the runner's file filter also picked up two further specs, all green).
- Acceptance criteria 1-3 are therefore proven at unit and integration level; criterion 4 is "built, not cut". An end-to-end fetch of a real Gemini-cited domain needs a running real API and is collected in NEW-A-17.

## Checkpoint-3 fix (branch 7day/c-src-4, base integration/7day fee788e)

Failure: `test/integration/seed-demo.spec.ts` "NEW-C-15 audit · seed, then verify" asserted the seed itself indexed a live (Gemini) engine. NEW-A-8 keeps Gemini real (`excludeEngines`), so the seed writes no Gemini citations and the index held only `all`. RED at base: `AssertionError: the seed indexed a live engine's citations ... expected [ 'all' ] to include 'gemini'` (1 failed, 38 skipped, run of `-t "NEW-C-15 audit"`).

Fix (a61a7e0, test only, no production change): the test now plays the live adapter as setup, as the NEW-A-8 tests do. After the seed it inserts one REAL Gemini capture per project (`insertRealGeminiCapture`, normalizer_version not `demo-seed`) with `citation_facts` on the competitor demo domains the seed fabricated (`<name>.example.com`), then rebuilds the source index (`refreshProjectSourceIndex`). The same two assertions remain unchanged in strength: gemini is indexed (non-vacuous) and `verifyProjectSourcePresence` fetches nothing and stamps no `verified_at`. Setup cites only `.example.com` domains because the seed's other domains are real-looking (hubspot.com): a real Gemini citation of one is rightly fetchable, so it is not the property under test. The fetch assertion now compares the called URLs with `[]` so a failure names them.

| Criterion | Test |
|---|---|
| Seeded demo domains are never fetched, even when a live engine cites them | seed-demo.spec.ts "NEW-C-15 audit · seed, then verify: no seeded domain is fetched and no index row carries a verified absence" |
| No verified_at / verified absence on fabricated data | same test, `stamped` rowCount 0 |

Mutation: `isDemoDomain` forced to `return false` -> that test fails ("a demo domain is never fetched: expected [ ...(8) ] to equal []"); restored.

Gates: seed-demo + source-presence-verify + aux-reads-and-actions + rendering-quality integration (`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run --config vitest.integration.config.ts aux-reads rendering-quality source-presence-verify seed-demo`): exit 0, 4 files / 76 tests passed. lint 0, typecheck 0, test:unit 0 (302 files / 3703 tests passed, 1 skipped). One earlier unit run timed out `test/unit/audit-coverage.spec.ts` at 5 s under machine load; it passed alone and in the next full run (not touched by this change).
