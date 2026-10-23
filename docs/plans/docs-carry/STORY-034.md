# STORY-034 — results cursor list, re-parse with a saved diff, retention failure (carry to the docs repo)

The docs repo has no `.git` here and this change may not edit it. `docs/references/api-specification.md` (the vendored mirror) is NOT edited, because `test/unit/docs-reference-mirror.spec.ts` requires byte-equality with the snapshot; mirror and snapshot change together in the docs repo.

## 1. Story status — `stories/capture/STORY-034-run-lifecycle-api-and-progress.md`

`Partial — 10 of 13 ACs` → **`Done — 13 of 13 ACs`** (api branch `story/034-run-lifecycle`, stacked on `story/181-raw-capture`, not pushed). Tick AC7, AC9 and AC10, drop their "BLOCKED" tags, and replace the 2026-10-12 table rows:

| AC | State | Evidence |
|---|---|---|
| 7. Cursor list, full document, signed raw redirect | Met | list: `results-list.service.ts` / `results-list.controller.ts` (`GET /projects/{id}/results`), `tracking-results-reparse.spec.ts` 034-AC7a..i; document: unchanged; raw: STORY-181 AC4 |
| 9. Re-parse with a before/after diff, charges nothing | Met | `reparse.service.ts`, `POST /results/{id}/reparse`; 034-AC9a..m (diff, facts SAVED, free = no ledger/wallet row, date marked dirty after commit, scope 403, 404, 422, 507, recorded citation resolutions reused with no network call, concurrent re-parses serialised); route properties `reparse-route.spec.ts` 034-RT1..4 |
| 10. Past retention: the retention failure, not an empty result | Met | list (`from` before the boundary), document (`GET /results/{id}`), re-parse and raw: 507 `retention_exceeded`; 034-AC10a..e, 181-AC4c..e |

## 2. `references/api-specification.md`, Tracking table

- `GET /projects/{id}/results` — Notes: `cursor over answer_captures, newest first on (captured_at, id). Filters: engine_key, prompt_id, run_id, status, from, to. A from before the plan's raw-capture retention is 507 retention_exceeded; with no from the list opens at the retention boundary. A failed or blocked cell is listed with its error_code and a null brand_present.`
- NEW row: `POST` `/results/{id}/reparse` ✚ — `tracking:trigger` — `re-runs the parser on the stored capture, SAVES the corrected facts, marks the capture's workspace-local date dirty for the rollup, charges 0 credits, audited (result.reparsed). Requires Idempotency-Key; no body. Returns { result_id, scoring_version, changed, credits_charged: 0, before, after }, each snapshot being the capture's figures plus one entry per entity. 404 / 403 project_out_of_scope / 422 precondition_unmet (a cell that was not captured, a refusal, or a reused row with no text of its own) / 507 retention_exceeded.`
- `GET /results/{id}` — add `507 retention_exceeded` past retention.

## 3. `references/tracking-engine.md` §8 and `system-architecture.md` §3 (AdminModule)

§8 names `POST /admin/results/{id}/reparse` (internal) and system-architecture puts re-parse under AdminModule, while product-spec FR-PA-08, page-inventory and ui-ux-guidelines §10 put a customer "Re-parse, free" button in the drawer. **Owner decision 2026-10-23: the customer route, permission-gated.** Add one sentence to §8: "The customer route is `POST /results/{id}/reparse`; the admin route is the bulk form and is built later." Remove "re-parse" from the AdminModule row until the bulk route exists.

## 4. Decisions taken (flagged for the owner)

1. **Permission is `tracking:trigger`.** The owner's wording was "owners and admins". The matrix has no owner/admin-only tracking permission, so a scoped `manager` (who already holds `tracking:trigger`) can also re-parse inside their scope. Strictly owner/admin needs either a new permission in `security-and-tenancy.md` (a vocabulary change, not made here) or `workspace:update` (semantically wrong).
2. **The request path reads `payload.text`, not the S3 object.** Reading S3 in the handler would hold the request's tenant transaction (opened by the interceptor, not the handler) across storage I/O, which NFR-ARCH-04 forbids. STORY-181 dual-writes, so `payload` holds the same text; the capture worker's parse reads the object. AC9's phrase "from the stored raw object" is therefore met by the retained copy, not literally by an S3 read.
3. **Citations are not re-fetched.** A re-parse reuses each citation's recorded resolution (status, final URL, `resolved_at`); a URL the improved extractor finds that was never resolved is stored unresolved (`http_status` NULL, excluded from share), exactly like any unresolved citation. Fetching a citation's host from a request handler is what KAD-06 bans.
4. **The dirty mark includes the open day.** `markDateDirtyIfLate` (STORY-042) skips today because every run enqueues its own rollup; a re-parse rewrites today's figures with no run behind it, so `markDateDirty` marks any date.
5. **`capture.parse` now takes a row lock** (`SELECT … FOR UPDATE` on the capture) so a re-parse and a worker parse of one capture cannot interleave their delete-then-insert.
6. **The audit row records the outcome only** (`result_id`, `scoring_version`, `changed`, `credits_charged`), not the diff: the default would store entity labels in the append-only log.
7. **`StorageModule` is imported by `TrackingModule` and `QUEUE_PRODUCER_CONNECTION` is exported** from `QueueProducerModule` (the API's one non-job write to the queue instance is the `rollup_dirty` mark).
8. **Review round 1, still for the owner.** (a) Decision 1 contradicts the owner's 2026-10-23 wording and needs explicit confirmation (or an owner/admin permission through the matrix); the route is also unthrottled (each new Idempotency-Key runs a full parse inside the request transaction), so consider a per-workspace limit. (b) Decision 2 needs ratifying and recording in AC9's text and system-architecture.md §8. **The "slim `payload`" follow-up recorded in STORY-181 depends on moving re-parse to an object read first** (a phased request, or a job with a result poll); done the other way round, every re-parse becomes a 422. (c) Known edge, not changed: re-parsing a row still in `captured` before its `capture.parse` commits makes the worker take the L3 short-circuit, so that parse never reaches the alert meters (STORY-037/038/039). It needs a user acting within seconds of capture; the story's test 034-AC9a treats `captured` as re-parseable, so refusing it is a spec decision, not a fix.
9. **Files outside the plan's `files_touched`** (justified, disclosed): `src/lib/rollup/dirty-dates.ts`, `src/lib/queue/queue-producer.module.ts` (034); `src/api/decorators/api-contract.decorator.ts`, `src/contracts/generate.ts` (181, redirect contracts). List them in the story's Technical Notes when this carry lands.

## 5. Client (`app-fnt-dev-main`), not done in this change

`lib/api/availability.ts` (drop `reparse`, serve it), `lib/api/prompts.ts` (`reparseResult` now returns the generated `ReparseResponse`: `{ result_id, scoring_version, changed, credits_charged, before, after }` with `before`/`after` snapshots, which differs from the guessed `ReparseDiff` in `lib/api/pending.ts`), `lib/demo/routes/prompts.ts`, `components/prompts/LiveAnswerDrawer.tsx` (render the diff; hide the button for roles without `tracking:trigger`), `tests/track-a-unserved.test.ts`. The cursor list has no client caller yet. Rebuild the client copy after the API merge: `pnpm client:generate && (cd client && pnpm build)`, then `pnpm install --offline --frozen-lockfile --force` in the client worktree.
