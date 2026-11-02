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
