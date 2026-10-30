# STORY-078 - shared tool core: evidence and status notes (review round 2)

## Owner decisions (2026-10-30), no behaviour change
- **31:** `TOOL_RUN_STALE_AFTER_MINUTES` = 60 (retention.ts).
- **32 (closes AC10):** pinned runs are a `?pinned=` filter only; the timeline stays in time order (`setPinned`, tools.service.ts).
- **33 (AC19):** `nominara_tools_conversions_total` plus the `tools.run.converted` log line is the funnel event (tools.service.ts).

## Round 2 fix: a direct `expireToolSnapshotsForWorkspace` call and a stale `running` run
`retention-cascade.spec.ts` T9 (untouched) inserts a `running` run past `expires_at` and calls the expiry directly. Round 1 made expiry skip
`running` runs (their charge is unsettled), so T9 got 0. Fix (option b, code not test): `expireToolSnapshotsForWorkspace` first calls
`reapStaleToolRuns` (bounded loop), which refunds through the same `settleFinishedRunCredits` path; `reapStaleToolRuns` now also treats a
`running` run already past its own `expires_at` as abandoned (such a run outlived its retention whatever its age). Idempotent: the debit's
idempotency key makes a second pass refund nothing, and the nightly sweep still reaps first.
- `tool-runs-core.spec.ts` scenario 14 "the sweep expires only finished runs ... left for the reaper" encoded the round-1 behaviour that T9
  contradicts. It is replaced by two tests: a direct sweep reaps, refunds in full (ledger commit + refund) and expires, idempotently; and a
  `running` run NOT past expires_at is left alone.
