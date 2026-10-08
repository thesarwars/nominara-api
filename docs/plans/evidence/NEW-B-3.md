# NEW-B-3 evidence — topics read and rename (checkpoint-2 QA note closed)

Commits: RED `12b3619` (tests only; the code was already correct, so the tests characterise it), earlier lane commits for the feature.

CP2 QA passed NEW-B-3 but recorded that no route-metadata test existed: mutations M7 (GET topics to `project:read`) and M9 (`@ProjectParam('id')`
swapped for `@ScopedByQuery` on GET) survived every suite. M9 matters because `TopicsService.list` does no scope check of its own.

New file `src/modules/prompts/topics.controller.spec.ts` pins: GET requires `tracking:read`, GET names `@ProjectParam('id')` and has no `@ScopedByQuery`,
PATCH requires `prompt:write` and has `@ScopedByQuery` and no `@ProjectParam`, PATCH audits `topic.renamed`, operation ids `listTopics`/`renameTopic`.

Proof they bite (mutations run in this worktree, reverted): M7 (GET to `project:read`) fails 1 test; M9 (`@ProjectParam('id')` swapped for `@ScopedByQuery()` on GET) fails 2 tests.

Gates: `pnpm lint` 0, `pnpm typecheck` 0, `pnpm test:unit` 0 (3331 tests).
