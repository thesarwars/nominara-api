# CP1 c-comp fixes — CP2 QA close-out (lane c-comp)

Branch 7day/c-comp-3 from f201f35. Spans are DEFERRED to week 2 (owner decision 3); the metric and redacted log line exist.

## QA failed criteria

### 1. NEW-C-1 criterion 5, Gemini half (detected-not-tracked rows from real captures) — NOT MET THIS WEEK, owner decision needed
`src/lib/parser/parse-capture.ts` builds aliases from the brand and tracked competitors only; nothing under `src/lib/parser` writes
`entity_type='other'`. Producing it is the unimplemented part of STORY-036 AC8 plus tracking-engine.md line 328 (capitalised
multi-token noun phrases in list positions, rolling 30-day count). It is a parser change (a dangerous area) in files NEW-C-1's notes do
not name, so under the hard rules it was not started. The same gap means real Gemini captures cannot name untracked displacers
(NEW-C-3 note 3). **Owner needs to either assign it to the parser lane as its own story, or re-scope NEW-C-1 criterion 5 to "detected-not-tracked rows appear once that story lands".**
The demo half is met: `test/integration/competitor-panel.spec.ts` > "CP1 NEW-C-1 — over STORY-169 seed output the panel has brand
and tracked rows, every engine demo, no detected-not-tracked rows" (commit `f890063`).

### 2. Recompute-key nonce unproven — CLOSED
Test: `test/integration/competitor-track.spec.ts` > "CP1 c-comp — re-tracking a revived competitor enqueues a SECOND recompute under
a different idempotency key" (commit `364105d`). It passed at the RED commit (the nonce already existed), so RED is not applicable;
instead **mutation proof**: removing `:${uuidV7()}` from the key in `CompetitorTrackingService.requestRecompute` makes it fail
(`expected 1 to be 2`, exit 1); restored, exit 0.

## Earlier CP1 items (unchanged, re-run)
- MAJOR cap lock on discovery confirm: RED `e8a5196`, fix `8c94a52`; `test/integration/competitor-confirm-cap.spec.ts` "CP1 c-comp MAJOR — 10 tracks and 10 confirms ... never exceed the cap" and "STORY-044 AC5 — a discovery confirm with competitors actually writes the rows (source 'user')" — both pass in the run below.
- The five integration specs QA could not run (Docker I/O error) were re-run on this tip: refresh-project-displacements, competitor-confirm-cap, competitor-panel, competitor-track all pass (58 tests with the new migration spec, exit 0).
- `seed-demo.spec.ts`: 8 failed / 28 passed, exit 1 — the SAME eight NEW-A-8 tests listed failing at f201f35 in `plans-7day/checkpoint-2-gates.md` (owner: a-api lane; facts-only seed writes nothing). Not caused by this lane; proven by the identical set at the base tip.

## Gates
`pnpm lint` 0 · `pnpm typecheck` 0 · `pnpm test:unit` 0 (3313 tests) · `pnpm contracts:check` 0.
