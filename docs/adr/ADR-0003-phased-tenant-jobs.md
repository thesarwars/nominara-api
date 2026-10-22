# ADR-0003 — Phased tenant jobs: a short transaction, a run with none, a short transaction

**Status:** Accepted 2026-10-22 (owner instruction; architect confirmed, subject to the revisions recorded below, which this text carries).

## Context

NFR-ARCH-04 (`system-architecture.md` §1): "No handler holds a database transaction open across an `await` on an external service."
(KAD-06 is the narrower rule that nothing expensive runs on the request path; `crawl.audit` already met it, because its request
handler only enqueues. The sentence quoted here is NFR-ARCH-04. This ADR reads "handler" in it as covering JOB handlers too, which
is stricter than the reference's wording and is the reading this repository adopts.)

`createJobProcessor` opened the tenant transaction BEFORE it called the handler, so a handler that fetches had no way to end it.
`crawl.audit` fetched site files, up to 25 pages twice, rendered them and wrote objects to the store inside that one transaction:
with the `crawl` group at concurrency 3, up to three pooled connections could each sit inside an open transaction for 10 to 15
minutes. The wall-clock budget and a transaction-local `idle_in_transaction_session_timeout` bounded the hold; they did not remove it.

## Decision

A tenant-scoped job may be PHASED (`phasedProcessor` in `src/lib/queue/worker-factory.ts`):

1. `prepare(tx)` runs in ONE short tenant transaction. It reads what the job needs and may end the job (`PHASES_DONE`).
2. `run(prepared)` runs with **no transaction and no client of its own**. It receives only what `prepare` returned.
3. `commit(tx, prepared, fetched)` runs in a SECOND short tenant transaction in the same workspace and writes the result.

What keeps `run` from reading tenant data is NOT that it has nothing to read with: the handler closure holds `context.pool`, so
code in `run` could open a connection. What stops it is that a connection opened outside `withTenantJob` carries no tenant
context, so RLS (which fails closed without one) returns no rows, the query guard refuses it, and each phased handler carries its
own test that no transaction or checked-out client exists during an outbound await (for `crawl.audit`,
`test/integration/crawl-audit-kad06.spec.ts`). This is a convention enforced by tests, not a structural impossibility.

Unchanged and still first: the signature is verified before any client is acquired, and both transactions set the tenant context
from that verified payload with `set_config(..., true)`. A phased processor on a queue that is not tenant-scoped is refused at
construction. An ordinary `JobProcessor` is untouched. Calling a phased processor as a plain function composes the three phases on
the one client it is handed, which is the ONE-transaction shape: fine for handler specs, and it must not appear in a production
path. A registry-level test (`queue-handler-registry.spec.ts`) asserts that the registered `crawl.audit` handler is phased, so a
silent fallback to the composed shape is caught.

Idempotency under at-least-once delivery becomes the handler's, because two deliveries can now be inside `run` at once. For
`crawl.audit`:

- `prepare` skips an audit that already finished (no request is made).
- `commit` first re-checks and locks the project (`SELECT ... FROM projects WHERE id = $1 AND deleted_at IS NULL FOR NO KEY
  UPDATE`): it writes nothing for a project soft-deleted during `run`, and it serialises the reconciliation of two audits of one
  project (the second waits, then reads the first's findings, instead of failing on `ux_aux_findings_fp` and re-crawling on every
  retry).
- `commit` then claims the audit row with `INSERT ... ON CONFLICT (id) DO NOTHING`, locks it, and writes nothing when another
  delivery finished first. The audit row is no longer inserted before the crawl, so a job that fails in `run` leaves no row at all.
- **Every delivery stores under its own run id.** `prepare` mints a UUIDv7 run id and every object (page copies and the manifest)
  is keyed `crawl/{env}/{workspace_id}/{audit_id}/{run_id}/...`. A duplicate delivery therefore cannot overwrite the winner's
  stored copies or manifest. The winning `commit` writes ITS prefix to `aux_audits.dom_object_prefix`; a losing prefix is an
  orphan. The tenant prefix is unchanged, so ISO-14 is unaffected. Test: the last-writer-wins store in `crawl-audit-kad06.spec.ts`.

The object store is bound to the workspace in `prepare` (`TenantObjectStore.bind()` reads the workspace id, does no I/O), which is
the pattern that class documents; the bound writer works in `run` with no context and cannot be retargeted.

## Consequences

- A worker slot is still held for the length of the crawl (bounded by `CRAWL_WALL_CLOCK_BUDGET_MS`); a database connection and a
  transaction are not. The test that proves it is `test/integration/crawl-audit-kad06.spec.ts`: no `idle in transaction` backend and
  no checked-out client during any fetch, render or object-store write.
- **Orphaned objects are unbounded until STORY-003.** There is NO retention sweep by prefix. The real bound is the `crawl/`
  lifecycle rule in `system-architecture.md`'s retention table (14 d to GLACIER_IR, 90 d hard delete), which belongs to
  `nominara-infra` (STORY-003) and is not built. Until it lands, orphans accumulate: a job that exhausts its retries, the prefix of
  a duplicate delivery that lost the race (R1), every earlier attempt of a retried audit, and a `run` that outlives a project's or
  a workspace's deletion and writes after a prefix purge. They sit inside the tenant's own prefix, so nothing is exposed; the cost
  is storage.
- **Politeness across deliveries is weaker than before.** Concurrent deliveries (a stalled job redelivered while the first still
  runs) and two audits of one project can now crawl the same host at once, and each holds its own `PolitenessBudget`, so together
  they can exceed the reference's 2 requests per second per host (`aux-and-geo-analysis.md` §1). The per-target-host limiter in
  `system-architecture.md` §4 "Global controls" (a BullMQ rate limiter plus a Valkey token bucket) closes this; it is not built.
  Until it is, the per-audit budget is the only control.
- **Current violators of NFR-ARCH-04 (not changed by this ADR; each needs a follow-up story):**
  - `billing.auto_topup` and `billing.customer_email` hold an idle job transaction AND a second pooled connection across a Stripe
    call.
  - `source.verify_presence` holds a job transaction across its fetch.
  - `crawl.discover` holds a job transaction across its fetches.
  All four can adopt `phasedProcessor`; the billing two also need their second connection removed. Until then the claim "no
  handler holds a transaction across an external await" is false for them, and only `crawl.audit` is proven by test.
- Rejected: accepting the single-transaction shape with a named follow-up (it leaves the exposure and the follow-up never lands);
  opening the transaction inside the handler (it would make the handler the thing that sets tenant context, which is
  `createJobProcessor`'s job and the reason ISO-11 exists).
