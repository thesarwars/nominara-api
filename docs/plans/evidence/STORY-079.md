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
