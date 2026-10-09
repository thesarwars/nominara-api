# NEW-E-7 (checkpoint-6): cursor envelope on listAgencyThemes, listScheduledReports, listShareTokens, listShareTokenViews

Decision: owner 2026-10-09 pm #3 (paginate all bare lists; one breaking-changes.json entry each). listProjectGoals is a different lane's and is NOT in this change.

Commits: RED (integration + published-contract tests, all four failing: bare array, no `pagination`), contract query schemas, implementation (below).
RED run: `vitest run -c vitest.integration.config.ts agency-theme-http scheduled-reports-http share-tokens-http` exit 1, 10 new tests failed for the stated reason (no `pagination` member, offset/malformed cursor answered 200), 39 existing passed; test/unit/pagination-published-contract.spec.ts 4 new cases failed.

## What changed
- Query schemas = `paginationRequestSchema` (strict, so an `offset` is 400); routes carry `listOf: true`; `contracts/openapi.generated.json` regenerated (`contracts:check` clean).
- Keyset rules as listApiKeys: microsecond-precision cursor key (a millisecond key skips rows sharing a millisecond), `limit + 1` fetch, `pageFrom`, a foreign or malformed cursor is a 400 `validation_failed`, never a silent first page. Shared decoder: src/api/pagination/timestamp-id-cursor.ts.
  - listShareTokens, listScheduledReports: (created_at DESC, id DESC). The share-token list keeps its scope predicate (a scoped manager sees only tokens inside scope; an unrestricted one carries no predicate). Scheduled-report deliveries are loaded for the page's reports only.
  - listShareTokenViews: (viewed_at DESC, id DESC); the old hard LIMIT 500 is removed (every view is reachable). Null telemetry stays null.
  - listAgencyThemes: (is_default DESC, created_at, id), cursor key [is_default 1/0, created_at micros, id]; the unsaved platform default is still the single item of an empty workspace's first page.
- breaking-changes.json: four entries 2026-10-09-{themes,scheduled-reports,share-tokens,share-token-views}-cursor-envelope (stories STORY-097/100/098/098, as the waiver schema requires a STORY id).

## Tests (each pages at limit=2 over 5 rows sharing one created_at/viewed_at, so the page boundary falls inside a tie)
- agency-theme-http: tie walk equals `ORDER BY is_default DESC, created_at, id`; platform-default page; bad cursor/offset 400.
- scheduled-reports-http: tie walk, deliveries ride on own report; empty page; bad cursor/offset.
- share-tokens-http: tie walk; scoped manager's pages; empty; bad cursor; views tie walk with null telemetry; views empty, bad cursor, 404 unknown token.
- Existing callers (unit and rls specs) updated to the Page return; no assertion relaxed.

## Gates
lint, typecheck exit 0; test:unit 3848 passed, 1 failed: pagination-published-contract "every GET whose data is an array" now lists only `listProjectGoals` (another lane's list, was in the same failure before this change). Integration (agency-theme*, scheduled-report*, share-token*, report-export-http): 10 files, 103 tests passed. test:isolation: 12 files, 55 passed (the ISO-13 scanner flagged an interpolated SQL fragment named like a cache key; fixed by writing the two statements out).
Observability: unchanged (lists add no new metric; no log carries a name or cursor).
