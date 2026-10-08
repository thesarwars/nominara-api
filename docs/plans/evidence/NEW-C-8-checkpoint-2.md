# NEW-C-8 checkpoint-2 fix — evidence

Lane 7day/c-src-3, base integration/7day f201f35. Fix commit: 0aaed51.

## The finding
CP2 QA failed NEW-C-8 on one criterion: test/integration/aux-catalog-crawler-access-migration.spec.ts AC3.13, AC3.14 and AC3.15
called rollbackLast() and asserted it returned 0070_aux_catalog_crawler_access. Later lane merges added 0081/0085/0086, so the newest
migration is no longer 0070 and the 0070 rollback, idempotency and seed-takeover tests were red on the merged tree.

## RED (the finding, reproduced)
There is no separate RED commit: the failing state is the unchanged spec at f201f35, which is the fix commit's parent.
Reproduced in api-wt-c2 at f201f35, real Postgres 18 (testcontainers, pgvector/pgvector:pg18):

    pnpm vitest run --config vitest.integration.config.ts test/integration/aux-catalog-crawler-access-migration.spec.ts
    exit 1 — Tests 3 failed | 5 passed (8)
    AC3.13, AC3.14, AC3.15: expected '0086_support_grants_ttl_ceiling_valid…' to be '0070_aux_catalog_crawler_access'

That is the reason QA stated, so the test fails for the stated reason.

## Fix
A local helper rollbackTo0070() rolls back migration by migration until it returns 0070_aux_catalog_crawler_access and fails if 0070
is never reached. Nothing the tests assert was changed. Assertions are byte-identical; only the three rollbackLast() preambles changed.

## Criteria
| Criterion | Proof | Result |
|---|---|---|
| NEW-C-8 AC3.13 demo seed AUX-R-001 row is taken over (ON CONFLICT DO UPDATE) | aux-catalog-crawler-access-migration.spec.ts, "NEW-C-8 AC3.13 ..." | pass |
| NEW-C-8 AC3.14 re-running the up migration is idempotent | same file, "NEW-C-8 AC3.14 ..." | pass |
| NEW-C-8 AC3.15 down removes unreferenced rows, never one an aux_finding references | same file, "NEW-C-8 AC3.15 ..." | pass |
| AC3.8-AC3.12 (rows, loader, rule_version, thresholds, customer text) | same file, unchanged, 5 tests | pass |
| AC1 RED first (site-file evaluators) and AC2/AC3 evaluators and weight assertion | unchanged from CP2 QA, which passed them (88c8377 RED before 4aba738) | not re-run beyond unit gate |

After the fix: 8 passed (8), exit 0.

## Mutations (against the executed migration SQL, restored afterwards with git checkout)
- down.sql: NOT EXISTS (aux_findings) guard removed: AC3.15 fails (1 failed, 7 passed, exit 1).
- up.sql: rule_version = EXCLUDED.rule_version replaced by the existing value: AC3.13 fails (1 failed, 7 passed, exit 1).
(An earlier syntax-breaking mutation made all 8 fail and was discarded as proving nothing.)

## CP2 c-src audit changes (verdict approve_with_changes, no serious findings)
Closed in this change:
- No test pinned the aux:read permission on the sources routes: test/unit/sources/sources-controller-permission.spec.ts, CP2-C-SRC-1 and
  CP2-C-SRC-2. Mutating the decorator to another permission fails both (2 failed, exit 1).
- playbook-templates.ts comment said templates were keyed by seeding_playbook_slug; lookup is by source_class. Comment corrected.

Still open and not built, each needing a decision or a story (not decided here):
- source_domains.source_class / is_seedable is last-writer-wins across projects; the fix is a schema change the story did not name (migrations 0070-0071 unused by it; note 0070 is taken by NEW-C-8 in this lane's history, so any new number must come from 0100-0101).
- Window bounds use the session TimeZone and span N+1 days; bucketing by workspace timezone changes scoring and needs a decision on the bounds.
- Source-index refresh as its own job changes the queue design; needs a story.
- Unverified domains keep NULL coverage: owner decision 9 confirms the code's conservative NULL rule, so nothing to change. Platform rule text is still not supplied by the owner.

## Gates (api-wt-c2)
- pnpm lint: exit 0
- pnpm typecheck: exit 0
- pnpm test:unit: exit 0, 278 files passed + 1 skipped, 3315 tests passed + 1 skipped (was 3313 at f201f35, +2 new)
- aux-catalog-crawler-access-migration integration spec: exit 0, 8/8
- test:isolation: not applicable (0070 is a data-only insert into the global aux_rule_catalog, no tenant table). Not run: known fixture crash at this tip.
- Full pnpm test:integration was not run in this item; only the one spec touched.
- OpenTelemetry spans: deferred to week 2 per owner decision; no span is claimed.
- Evidence needing a running real API: collected in NEW-A-17.
