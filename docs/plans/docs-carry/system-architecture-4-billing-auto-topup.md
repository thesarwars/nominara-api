# system-architecture.md section 4 — one added queue row (carry to the docs repo)

NEW-D-7 / owner decision 4 of 2026-10-08. Section 4's table has no queue for the auto top-up charge. Add, after `source.verify_presence`:

| Queue | Producer | Worker group | Concurrency | Retry | Priority | Idempotency key | Tenant-scoped |
|---|---|---|---|---|---|---|---|
| `billing.auto_topup` | credit interceptor, after a debit leaves the balance below the auto-top-up threshold | rollup | 2 | 2x exp (2s, 4s) | 3 | `autotopup:{workspace}:{yyyy_mm_dd_hh_mm}` | yes (signed) |

The payload carries `workspaceId` and `kid` only. The charge is never made on a request path.
