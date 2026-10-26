# STORY-031 — the engine limits wired into the live capture path (carry to the docs repo)

The docs repo has no `.git` here and this change may not edit it. `docs/references/api-specification.md` (the vendored mirror)
is NOT edited, because `test/unit/docs-reference-mirror.spec.ts` requires byte-equality with the snapshot; mirror and snapshot
change together in the docs repo. Branch `story/031-engine-limits` (api), not pushed.

## 1. Story status — `stories/capture/STORY-031-rate-limiting-circuit-breaking-engine-health.md`

`Partial — 3 of 11 ACs` → **`Partial — 9 of 11 ACs`**. Replace the 2026-10-12 rows:

| AC | State | Evidence |
|---|---|---|
| 1. Lease per engine, re-delay not fail | Met (unchanged) | `engine-lease.ts`; plus the stage-2 halved bucket (`refillReduction`) |
| 2. Per-target-host crawl limit | **Partial (unchanged)** | `HostRateLimiter` still has no crawl caller — not in this stream (capture path only) |
| 3. Breaker per engine, thresholds, half-open | Met | `capture-engine-gate.ts` (`admit` before every vendor call, `record` after every attempt), `capture-execute.handler.ts` run phase; ratio-open → `EngineRedelayError` → 20-min BullMQ delay (`engine-lease.ts`). `capture-engine-limits.spec.ts` AC3 ×3, `capture-engine-gate.spec.ts`, `engine-lease-redelay.spec.ts` |
| 4. Health buckets | Met | customer attempts → `EngineHealthService.recordAttempt` via the gate; `capture-engine-limits.spec.ts` AC4 |
| 5. Canary | Met (unchanged) | |
| 6. Six-stage ladder applied automatically | Met for stages 1–5 | stage 2 per attempt (gate → `RefillReductionTracker`, read by the lease); stages 3 and 5 by `degradation-runtime.ts` (30 s tick, capture group, `worker.ts`); stage 4 is the breaker. **Stage 6 (blackout paging) is STORY-179's.** Stage 3 drives the default logging rotator until STORY-028/029 |
| 7. Degraded renders with a warning; runs complete partial | Met | stage 5 → `engines.status = 'degraded'` (and back to `active` when the breaker closes); cells skipped `blocked` / `engine_degraded`; `engine.degraded` published per workspace from the capture path; `capture-engine-limits.spec.ts` AC7 ×2, `degradation-runtime.spec.ts` |
| 8. Quota exhaustion: open immediately, no retry, re-queue for the next window | Met (option b) | quota cell is a terminal `failed` row and opens the breaker with reason `quota`; later cells settle `blocked` / `quota_exhausted` with no vendor call; the next scheduled window captures them. `capture-engine-limits.spec.ts` AC8 ×2 |
| 9. Spend ceiling, alerts, proportional hard stop | Met (see decision 3) | past the ceiling a priority cell is captured and every other cell refused, in every tenant (`execute-cell.ts`, `tracked_prompts.is_priority`). `capture-engine-limits.spec.ts` AC9 |
| 10. One breaker open, others capture | Met — now true in the capture path, not only trivially | `capture-engine-limits.spec.ts` AC10 |
| 11. Health endpoint + per-engine status surface | Met (API) | `GET /v1/engines/status` (`engines-status.controller.ts`, `HealthService.engineStatus`); `engines-status-http.spec.ts`. Client rendering on first paint not done (section 5) |

## 2. `references/api-specification.md`

- §3, Tracking table, NEW row: `GET` `/engines/status` — `workspace:read` (any member) — `per-engine status, so a customer can tell a platform problem from a vendor one (STORY-031 AC11). One entry per active engine: engine_key, status (engines.status), circuit_state (the live breaker), unavailable_since (when the breaker left closed; null while closed), window_minutes (60) with attempts, successes, blocks, timeouts, rate_limited from engine_health, and p50/p95 latency from the latest bucket. Global data only, no tenant field; Cache-Control: private, max-age=30.`
- §11, `engine.degraded` row, Notes: add `published to a workspace when one of its cells is skipped because the engine is unavailable (breaker open on quota, or degraded); affected_projects counts that workspace's unfinished runs on the engine; coalesced per workspace and engine.`

## 3. `references/plans-and-entitlements.md` §5 ("Failed action") and `page-inventory.md` FR-SCAN-01h

Owner decision 2026-10-26 (10) is an exception to "a partial run is charged in full". Add: `A manual deep scan whose cells were skipped because an engine was unavailable (its breaker open on quota exhaustion, or the engine degraded) is refunded the skipped cells' share of the flat price, floor(price × skipped ÷ planned), as a compensating refund entry referencing the run, audited (billing.run_refunded_engine_unavailable). A cell that reached the engine and failed is still charged. The refund lands on the next hourly capture sweep.`

## 4. `references/edge-cases-and-slos.md` EC-06 / EC-08 — clarifications, no change of intent

- EC-08 "re-queued for the next window": recorded as option (b) — the cell settles `blocked` with `error_code = quota_exhausted` and the next scheduled window captures it.
- EC-06 stage 5 "circuit open > 30 min" is measured over the breaker's EPISODE (from leaving `closed` until a successful half-open probe closes it), because the breaker's own open window is 20 minutes.

## 5. Decisions taken (flagged for the owner)

1. **Skipped cells are `blocked`, not `skipped`.** The plan's wording was "settle as skipped"; `answer_captures.status = 'skipped'` is the L1/L2 reuse vocabulary and counts as a MEASUREMENT in every rollup (the deny-list in `aggregate-day.ts`), so a quota-skipped cell would have read as "the engine did not mention you". `blocked` is "we could not ask". A new named rule `blockedStatusSql` was added for the refund's predicate (STORY-152 scanner).
2. **The refund is a sweep, not the finalising cell.** capture.execute's commit transaction also enqueues and touches the cache, so a ledger write there would share a transaction with network I/O; the STORY-181 phasing is unchanged. `sweepEngineSkipRefunds` rides the hourly capture scheduler tick; each run settles in its own tenant transaction that does nothing else. Latency: up to an hour after the run finishes.
3. **The hard stop's "priority subset, proportionally" is applied as a uniform per-cell filter.** Every tenant keeps exactly its own priority subset, so the share is proportional to each tenant's priority set and nobody is starved for anybody else. `allocateProportionally` still has no runtime caller: the reference names no post-stop capacity for it to divide. If the owner wants a capped post-stop budget split across tenants, that number is a decision.
4. **Refund scope:** only `blocked` cells with `quota_exhausted` / `engine_degraded`. NOT refunded: the call that itself hit the quota (it reached the vendor), rate-limited or timed-out cells, and cells refused by the platform spend ceiling (`engine_spend_ceiling_reached` — our budget, not the engine's quota/outage; owner may want this included).
5. **The ladder owns `degraded` in both directions:** the planner excludes a degraded engine, so the evaluator returns it to `active` once its breaker closes. Operators use `disabled`.
6. **Files outside the plan's `files_touched`** (disclosed): `src/lib/credits/engine-skip-refund.ts`, `src/lib/capture/engine-skip-refund-sweep.ts`, `src/lib/capture/scheduler-sweep.ts`, `src/lib/engines/capture-engine-gate.ts`, `src/lib/rollup/aggregate-day.ts` (new named rule), `test/unit/analytics/measurement-status-shared.spec.ts` (pins the new rule by value), `src/modules/health/engines-status.controller.ts`, `test/support/open-engine-gate.ts` and the seven existing capture specs that now inject it.

## 6. Not done here

- AC2 host limiter in the crawl handlers.
- Client (`app-fnt-dev-main`): read `GET /engines/status` on first paint for the ProjectChrome degraded pip (the realtime `engine.degraded` handler already exists and now receives real events). Regenerate the client copy after the API merge.
