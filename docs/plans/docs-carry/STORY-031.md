# STORY-031 — the engine limits wired into the live capture path (carry to the docs repo)

The docs repo has no `.git` here and this change may not edit it. `docs/references/api-specification.md` (the vendored mirror)
is NOT edited, because `test/unit/docs-reference-mirror.spec.ts` requires byte-equality with the snapshot; mirror and snapshot
change together in the docs repo. Branches `story/031-engine-limits` (api) and `story/031-engine-status-client` (client,
`app-fnt-dev-main`), not pushed.

## 1. Story status — `stories/capture/STORY-031-rate-limiting-circuit-breaking-engine-health.md`

`Partial — 3 of 11 ACs` → **`Partial — 10 of 11 ACs`** (only AC2 open; AC6 stage 6 is STORY-179's). Replace the 2026-10-12 rows:

| AC | State | Evidence |
|---|---|---|
| 1. Lease per engine, re-delay not fail | Met (unchanged) | `engine-lease.ts`; plus the stage-2 halved bucket (`refillReduction`) |
| 2. Per-target-host crawl limit | **Partial (unchanged)** | `HostRateLimiter` still has no crawl caller — not in this stream (capture path only) |
| 3. Breaker per engine, thresholds, half-open | Met | `capture-engine-gate.ts` (`admit` before every vendor call, `record` after every attempt), `capture-execute.handler.ts` run phase; ratio-open → `EngineRedelayError` → 20-min BullMQ delay (`engine-lease.ts`). Half-open re-opens only on `blocked` / `quota_exhausted` (section 5, item 6). `capture-engine-limits.spec.ts` AC3 ×3, `capture-engine-gate.spec.ts` (incl. the half-open block), `engine-lease-redelay.spec.ts` |
| 4. Health buckets | Met | customer attempts → `EngineHealthService.recordAttempt` via the gate; `capture-engine-limits.spec.ts` AC4 |
| 5. Canary | Met (unchanged) | |
| 6. Six-stage ladder applied automatically | Met for stages 1–5 | stage 2 per attempt (gate → `RefillReductionTracker`, read by the lease); stages 3 and 5 by `degradation-runtime.ts` (30 s tick, capture group, `worker.ts`); stage 4 is the breaker. **Stage 6 (blackout paging) is STORY-179's.** Stage 3 drives the default logging rotator until STORY-028/029 |
| 7. Degraded renders with a warning; runs complete partial | Met | stage 5 → `engines.status = 'degraded'` for an `active` engine only, and back to `active` only for the ladder's own untouched write (section 5, item 5); cells skipped `blocked` / `engine_degraded`; `engine.degraded` published per workspace from the capture path; client: `ProjectChrome` reads `GET /engines/status` on first paint (`useDegradedEngines`, key `qk.engineStatus(ws)`) merged with the realtime event, which also re-reads it. `capture-engine-limits.spec.ts` AC7 ×2, `degradation-runtime.spec.ts`, `engine-ladder-status-ownership.spec.ts`; client `tests/engine-status-first-paint.test.tsx`, `tests/shell-query-wiring.test.ts` |
| 8. Quota exhaustion: open immediately, no retry, re-queue for the next window | Met (option b) | quota cell is a terminal `failed` row and opens the breaker with reason `quota`; later cells settle `blocked` / `quota_exhausted` with no vendor call; the next scheduled window captures them. `capture-engine-limits.spec.ts` AC8 ×2 |
| 9. Spend ceiling, alerts, proportional hard stop | Met (see section 5, item 3) | past the ceiling a priority cell is captured and every other cell refused, in every tenant (`execute-cell.ts`, `tracked_prompts.is_priority`). `capture-engine-limits.spec.ts` AC9 |
| 10. One breaker open, others capture | Met — now true in the capture path, not only trivially | `capture-engine-limits.spec.ts` AC10 |
| 11. Health endpoint + per-engine status surface | Met | `GET /v1/engines/status` (`engines-status.controller.ts`, `HealthService.engineStatus`); `engines-status-http.spec.ts`. Client: `lib/api/engines.ts`, `components/project/useDegradedEngines.ts`, demo route `lib/demo/routes/engines.ts`; `tests/engine-status-first-paint.test.tsx` |

## 2. `references/api-specification.md`

- §3, Tracking table, NEW row: `GET` `/engines/status` — `workspace:read` (any member) — `per-engine status, so a customer can tell a platform problem from a vendor one (STORY-031 AC11). One entry per active engine: engine_key, status (engines.status), circuit_state (the live breaker), unavailable_since (when the breaker left closed; null while closed), window_minutes (60) with attempts, successes, blocks, timeouts, rate_limited from engine_health, and p50/p95 latency from the latest bucket. Global data only, no tenant field; Cache-Control: private, max-age=30.`
- §11, `engine.degraded` row, Notes: add `published to a workspace when one of its cells is skipped because the engine is unavailable (breaker open on quota, or degraded); affected_projects counts that workspace's unfinished runs on the engine; coalesced per workspace and engine. Not a complete signal on its own (a degraded engine is no longer planned, so it stops skipping cells): the client reads GET /engines/status on first paint and re-reads it on this event.`

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
5. **`engines.status` is operator state; the ladder moves only what it owns** (review round 1). Stage 5 moves `active` → `degraded`
   only (a `disabled` or `beta` engine is never touched, though the canary probes every registry engine). Recovery moves
   `degraded` → `active` only for a `degraded` the ladder wrote and nobody has touched since: the ladder keeps a mark on the cache
   instance (`engine-ladder:degraded:<key>`, no TTL) holding the `updated_at` its own UPDATE produced, and recovery is guarded on
   `status = 'degraded' AND updated_at = <mark>`; the `touch_updated_at` trigger means any operator edit takes ownership. No mark,
   or an unreadable one, means "not ours" and the engine stays degraded (migration 0027's safe direction). If the mark cannot be
   written, the degraded write is undone and the next tick retries. No schema change, so migration 0138 stays unused; losing the
   cache's data strands a ladder-degraded engine in `degraded` until an operator flips it. Docs: `schemas/` engines `status` note
   should say the ladder may set and clear `degraded` under exactly these rules.
6. **Half-open probing, the D7 split reviewed** (failure-taxonomy.ts asks STORY-031 to). A half-open breaker re-opens only on evidence
   that would have opened a closed one: `blocked` (EC-06 stage 4) or `quota_exhausted` (EC-08, any state). The retryable transport
   codes `rate_limited`, `timeout`, `upstream_5xx` are a new breaker outcome `transient_failure`: an attempt in the ratio's
   denominator while closed, NEUTRAL while half-open (`rate_limited` still triggers the stage-2 refill reduction). `auth_failed`
   and `malformed_response` still re-open a half-open breaker. The canary's own mapping is unchanged. Reason: the stage-4 re-queue
   delay and the breaker's open window are both 20 minutes, so every re-delayed cell is admitted at half-open; one 429 among them
   used to re-open the breaker, push the episode past 30 minutes and mark the one real engine degraded under ordinary load.
   Docs: EC-06 should state which outcomes fail a half-open probe.
7. **Refund after a cycle roll — reported, not changed.** A refund landing after the wallet rolled (repeated sweep failures) still
   returns the included share to `included`, in the new cycle; `settleEngineSkippedCells` reports `debitBeforeCurrentCycle`, logs
   `credits.engine_skip_refund.after_cycle_roll` and counts `nominara_credits_engine_skip_refund_after_cycle_roll_total`.
   Withholding the share or routing it to `purchased` would each be a new policy under owner decision 10: **owner to rule.**
8. **The refund sweep pages through every candidate** (keyset on `finished_at, id`): a candidate that settles to nothing (no debit,
   a share that floors to 0) matches "no refund yet" on every tick and could otherwise fill the single oldest-first page of 200 and
   starve newer runs for the whole lookback.
9. **`engine.degraded` publish inside the commit transaction** (a cache SET NX and a publish, before COMMIT): same shape as the
   existing `emitProgress`, folded into the wave-4 NFR-ARCH-04 follow-up ("Valkey writes inside capture commit tx"); a rollback
   after the publish can send one stale, self-correcting event (the client re-reads `GET /engines/status` on it).
10. **Files outside the plan's `files_touched`** (disclosed): `src/lib/credits/engine-skip-refund.ts`, `src/lib/capture/engine-skip-refund-sweep.ts`, `src/lib/capture/scheduler-sweep.ts`, `src/lib/engines/capture-engine-gate.ts`, `src/lib/rollup/aggregate-day.ts` (new named rule), `test/unit/analytics/measurement-status-shared.spec.ts` (pins the new rule by value), `src/modules/health/engines-status.controller.ts`, `test/support/open-engine-gate.ts` and the seven existing capture specs that now inject it; round 1 adds
   `test/integration/engine-ladder-status-ownership.spec.ts`; round 2 adds `test/integration/engine-skip-refund-sweep-rls.spec.ts`. Client: `lib/api/engines.ts`, `lib/api/contract.ts`,
   `components/project/useDegradedEngines.ts`, `lib/query/keys.ts`, `lib/query/realtime-map.ts`, `lib/demo/routes/engines.ts`,
   `lib/demo/routes.ts`, `tests/guards.test.ts` (comment), `tests/shell-query-wiring.test.ts`; round 3 adds
   `components/shell/RealtimeBridge.tsx`, `lib/stores/useLiveStore.ts`, `lib/copy/engine-status.ts`, `tests/engine-status-recovery.test.tsx`.
11. **The refund sweep refuses an RLS-bound connection** (review round 2). Its candidate query runs with no tenant context; on a
   NOBYPASSRLS role under FORCE RLS it found nothing and returned "0 refunded" while a refund was owed (proven by
   `test/integration/engine-skip-refund-sweep-rls.spec.ts` against `nominara_worker`). The scheduler tick already refused such a
   connection (`assertSweepCanSee`) before reaching the sweep; the sweep now refuses it itself
   (`EngineSkipRefundSweepBlindError`, `nominara_credits_engine_skip_refund_sweep_blind_total`). Production still depends on the
   owner connection's identity, the same open question as the stuck-run reaper (README G-4).
12. **Engines left out of the plan because they were already `degraded` at trigger time are not refunded** (review round 2, owner
   question). The planner plans only engines the entitled view returns (`e.status = 'active'`, `engine-cadence.ts`), so for an engine already `degraded` at trigger time the cells never exist as `blocked` rows
   and `settleEngineSkippedCells` never sees them: the customer pays the flat `deep_scan.credits` for fewer engines, whereas the
   same scan planned minutes earlier (before stage 5) is refunded for the skipped cells. Decision 10's text covers cells "skipped
   during" a scan and the flat price for unplanned engines predates this story (STORY-034), so behaviour is unchanged here.
   **Owner to rule:** price or refund engines excluded at trigger time, or state in `plans-and-entitlements.md` §5 that they are not.
13. **The client's degraded warning is the EC-06 stage-5 state only; an open breaker on an `active` engine reads "delayed"** (review
   round 2). EC-06 puts the warning at stage 5 (`degraded`); at stage 4 cells are re-queued, not lost. The pip shows
   "degraded — <engine>" for `status = degraded` or a realtime `engine.degraded` push, and "delayed — <engine>" for a breaker that is
   `open` while the catalog still says `active`. A realtime push no longer outlives a newer status read that reports the engine
   healthy (the API publishes no recovery event; the read is the authority once it is newer than the push).
   Round 3: "newer" is a shared observation counter, not two wall-clock reads; the bridge records the push before the frame's
   own re-read starts, so that re-read settles a quota push on an `active` engine on "delayed"; and while any warning shows the
   client re-reads `GET /engines/status` every 30 s (its max-age), not at all otherwise, so recovery is observed without a reload.
   **Owner to confirm (new customer-facing word):** EC-06 defines no user-visible stage-4 state. Either confirm "delayed — <engine>"
   (now in `lib/copy/engine-status.ts`) and add it to EC-06 / the ui-ux vocabulary, or rule that stage 4 shows nothing.
   **Wording gap, owner to rule:** a QUOTA-opened breaker (EC-08) on an `active` engine also reads "delayed", although its cells
   are skipped `blocked` / `quota_exhausted` and refunded, not re-queued. The status contract carries no breaker reason, so the
   client cannot tell the two apart; showing quota as "degraded"/"unavailable" needs a `circuit_reason` field (contract change).
14. **The engine-skip settlement scopes its reads to the workspace** (review round 3). Because the sweep refuses an RLS-bound
   connection, the per-candidate tenant transaction runs on a role that bypasses RLS: the tenant context is defence in depth
   there, not the boundary. The `capture_runs` FOR UPDATE read and the `answer_captures` count now carry `workspace_id`, so a
   workspace that does not own the run settles nothing (`engine-skip-refund-sweep-rls.spec.ts`).
15. **The pg_roles visibility check is not extracted into a shared helper** (review round 3, minor, declined here). Six copies
   exist (`scheduler-sweep`, `rollup-sweep`, `unverified-sweep`, `notify-sweep`, `audit-verify`, this sweep); five are on main in
   files outside STORY-031's scope, each with its own error type and counter. A shared `assertOwnerConnectionCanSee` belongs in
   its own refactor story touching all six, with their specs re-run; recorded as a follow-up.

## 6. Not done here

- AC2 host limiter in the crawl handlers (crawl.discover, crawl.audit, source.verify_presence): deferred out of the capture-path
  stream, recorded in `plans-7day/followups-2026-10-19-d1.md` for the orchestrator/owner to schedule as its own item.
- Owner confirmation still needed for section 5 items 3 (hard stop as a uniform priority filter) and 4 (refund scope excludes
  spend-ceiling-blocked cells), item 7 (refund after a cycle roll), item 12 (engines excluded at trigger time) and item 13 (the
  "delayed" stage-4 word, and quota-opened breakers reading "delayed").
- Follow-up story: one shared owner-connection visibility check for the six sweeps (section 5, item 15).
- Second-engineer review by `dangerous-area-auditor` (credit ledger refund, the sweep's per-candidate tenant context, breaker and
  `engines.status` ownership) is still outstanding.
- After the API merges: regenerate the client copy (`client:generate`, build) and refresh the client's `clientDistSha256`.
