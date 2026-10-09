# NEW-A-10 — capture.plan handler — checkpoint-4 fix pass (second-engineer review)

Branch 7day/a-gemini-5, base integration/7day 74e4b2f. The original NEW-A-10 evidence lives on the lane that built it; this file records only the checkpoint-4 findings.

| Finding | Criterion -> test (test/integration/capture-plan-handler.spec.ts unless stated) | RED sha | Fix sha |
|---|---|---|---|
| 2 `status = 'queued'` guard in failUndispatchedRun untested (mutant G) | "NEW-A-10 · checkpoint-4 · a dispatch that rejects after a cell has started leaves the run and its fair-use reservation alone". Passes on the base code by design (the guard exists); mutant G (guard removed) now FAILS it (exit 1, 1 failed of 18), reverted. | e23487c (test only) | none needed |
| 3 ambiguous dispatch failure: cells still run against a `failed` run | "NEW-A-10 · checkpoint-4 · cells that WERE enqueued before an ambiguous dispatch failure do not call the vendor or write a capture against the failed run" (fetch stubbed and counted: RED = called 3 times) | e23487c | 482ed64 |
| 5 manual cadence claimable and never advanced | "NEW-A-10 · checkpoint-4 · a manual-cadence project with a past next_run_at is not planned: no run, no fair-use reservation" (3 deliveries) | f183a18 (RED: a run was planned) | d53366b |

Finding 3: the second of the two options the reviewer offered was taken: capture.execute skips a cell whose run is `failed` (as it already did for `canceled`). The compensation does not drain the queue: a drain needs a producer connection inside the compensation and cannot see a reply-lost addBulk any better than the skip can; the skip also covers a cell delivered after any later failure of the run. The run stays `failed`, no fair-use is held for it, and no capture is written. Finding 3 asked for a test that dispatches the cells and then rejects: it is the test above.

Finding 4 (crash between COMMIT and dispatch): see NEW-A-13.md, "checkpoint-4".
