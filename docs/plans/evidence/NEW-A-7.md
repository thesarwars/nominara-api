# NEW-A-7 — evidence (checkpoint-2 fix, QA failure AC4)

Branch 7day/a-gemini-3, base integration/7day f201f35. Spec commits: 25650cd (the e2e spec), 3f02cba (vendor call matched by method, not host).
Run 2026-10-08 on a local colima Docker. No src change was needed: the implementation (811298d, 24aa2bd, 6bc7628, merged at c11e424) was already correct; what was missing was evidence.

## Acceptance criteria

NEW-A-7 acceptance criteria from plans-7day/track-plans.json (AC1 to AC3 were accepted by QA at checkpoint 2; their proofs are listed so the file is complete).

| AC | Proof (file :: test) | RED |
|----|----------------------|-----|
| AC1 one signed tenant job per run, workspace-local day, idempotent | test/integration/capture-parse-rollup.spec.ts :: "NEW-A-7 AC1 ..." (3 tests incl. concurrent last cells) and capture-execute-rollup.spec.ts :: "NEW-A-7 AC1 ..." | 811298d (RED) and f6be248 (audit RED), recorded by the lane at the time |
| AC2 enqueue from the parse path after COMMIT, not at finalisation | capture-parse-rollup.spec.ts :: "NEW-A-7 AC2 ..." (after COMMIT; rolled-back parse enqueues nothing) | same |
| AC3 tenant context, cross-tenant | capture-parse-rollup.spec.ts :: "NEW-A-7 AC3 ..." (nominara_app, forged payload naming B's project) and the second test below | same |
| AC4 a Gemini deep scan changes scorecards.engines[gemini] and the growth map's latest day without waiting for an hourly cron | test/integration/capture-gemini-end-to-end.spec.ts :: "NEW-A-7 AC4 · before the scan Gemini has no measurement; after it, scorecards.engines[gemini] and the growth map's latest day carry the scan" | see below |

### What the AC4 spec drives (capture-gemini-end-to-end.spec.ts)

Real: the registry's real Gemini adapter (GEMINI_API_KEY set to a fake value), the real capture.execute, capture.parse and rollup.metric_daily handlers, each in its own tenant transaction as nominara_app (RLS in force), and the real ApiModule answering `GET /v1/projects/{id}/scorecards` and `GET /v1/projects/{id}/growth-map` over HTTP (guards, interceptors, response schemas parsed with scorecardsResponseSchema and growthMapResponseSchema). A business-plan workspace (Gemini's catalogue floor) with two active prompts.

Not real, stated plainly: the BullMQ hop (each handler's injected enqueue seam records the job and the spec runs it next; worker boot over a real queue is NEW-A-17), the vendor (global fetch answers with the recorded generateContent fixture; no key spent), and the citation redirect fetch (guardedFetch returns a distinct final host per wrapper). The rollup cron and `rollUpDay` are never called by the spec; the only thing that can request the rollup is the parse completion path.

Assertions in the main test: before the scan engines[gemini] exists with cells_total 0, presence_rate null, data_source null, and the growth map has no cells; after the scan geminiRequests is 2, exactly one rollup job ran, engines[gemini] has cells_total 2, a non-null presence_rate, mentions and citations above 0 and data_source 'live'; the growth map's brand series latest day has cells 2, a non-null visibility_score, data_source 'live', and metric_daily has rows for the project.

Other tests in the file:
- "the other workspace's scorecards are untouched by this workspace's scan": workspace B's scorecards stay at cells_total 0 and B has no metric_daily rows; as nominara_app, B's context sees 0 rows of A's metric_daily, answer_captures, mention_facts and citation_facts while A's context sees them. Note: the HTTP harness connects as a superuser, so it cannot show RLS itself; the RLS claim rests on the nominara_app queries.
- "negative control": captured-but-never-parsed cells request no rollup, so the growth map stays empty and metric_daily has no rows. (Scorecards read facts live via aggregateRange, so a captured cell shows there before any rollup; the growth map is the surface that needs the rollup. The main test therefore asserts both surfaces after the full chain, and the negative control uses the growth map.)

### RED for AC4

This is a test-only change on an already-correct implementation, so there is no commit that fails for want of code. The RED is a mutation, run twice (before and after the final edit): in src/lib/queue/handlers/run-rollup-request.ts the guard `if (runId === null) return;` was changed to `if (runId === null || runId !== null) return;`, which makes the parse path request no rollup.

    pnpm exec vitest run --config vitest.integration.config.ts test/integration/capture-gemini-end-to-end.spec.ts
    exit 1, 2 failed | 1 passed (3)
      x "... carry the scan"            AssertionError: expected [] to have a length of 1 but got +0   (no rollup job)
      x "... other workspace ..."       AssertionError: expected false to be true                       (A's own rows absent)

The mutation was reverted (git checkout); the tree is clean and the spec passes (exit 0, 3 passed).

## Gates (final tree, 3f02cba)

| Command | Exit | Result |
|---------|------|--------|
| pnpm lint | 0 | |
| pnpm typecheck | 0 | |
| pnpm test:unit | 0 | 277 files passed, 1 skipped; 3313 tests passed, 1 skipped. (An earlier run exited 1 on test/unit/engines/no-real-adapter-in-tests.spec.ts because the first draft named the live vendor host; fixed in 3f02cba, the scanner was not touched.) |
| vitest integration: capture-gemini-end-to-end, capture-parse-rollup, capture-execute-rollup, capture-plan-handler, capture-scheduler, capture-parse-handler, data-source, rollup-metric-daily | 0 | 8 files, 93 tests passed |
| pnpm test:isolation | not run | crashes in fixture setup at this tip (support_grants TTL fixture, d-admin lane); tenant isolation proven here under SET ROLE nominara_app instead. The merge step runs the isolation suites. |

## Not covered, said explicitly
- Tracing: OpenTelemetry spans are deferred to week 2 (owner decision); no span is claimed here.
- A real running API with a real queue and the real Gemini: collected in NEW-A-17.
- Capture/scheduling failures in checkpoint-2-gates.md: none. The 17 listed integration failures belong to other lanes (seed-demo to a-api, the rest to b-ws, d-billing, c-src, e-reports). The capture specs touched here pass.
- Other QA notes for this lane (NEW-A-10 AC2 cache-hit reservation, the unstubbed GEMINI_API_KEY in three specs, documenting the per-run rollup key) were not part of this task and are open.

## Audit finding: isolation suite (major) - AC3 "isolation suite is green" is NOT met
- Status: OPEN, blocked on the d-admin lane. Not fixed in this lane, deliberately.
- Cause: the support_grants fixture in the isolation suite inserts a 24 h TTL, which violates ck_support_ttl_max (4 h ceiling, migrations 0085/0086). test:isolation and test:isolation:breakers exit 1 in fixture setup. The defect is in the d-admin fixture, not in NEW-A-7 code; fixing it here would touch files outside this story.
- What this lane does have: a cross-tenant proof under SET LOCAL ROLE nominara_app in the integration spec (capture-parse-rollup.spec.ts, AC3 tests). That is NOT a substitute for the isolation suite and is not claimed as one.
- Merge condition (from the audit): NEW-A-7 is not accepted until d-admin fixes the fixture and test:isolation plus test:isolation:breakers exit 0 on the merged tree. The merge step must run both and record exit codes here.
