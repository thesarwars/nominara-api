# STORY-079 - Visibility Scan: evidence and status notes

Built on the STORY-078 core (`tool_runs`, `ToolsService.startRun/finishRun`, the shared conversion route). No migration: the story needs no schema change
(0159 was reserved for this stream and is unused). No `task_generation_rules` row: a scan is report-only and generates no task.

## What exists

| Piece | Where |
|---|---|
| Contract (request, estimate, SSE events, stored snapshot, job payload) | `contracts/tools/visibility-scan.schema.ts` |
| `GET /v1/tools/visibility-scan/estimate` (free, paired estimate, NFR-API-11) | `tools.controller.ts` -> `VisibilityScanService.estimate` |
| `POST /v1/tools/visibility-scan` (SSE; `@Streaming()`) | `tools.controller.ts` -> `VisibilityScanService.accept` + `stream` |
| `lookup.execute` worker handler (dedicated interactive pool) | `src/lib/queue/handlers/lookup-execute.handler.ts`, registered in `handlers.ts` |
| Engine-set selection (plan -> engines, no picker) | `src/lib/visibility-scan/engine-set.ts` |
| Fan-out, deadline, cache labelling (pure, ports injected) | `src/lib/visibility-scan/run-scan.ts` |
| Lexicon-only parse + per-engine result + headline | `scan-result.ts`, `scan-aggregate.ts` |
| Per-engine events in the cache (replay on reconnect) | `scan-events.ts` |

## Behaviour worth knowing

- **Flow.** The request validates, checks `X-Nominara-Confirmed-Credits` (absent 400, not 10 -> 409 `price_changed`) and `Idempotency-Key` (absent 400),
  debits 10 credits through `startRun` in the run's own transaction (402 on a short wallet), writes an `tool_run.scan_started` audit row in the same
  transaction, and enqueues `lookup.execute` on the interactive pool AFTER commit. No engine is called in the request (KAD-06).
- **Worker.** Three phases (ADR-0003): `prepare` (short tx), `run` (no tx: probe L1, else capture, parse lexicon-only, publish the engine's event to the
  cache), `commit` (short tx: snapshot + `finishRun`, which settles: nothing captured -> `failed` + full refund; some failed -> `partial`, charged in
  full). Deadline 45 s, per-engine timeout 30 s. A redelivered job skips engines whose event already exists. The last failed attempt settles the run
  failed and refunded (`recover`).
- **Reconnect** is a repeat of the same POST with the same `Idempotency-Key` and body: it attaches to the same run, replays what landed, resumes,
  charges nothing, starts nothing, and gives back the daily allowance the guard consumed. The same key with a different body is 409.
- **Stream.** Polls the event keys (250 ms) and the run row (1 s); always ends with `scan.completed`. If the worker has not settled the run by 55 s the
  stream ends with a `partial` terminal (`deadline_reached: true`) and the charge stands until the worker or the stale-run reaper settles it.
- **Cache age.** The shared L1 envelope gained an optional `capturedAt` (additive, still `v: 1`); `execute-cell.ts` writes it, the probe exposes it. A hit
  WITHOUT a capture time is not served by a scan (it could not be labelled), it falls through to a live capture.
- **Spend ceiling (owner decision 26).** Every vendor call in the scan path is preceded by `SpendMeter.isCeilingReached`; reached -> the engine is not
  called and the failure is `engine_spend_ceiling_reached`; an unreadable meter fails closed. Spend is recorded after the call, as in scheduled capture.
- **Observability.** Spans `tools.scan.accept`, `tools.scan.stream`, `tools.scan.run`; metrics `nominara_tools_scan_requests_total{result}`,
  `_streams_total{outcome}`, `_engine_results_total{outcome,...}`, `_estimates_total`, `_spend_ceiling_blocked_total`, `_enqueue_failed_total`; log
  events `tools.scan.accepted|finished|stream_failed|job_failed` carry `workspace_id` and `run_id` only (asserted: no brand, query, answer or URL).

## Scope signals (files outside the story's Technical Notes)

The story names no files. Edits outside `src/modules/tools` + `contracts/tools`, each small and additive:
`src/lib/capture/l1-exact-hash.ts` + `execute-cell.ts` (optional `capturedAt` in the L1 envelope; `seedSharedCache` exported),
`src/api/interceptors/audit.interceptor.ts` + `src/contracts/discover-routes.ts` (a `@Streaming()` route is exempt from the interceptor and from the
coverage sweep, and audits itself), `src/lib/queue/handlers.ts` (registers the handler), `src/api/streaming/sse-reply.ts` (new, Fastify -> SSE sink).

## Two defects the gates found (kept here so they are not re-introduced)

- **Import cycle.** `ProjectsService` imports the queue handler registry (`handlerFor`); the scan handler needs `ToolsService`, which imports `ProjectsService`. A static import
  closed the loop and Nest read `ProjectsService` as undefined ("can't resolve dependencies of ToolsService") - but only in the processes that loaded the registry first, so the
  integration suite passed and 14 unit files failed. The handler imports `ToolsService` when first used.
- **Cache adapter.** `ValkeyCacheAdapter` is lazily connected with no offline queue, so its first command fails unless `connect()` was called. The handler connects it once before use
  (capture-execute does not; it is rescued by its retry ladder - not changed here).

## Gates (logs in plans-7day/logs/s079-*.log)

Red runs: `s079-red-unit.log` (modules absent), `s079-red-l1.log` (capturedAt), `s079-red-audit.log` (streaming exemption, coverage sweep), `s079-red-guards.log` (rate-limit class).
The integration spec was written after the route existed (it needs the route); its first runs were red for the DI cycle above, the missing audit exemption, and test isolation
(a live capture seeds the shared L1 cache by design, so each scan in the spec uses a fresh query).

## Review round 1 (head 0f3c3250 -> this commit)

Fixed: `no_shared_cache` honoured (read and seed); redirect-wrapper citations no longer reported as foreign/owned (null, with the engine's hostname title as a hint); headline sentiment uses the
parser's `labelFor`; the stream's deadline terminal is provisional (`settled: false`, null credits); the idempotency claim is 24 h, never deleted after a charged start, split on the first colon,
`IdempotencyConflictError`, reserved-prefix refusal; per-workspace `usage_ledger` cost rows (source `lookup`); detected competitors survive a redelivery.
New tests: unit `visibility-scan.spec.ts` (sentiment band, Gemini recorded payload) and `visibility-scan.service.spec.ts` (claim, 24 h window, claim-write failure, stream deadline); integration
`visibility-scan.spec.ts` (no_shared_cache, usage_ledger, mid-run drop and reattach, 20 same-key and 20 different-key concurrent POSTs) and `visibility-scan-rate-limit.spec.ts` (third immediate scan is 429 on the
shipped defaults - its own file, because the main spec installs a widened document and the guard memoises its config for 15 s).
Red runs: `s079-r1-red-unit.log` (11 failing), `s079-r1-red-int.log` (4 failing on the pre-fix source; the same-key concurrency and the rate-limit test passed on the old code - they pin behaviour that already held).
Not done, raised for the owner (see docs-carry 9, 10, 12, 14): a DB-level idempotency key, the reconnect-at-daily-cap case, the scoring constants, the streaming audit exemption.

Also found by the new concurrency test (it hung on the pre-fix source, `s079-r1-red-int.log`): **pool starvation.** `start` resolved entitlements, and `ToolsService.startRun` resolved them again, each
opening a second pooled connection while the request's transaction held the first; 19 simultaneous scans needed 2x19 connections from a pool of 20 and every request waited forever. Entitlements are now
resolved before a connection is taken and passed to `startRun` (`StartToolRunInput.entitlements`); the worker reads the shared-cache flag from the signed payload instead of resolving it.
Also found: the integration spec's worker held its OWN Valkey connection while the app (under the test runner) uses a per-process in-memory cache, so per-engine events never reached the stream and the
stream was only ever fed by the final snapshot; the spec now shares one cache between app and worker, which is what makes the mid-run reconnect test meaningful.

Final gates on head after this round (logs `plans-7day/logs/s079-r1-*.log`): lint EXIT=0, typecheck EXIT=0, contracts:check EXIT=0, test:unit 6364 passed (one unrelated 5 s timeout in
`contracts-worked-example` under load, rerun alone EXIT=0), visibility-scan + rate-limit + tool-runs-core + queue-interactive-pool integration 78/78, test:isolation 55/55, imagebuild EXIT=0, full
test:integration 4719 passed / 1 failed: `seed-demo.spec.ts` (date-dependent default-partition constraint in `src/workers/rollup/maintenance.ts`; fixed by b9a0c265 on `fix/partition-default-rows`, not on main; no file in this diff touches it).
