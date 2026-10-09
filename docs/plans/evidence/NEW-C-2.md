# NEW-C-2 — track/untrack a competitor: owner decision (8), milestone kind `competitor_removed` (lane c-comp)

Branch 7day/c-comp-3. Migration **0098_milestone_competitor_removed** (range 0098-0099). Spans DEFERRED to week 2 (decision R3).

## Acceptance criteria (track-plans.json) and this change

- Contract, over-cap 403, soft delete + `@Audit`/`project:update`, zero credits, re-tag in one transaction: unchanged and green in
  `test/integration/competitor-track.spec.ts` (18 tests, exit 0), including "FR-CO-02 — over the cap: entitlement_exceeded with {key, limit, current}, and nothing written".
- Scenarios 5 and 6, add and remove each insert a milestone: "STORY-092 #5 — adding a competitor inserts a competitor_added
  milestone" and "STORY-092 #6 — removing a competitor ... inserts a competitor_removed milestone (owner decision 8)". Removal now
  carries `competitor_removed`, not `competitor_added` with a "removed" title.
- Migration `test/integration/milestone-competitor-removed-migration.spec.ts`: MS-1 kind accepted; MS-2 the nine earlier kinds
  still accepted and an unknown kind rejected; MS-3 down turns a `competitor_removed` row back to `competitor_added` (row kept) and
  then rejects the new kind; MS-4 re-applies cleanly. The rollback loop undoes migrations until 0098 itself, so it does not depend on later migration numbers.

## RED
Commit `364105d`, `pnpm exec vitest run --config vitest.integration.config.ts` on three files: **5 failed / 35 passed, exit 1**.
Migration tests failed with check violation `milestones_kind_check` (kind missing) and "expected null not to be null" (no 0098 to roll back); the
removal test failed `expected 'competitor_added' to be 'competitor_removed'`. Implementation `768893f`: 40/40, exit 0.

## Gates (HEAD 768893f, against a scratch pgvector container, never the user's DB)
`db:migrate` 0 · `db:rls-check` 0 · `db:schema-check` 0 · `db:drift-check` 0 · `db:rls-generate --check` 0 · `db:schema-generate --check` 0
(milestones was already a tenant table; no RLS change, no generated file changed) · `pnpm lint` 0 · `pnpm typecheck` 0 ·
`pnpm test:unit` 0 (includes `additive-guard.spec.ts`) · `pnpm contracts:check` 0. `test:isolation` not run: no tenant table or policy
changed, and it crashes at this tip in fixture setup (support_grants TTL, d-admin lane).

## Docs to carry to the docs repo (no .git here; not edited)
The reference says nine milestone kinds. It now has ten: add `competitor_removed` to `schemas/sources-and-rollups.md` (the CHECK list at
line ~133 and the "three of the nine" sentence at line ~158, which becomes four of ten), `references/scoring-models.md` line ~475 (kind table,
a removal of a tracked competitor, changes the share-of-voice denominator), and `schemas/projects-and-prompts.md` line ~151 ("emits a
`competitor_added` or `competitor_removed` milestone"). The frontend's milestone marker styling should treat the new kind as a low-emphasis methodological marker.
