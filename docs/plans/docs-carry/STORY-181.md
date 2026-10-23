# STORY-181 — raw capture objects and the signed raw download (carry to the docs repo)

The docs repo has no `.git` here and this change may not edit it, so the edits below are listed for the owner to carry. `docs/references/api-specification.md` (the vendored mirror) is deliberately NOT edited: `test/unit/docs-reference-mirror.spec.ts` requires it to stay byte-identical to the snapshot, so mirror and snapshot change together, in the docs repo.

## 1. Story status — `stories/capture/STORY-181-raw-capture-objects-and-download.md`

`Not started` → **`Done — 5 of 5 ACs`** (api branch `story/181-raw-capture`, not pushed). Tick the five boxes and add this evidence:

| AC | State | Evidence |
|---|---|---|
| 1. Capture gzips the raw answer to `{env}/{ws}/{yyyy}/{mm}/{id}.json.gz`, sets `raw_object_key`; a failed upload fails the step; no row points at a missing object | Met | `src/lib/capture/execute-cell.ts` `writeCell` (upload FIRST, then INSERT with the key; an INSERT that fails afterwards deletes the object best-effort); `src/lib/capture/raw-object.ts` (key + gzip codec); `capture-raw-object.spec.ts` 181-AC1a..g |
| 2. The parser reads the object through `getStored` | Met | `capture-parse.handler.ts` is PHASED (ADR-0003): `prepare` binds the store, `run` reads the object with no transaction and no pooled connection, `commit` parses and writes. 181-AC2a (facts follow the object, not a diverging payload), 181-AC2b (golden: object-read and payload-read facts are identical), 181-AC2c (no idle-in-transaction backend, no checked-out client during the read), 181-AC2d..f (foreign key, missing object, corrupt object: the parse fails and writes nothing) |
| 3. A stated rule for rows that have only `payload` | Met | The rule is in §3 below |
| 4. `GET /results/{id}/raw` is a 302 to a 60-second signed URL; foreign key refused; past retention is the documented error | Met | `raw-download.service.ts`, `results.controller.ts` `raw`; 181-AC4a..f; contract `181-C1/C2` (`contracts-redirect.spec.ts`) |
| 5. Tests against LocalStack for the write, the parse read, the redirect and a foreign key; ISO-14 still passes | Met | `test/integration/capture-raw-object.spec.ts` (LocalStack, S3 only, signature validation on); `pnpm test:isolation` |

## 2. `references/api-specification.md`, Tracking table, `GET /results/{id}/raw` row

Replace the Notes cell with: `302 to a 60-second pre-signed URL (Location header; Cache-Control: no-store; the body is the ordinary envelope with data: null, because @NoEnvelope is reserved for the health probes). 404 not_found when the capture has no stored raw object (captured before raw objects existed, or a reused L1/L2 row); 507 retention_exceeded past the plan's raw-capture retention; a stored key outside the caller's workspace is refused (a security event, 500) and never resolved.` The `GET /results/{id}` paragraph that says the raw text "lives in S3 and is inlined only with `?include=raw`" is not what is built: the document returns `raw_response.text` from `payload` (dual-write, below).

## 3. `references/system-architecture.md` §8 — record the AC3 rule and replace "Nothing uses it yet"

Replace the sentence "**Nothing uses it yet:** `StorageModule` is not imported by any application module, … raw captures stay in `answer_captures.payload` (`raw_object_key` is always NULL) …" with: `TrackingModule` imports `StorageModule` (the raw download); the capture worker writes every captured answer as a raw object (STORY-181); the other items stay as listed.

Add a bullet **"Raw captures: dual write, no backfill (STORY-181 AC3)"**:

- The capture step writes the verbatim answer to `{env}/{ws}/{yyyy}/{mm}/{id}.json.gz` AND keeps the same text in `answer_captures.payload` (dual write). The object is the retained verbatim copy that the parser and the raw download read; `payload` serves the result document, L1/L2 reuse and legacy rows. Slimming `payload` to metadata is a follow-up, not done here: it would put S3 reads behind every drawer open and every reuse.
- **No backfill.** A row with `raw_object_key IS NULL` (captured before this story, or a reused row) is read from `payload` by the parser and by re-parse; the raw download answers `404 not_found` for it. The retention window bounds how long such rows exist (30 to 1095 days by plan).
- Object storage not configured: outside production a capture is written WITHOUT an object (the legacy path, counted as `nominara_capture_raw_objects_total{outcome="storage_unconfigured"}`); in production the capture fails closed (`object storage is not configured`).
- A reused (L1/L2) row never gets its own object and is never pointed at its source's object (the source may be another workspace's shared-cache entry).

Also add to the list of ADR-0003 violators in `api/docs/adr/ADR-0003-phased-tenant-jobs.md`: **`capture.execute`** holds its job transaction across the vendor call (by design, SCANFIX D5) and, with this story, across the raw-object PUT. See "Stopped for the owner" in the builder report: phasing it gives up the cell's advisory lock and the run's `FOR KEY SHARE`.

## 4. Client (`app-fnt-dev-main`), not done in this change

`lib/api/availability.ts` (flip `rawResponse` once the API is merged), `lib/api/prompts.ts` `getRawUrl` (the route is now `302`, no body: the Next.js proxy must call it with `redirect: 'manual'` and return the `Location` header as `{ url }`, otherwise a default `fetch` follows the redirect to S3), `lib/demo/routes/prompts.ts`, `components/prompts/LiveAnswerDrawer.tsx`, `tests/track-a-unserved.test.ts`. After the API merge: `pnpm client:generate && (cd client && pnpm build)` in api, then `pnpm install --offline --frozen-lockfile --force` in the client.

## 5. Known gaps recorded after review round 1 (each needs a named owner story before `RETENTION_PURGE_ENABLED` is turned on)

- **Per-capture raw expiry leaks objects.** `src/workers/rollup/retention.ts` `expireRawCaptures` nulls `raw_object_key` and marks `payload.raw_expired` but does not delete the S3 object; since STORY-181 that key is the only pointer to it. system-architecture.md §8 requires deletion at `retention.raw_captures_days`, which is per plan (30 to 1,095 days) and so cannot be a bucket-wide lifecycle rule. STORY-182 covers only whole-workspace prefix purge. Add per-capture object deletion (a worker-bound `TenantObjectStore.deleteStored`, in an ADR-0003 phase, after commit) to STORY-182's scope. The sweep is off by default (`RETENTION_PURGE_ENABLED`), reachable only through `db:maintenance:sweep`; this is a blocker on enabling it.
- **Orphan objects on a rolled-back cell.** If the `capture.execute` transaction rolls back after `writeCell` returned (`ledgerCost` or the L1 seed throws, or COMMIT fails), the object stays, and the retry mints a new id and so a second object. Bounded to the workspace's own prefix; no row points at a missing object. No lifecycle rule exists yet (STORY-003) and it cannot express per-plan retention. Same owner story as the item above (an orphan scan of `raw/` keys with no row), or an `afterRollback` hook.
- **PUT inside the job transaction (OWNER DECISION PENDING).** §8 says a storage call runs never inside an open transaction. Either amend §8 + ADR-0003 to allow this one bounded PUT (with a timeout on the S3 call), or phase `capture.execute` (PUT first, then a short insert transaction). Not decided here; do not merge on implicit acceptance.
