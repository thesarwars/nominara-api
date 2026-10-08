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
- `pnpm test:integration` for `source-presence-verify.spec.ts` and `worker-group-bootstrap.spec.ts`: **NOT RUN** — `df -h /System/Volumes/Data` showed 6.1 GiB free (< the 8 GiB testcontainers floor). They type-check and lint clean. They must be run by the merge step or NEW-A-17 once disk is freed.
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
