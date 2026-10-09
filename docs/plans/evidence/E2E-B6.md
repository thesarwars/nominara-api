# E2E-B6 — spend meter second-engineer audit (branch 7day/fix-spend-gate)

Base: integration/7day c9a188b. RED commit 1e8917a (tests only), fix commit follows it.

## Findings and what closed them

1. [blocker] Concurrent redelivery double-count. `captureCell` now takes a transaction-scoped advisory lock
   (`pg_advisory_xact_lock(hashtextextended(<run|prompt|engine|sample>, 0))`) before the existing
   check-for-a-prior-row. A unique index was not available without a schema change: `answer_captures` is
   partitioned on `captured_at`, so every unique index must include it, and it differs between attempts.
   The second delivery blocks until the first commits (then replays; `captured_cells` and the meter are not
   touched again) or rolls back (then it is the one real attempt). No migration, no tenant table touched.
   Test: "E2E-B6f audit 1" runs two deliveries concurrently on a `running` run with a 400 ms vendor delay;
   it failed red (2 where 1 expected) and passes.
   Note: with the run in `queued`, the first-cell `UPDATE capture_runs` row lock happened to serialise the
   copies; the race lived on every later cell, which is why the test starts the run `running`.
2. [major] Gate fail-open on a bad total. `ValkeySpendMeterStore.readTotal`: absent key = 0 (start of period);
   a non-finite, negative or empty stored value throws `SpendMeterUnreadableError`; Valkey down already threw.
   `isCeilingReached` also rejects a non-finite total from any store. The handler logs
   ("engine spend gate unreadable ...") and counts
   `nominara_capture_spend_gate_unreadable_total{engine_key}` then rethrows into the retry ladder.
   Tests: unit (absent, five corrupt values, down, non-finite from a store) and integration (corrupt key =
   zero vendor calls, job throws, metric and log asserted; absent key captures).
3. [minor] Zero, negative or NaN ceiling now BLOCKS (`isCeilingReached` true). `recordCost.hardStopped`
   agrees. Config validation (`z.number().positive()`) already rejects these at boot; this is defence in depth.
4. [minor] Ordering chosen and pinned, not moved. The meter is charged when the vendor call returns (or
   throws), before the DB write and independent of the commit. Reason: the money is spent at that moment; a
   rollback or crash afterwards does not refund it and the retry pays again. Moving it after the commit would
   lose the spend of every call whose commit never happens (errs toward overspend); the current order errs
   toward blocking sooner. Test: "audit 4" rolls back after `capture.execute` and asserts the meter kept
   the cost while no capture row exists.
5. [minor] Billed-but-invalid responses are metered. Gemini adapter: when the body fails the response
   schema but `usageMetadata` carries readable non-negative integer token counts, the cost is computed with
   the same price constants (plus the grounding fee when grounding is readably present) and recorded before
   `malformed_response` is thrown. Base adapter: a payload failing `rawCaptureSchema` records its own
   readable `costUsd >= 0`. `captureCell` meters on every vendor return/throw path, and writes the
   `usage_ledger` row for terminal-failed and refusal cells too. A retryable failure rolls its ledger row back
   with the transaction (the meter keeps it).
   Behaviour change: `base-adapter-validation.spec.ts` asserted "recordCost is NOT called on a malformed
   response". That assertion was the opposite of finding 5, so it was rewritten (marked SUPERSEDED in the
   test) rather than bent; the no-readable-cost case remains pinned as "records nothing".
6. [nit] "audit 6" pins a stored total exactly at the ceiling (100) as blocked (`>=`).

## Gates (this worktree)

lint 0 · typecheck 0 · contracts:check 0 (no drift) · test:unit 315 files / 3893 passed, 1 skipped ·
integration: capture-execute-handler, capture-execute-rollup, capture-gemini-end-to-end (16),
capture-parse-handler, capture-suppressed-rows, worker-group-bootstrap, capture-fair-use: 87 passed ·
test:isolation 12 files / 55 passed (no table changed; no migration; db:rls-generate not needed).

## Known limits (out of scope, recorded)

- The pre-call check-then-act overrun: N cells that pass the gate together can all call the vendor; the
  overshoot is bounded by in-flight concurrency (queue concurrency x workers), not by the ceiling.
- The meter is float USD (INCRBYFLOAT, `numeric(10,6)` ledger). Kept; ledger cost is written at 6 decimals.
- A meter key that disappears mid-period (eviction, FLUSH) is indistinguishable from the start of a period
  and reads as 0 spent. Only unreadable and corrupt values fail closed.
- A retryable failure that was billed is metered, and its retry will be metered again (each call is a real
  charge); its `usage_ledger` row is rolled back with the transaction, so the ledger undercounts the meter.
- There is no tracing SDK yet (`CaptureSpan` is a structural stand-in), so no real span was added; the
  metric and redacted log line are asserted.
