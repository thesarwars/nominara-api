# ADR-0003 — Phased tenant jobs: a short transaction, a run with none, a short transaction

**Status:** Accepted on the owner's instruction of 2026-10-22 (KAD-06 for `crawl.audit`). The architect should confirm or reject.

## Context

KAD-06: no request handler, and no worker, holds a database transaction (and the pooled connection under it) open across an
`await` on an external service. `createJobProcessor` opened the tenant transaction BEFORE it called the handler, so a handler
that fetches had no way to end it. `crawl.audit` fetched site files, up to 25 pages twice, rendered them and wrote objects to the
store inside that one transaction: with the `crawl` group at concurrency 3, up to three pooled connections could each sit inside an
open transaction for 10 to 15 minutes. The wall-clock budget and a transaction-local `idle_in_transaction_session_timeout` bounded
the hold; they did not remove it.

## Decision

A tenant-scoped job may be PHASED (`phasedProcessor` in `src/lib/queue/worker-factory.ts`):

1. `prepare(tx)` runs in ONE short tenant transaction. It reads what the job needs and may end the job (`PHASES_DONE`).
2. `run(prepared)` runs with **no transaction and no client**. It receives only what `prepare` returned. It cannot read tenant
   data, because it has nothing to read with.
3. `commit(tx, prepared, fetched)` runs in a SECOND short tenant transaction in the same workspace and writes the result.

Unchanged and still first: the signature is verified before any client is acquired, and both transactions set the tenant context
from that verified payload with `set_config(..., true)`. A phased processor on a queue that is not tenant-scoped is refused at
construction. An ordinary `JobProcessor` is untouched; a phased one called as a plain function composes the three phases on the one
client it is handed, which keeps handler specs working.

Idempotency under at-least-once delivery becomes the handler's, because two deliveries can now be inside `run` at once. For
`crawl.audit`: `prepare` skips an audit that already finished (no request is made); `commit` claims the audit row with
`INSERT ... ON CONFLICT (id) DO NOTHING`, then locks it, and writes nothing when another delivery finished first. The audit row is
no longer inserted before the crawl, so a job that fails in `run` leaves no row at all (there is no orphan `running` row); its
retry starts clean. Stored page copies are keyed under the audit id and overwritten by the retry; a job that exhausts its retries
leaves orphaned objects under its own `crawl/{env}/{workspace_id}/{audit_id}/` prefix, for a retention sweep by prefix.

The object store is bound to the workspace in `prepare` (`TenantObjectStore.bind()` reads the workspace id, does no I/O), which is
the pattern that class documents; the bound writer works in `run` with no context and cannot be retargeted.

## Consequences

- A worker slot is still held for the length of the crawl (bounded by `CRAWL_WALL_CLOCK_BUDGET_MS`); a database connection and a
  transaction are not. The test that proves it is `test/integration/crawl-audit-kad06.spec.ts`: no `idle in transaction` backend and
  no checked-out client during any fetch, render or object-store write.
- Other handlers that fetch (for example `crawl.discover`, `source.verify_presence`) can adopt the same shape; none is changed here.
- Rejected: accepting the single-transaction shape with a named follow-up (it leaves the exposure and the follow-up never lands);
  opening the transaction inside the handler (it would make the handler the thing that sets tenant context, which is
  `createJobProcessor`'s job and the reason ISO-11 exists).
