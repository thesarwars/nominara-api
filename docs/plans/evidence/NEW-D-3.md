# NEW-D-3 audit log read — checkpoint-4 evidence (lane 7day/d-billing-5, base integration/7day 74e4b2f)

## Finding
AC3 ("the response never includes prev_hash/row_hash") was not met: `toAuditLogEntry` set `id` to the hex of `row_hash`, so
every item exposed a row hash, and because row N's `prev_hash` is row N-1's `row_hash`, the chain too. The old test
(`AC3: the response never carries hashes, states or the IP`) matched key names only and could not see a hash VALUE.

## Commits
- RED `cf4001c` — `test/integration/audit-log-http.spec.ts` > "AC3 (checkpoint-4): no item id, cursor or other value in the response is any row's row_hash or prev_hash". It reads every `row_hash` and `prev_hash` of the workspace from the database and fails if any hex value appears anywhere in the body of three pages, or if an item id is 64-hex. Run before the fix: 1 failed / 11 passed, the failure being `expected '{"data":[{"id":"a74fafa1...' not to contain '9224afc4...'` (the stated reason).
- contract `2155d62` — `auditLogEntrySchema.id` is `^[0-9]{1,18}$` (the row seq), comment rewritten; `openapi.generated.json` regenerated.
- fix `bd11d30` — `id: row.seq`. Two existing tests encoded the defect and were corrected, not relaxed: unit "AC-redaction" (`entry.id` was asserted to be the hash; it now asserts the seq and that neither hash's hex occurs anywhere in the entry) and the AC2 cross-cursor test (compared ids to B's row hashes; it now compares to B's seqs).

## RED-first, said honestly
The original NEW-D-3 landed tests and implementation together in `e9de8bc`; RED-before-GREEN for the original item cannot be
retro-fitted and is not claimed. What is true: the checkpoint-4 AC3 repair is RED-first (`cf4001c` precedes `bd11d30`). For the
original item, a mutation proof stands in:

| Mutation (applied to `toAuditLogEntry`, reverted after) | Result |
|---|---|
| `id: Buffer.from(row.row_hash).toString("hex")` (the defect) | the new AC3 test fails (this is the RED run above) |
| `id: Buffer.from(row.prev_hash).toString("hex")` (the chain leak by the other end) | 3 failed / 9 passed: AC1 (entry contract), the new AC3 test, and AC4 (ids no longer unique/seq-shaped) |
| `id: row.seq` (the fix) | 12 passed |

## Criteria
| Criterion | Proof |
|---|---|
| AC3 no prev_hash/row_hash, as field or value | integration "AC3 (checkpoint-4): no item id, cursor or other value in the response is any row's row_hash or prev_hash"; "AC3: the response never carries hashes, states or the IP" (key names); unit "AC-redaction: an entry's id is the row seq, and no hash appears..." |
| AC4 cursor opaque, seq-keyed, no skip/repeat | unchanged: "AC4: pages across rows sharing one microsecond timestamp...", "AC4: newest first by seq...". The cursor is base64url of `{v:1,k:[seq]}`, which holds no hash (asserted by the AC3 test, which also walks a cursor). |
| AC2 RLS-only, cross-tenant cursor | unchanged, with the id comparison fixed as above |

## Trade-off for the owner
`seq` is a global sequence, so item ids are monotonic across workspaces. The old schema comment declined to expose it for that
reason (a customer could count it to infer volume). `audit_log` has no uuid column and a schema change is not part of NEW-D-3, so the
lead's instruction (use the row seq) was followed and the comment now records the trade-off. A per-row uuid would be a migration.

## Observability
Unchanged by this fix: `nominara_audit_log_reads_total{outcome}` and a redacted log line (workspace id, row count). Spans deferred to week 2 (R3).

## Gates (api-wt-d1)
`pnpm lint` 0 · `pnpm typecheck` 0 · `pnpm test:unit` 0 (3776 passed, 1 skipped) · `pnpm contracts:check` 0 · `pnpm test:isolation` 0 (13 files / 53 tests) · integration `audit-log-http.spec.ts` 0 (12 tests; the lane's ten billing/audit specs together: 267 tests, exit 0).
