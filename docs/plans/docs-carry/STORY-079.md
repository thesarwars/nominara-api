# STORY-079 - changes to carry to the docs repo (the snapshot is not edited here)

1. **api-specification.md section 3 (Tools).** Add `GET /tools/visibility-scan/estimate` (`lookup:execute`, free): `{credits: 10, rate: "flat", engines: [{engine_key,
   display_name}], engines_selectable: false, sample_statement, wallet: {available, available_after, shortfall}, consumes: {project_slots: 0, prompt_slots: 0,
   scheduled_envelope: false}}`. It is the NFR-API-11 pair of the scan and is how the panel names its engines before the click.
2. **api-specification.md section 3, `POST /tools/visibility-scan`.** State the request: `{brand_name, brand_url?, query_text, competitors?[<=10]}`, strict (no engine
   field). Headers: `X-Nominara-Confirmed-Credits: 10` (absent 400, other 409 `price_changed`) and a REQUIRED `Idempotency-Key`. Refusals are ordinary problem
   responses before the stream opens; after it opens every outcome ends with `scan.completed`. **Reconnect = the same POST with the same `Idempotency-Key` and body**:
   it attaches to the same run, replays the landed engines, resumes, and charges nothing (a different body under the key is 409).
3. **api-specification.md section 9 (SSE).** The events as built: `scan.accepted` gains `one_sample_per_engine` and `sample_statement`; `scan.engine_result` gains
   `age_ms` (0 for a live capture; `captured_at` is the ANSWER's time), `estimated: true`, `sentiment.label` may be `absent` with `score: null` (brand not in the
   answer), `cache_layer` `l1|none`; `scan.completed` gains `engine_failures[{engine, code, reason}]`, `credits {charged, refunded}`, `deadline_reached`,
   `not_tracked`, `did_not_check`, `sample_statement`, `aggregate.estimated_fields`, and its `aggregate` figures are `null` (not 0) when nothing was captured;
   `convert_cta` is `null` for a failed run. The stream ends at 55 s with a `partial` terminal if the worker has not settled the run (the charge stands until it does).
4. **system-architecture.md section 6.2** says CreditGuard "reserves" and total failure "RELEASES". As built (STORY-078) the flat price is a ledger DEBIT in the run's own
   transaction and a nothing-captured run is REFUNDED in full (`commit` + `refund` entries, wallet restored exactly). The story AC's "one release, one ledger entry" is
   satisfied as: exactly one `refund` entry of the full price.
5. **STORY-079 status.** Update the AC table from the evidence in `docs/plans/evidence/STORY-079.md`.
6. **ADR-0003 / streaming.** A `@Streaming()` route is now also exempt from AuditInterceptor and the audit-coverage sweep and audits itself in its own transaction.

## Review round 1 additions

7. **api-specification.md section 9 / `scan.completed`.** Gains `settled` (boolean). When the STREAM ends before the worker has settled the run (its 55 s deadline or a fault) the
   terminal event has `settled: false`, `status: "running"`, and `credits: {charged: null, refunded: null}` - the money is not final (a run that captures nothing is refunded in
   full by the worker), and the client reads `GET /tools/runs/{id}` for the final figures. `scan.engine_result.citations[].domain` and `.is_owned` are nullable: a citation
   that is an unfetched redirect wrapper (Gemini grounding) reports the engine's own hostname title as the domain hint, or `null` when there is none; `aggregate.owned_citation_count`
   is `null` (not 0) when there are citations and none has a known ownership.
8. **Status code.** The route answers `200` with `text/event-stream`; system-architecture.md 6.2 step 6 says `202`. 200 is what an EventSource accepts. The doc should say 200.
9. **Idempotency.** The claim lasts 24 hours (api-specification.md section 1) and is never deleted once the run is charged. A mismatched body is `409 idempotency_conflict`; a
   key starting `prompt_activate:` or `tool_run:` is a 400. Residual risk, stated plainly: if the process dies (or the cache is down) between COMMIT of the run and the claim
   write, the claim stays `pending` and a retry of that key is `409 idempotent_request_in_flight` until the 24 h claim expires - the client must use a new key; the scan it
   was charged for completes and is on `GET /tools/runs`. A stronger guarantee (the hashed key on `tool_runs` with a unique index, in the debit's transaction) needs a
   schema change this story did not name: raised for the owner.
10. **Reconnect and the daily cap.** A reconnect passes `@DailyCap("lookup")` and the rate-limit class before `accept` can recognise it as a reattach, so a user on their last
    daily scan whose connection drops is refused (429) on reconnect, although the reconnect charges nothing. The documented route for that case is `GET /tools/runs/{id}`
    (free). Detecting the claim before the cap guard would move logic into a guard: not done without a decision.
11. **Shared cache.** `no_shared_cache` is honoured: a flagged workspace neither reads nor seeds the cross-tenant L1 (integration test `no_shared_cache`).
12. **Sentiment and share constants.** The scan's headline sentiment label now uses the parser's `labelFor` (band 0.15, exclusive). The headline `sov_estimate` is the mean of the
    engines' shares and the headline sentiment score is a plain mean of scored engines; scoring-models.md section 3 (pooled ratio) and section 6 (prominence weighting) do not
    cover a single-sample estimate. The owner should ratify these two choices in scoring-models.md or direct the section 6 weighting (they are labelled estimates, and `scoring_version` is not stored for a scan).
13. **AC wording.** STORY-079's "report-only ... asserted by the isolation suite": the isolation suite (`test/isolation`) asserts RLS structure per table, not behaviour; the behavioural
    assertion (zero rows in the fact tables after a scan) is integration scenario 11. Reword the AC to "asserted by the integration suite". Scenario 15 (interactive latency under a scheduled
    batch) is evidenced by `test/integration/queue-interactive-pool-isolation.spec.ts` plus the enqueue-option assertion in `visibility-scan.spec.ts`; no end-to-end latency test was written.
14. **Audit.** `@Streaming()` still exempts a route from the AuditInterceptor and the audit-coverage sweep wholesale. A per-route "self-audited" marker would be a new pattern (decorator +
    sweep rule): raised for the owner (see also the `billing-subscription.service.ts` note that streaming is a pattern decision).
