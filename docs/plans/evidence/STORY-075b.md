# STORY-075b evidence

Invoices as a read model, past-due status, `GET /v1/billing/invoices`. Branch `7day/d-billing-3`, base `integration/7day` (2419a21 at start).

Commits: contract `49e728c` · RED `9b1e956` · implementation `28ea168`.

## STATUS: DONE (backend). Frontend table and real-API evidence are outside this lane.

Closed on 2026-10-08 after disk recovered (18 GiB free on /System/Volumes/Data, above the 8 GiB rule). The integration spec was run for the first time and is green: `test/integration/billing-invoices.spec.ts` 29/29, exit 0. Every "S met (29/29 green)" status in the table below is now **met** by that run.

## RED

| Commit | What | Result |
|---|---|---|
| `9b1e956` | `src/lib/billing/stripe/invoice-state.spec.ts` against a missing `invoice-state.ts` | `vitest run` exit 1: "Failed to resolve import ./invoice-state.js", 1 file failed, 0 tests ran (the stated reason) |
| `9b1e956` | `test/integration/billing-invoices.spec.ts` run against the real database with the implementation files of `28ea168` removed (billing.module.ts and stripe-subscription.handler.ts at `9b1e956`) | exit 1: **25 failed, 4 passed** (29). The 4 passes are the cross-tenant/unchanged-behaviour cases that need no new code; the 25 failures are assertion failures: invoice rows absent, no `/billing/invoices` route, workspace status never `past_due` |

After `28ea168`: the unit spec passes, 37 tests.

## Acceptance criteria

| Criterion | Proof | Status |
|---|---|---|
| AC1 (STORY-075 AC9 / scenario 9): each invoice event re-fetches and upserts on `ux_invoices_stripe`, copying total, subtotal, status, hosted URL, PDF URL as issued | U `invoice-state.spec.ts` > "copies number, status, subtotal, total, currency, period, both URLs and paid_at"; S `billing-invoices.spec.ts` > "scenario 9 · an invoice event re-fetches the invoice and records it as Stripe issued it" (asserts `invoice:in_1` was fetched and the event body names only an id); "scenario 9 · successive events for one invoice upsert ONE row on ux_invoices_stripe…"; it.each over the five event types; "uncollectible is a recorded status" | unit met; S met (29/29 green) |
| AC1: a test asserts no local arithmetic produces `total` | U "scenario 9 · the total is Stripe's total even when it is not the subtotal, the lines…" and "…never from amount_due, amount_paid or the line sum"; S "scenario 9 · NO LOCAL ARITHMETIC PRODUCES `total`…". `invoice-state.ts` contains no arithmetic on money: `centsToDecimal` moves the decimal point in a string | unit met; S met (29/29 green) |
| AC1 robustness: redelivery, out-of-order, stale fetch | S "a redelivered event id is a no-op…"; S "a stale fetch cannot walk an invoice backwards…" (held fetch via `holdNextFetch`; `INVOICE_STATUS_RANK` guard); U rank-order test | S met (29/29 green) |
| AC2 (AC10 / scenario 10): a past_due subscription sets the subscription status | already proven in `stripe-subscriptions.spec.ts` (075a, "AUDIT MAJOR (PROBE-C)…" reaches `status: past_due`); S "scenario 10 · a past_due subscription sets the subscription status AND the workspace status" | S met (29/29 green) |
| AC2: the scheduler skips it | The capture scheduler EXISTS in this branch (`src/lib/capture/scheduler.ts`, `w.status IN ('trialing','active')`), so it is asserted, not deferred: `syncWorkspaceBillingStatus` sets `workspaces.status = 'past_due'`. S "scenario 10 · THE SCHEDULER SKIPS A PAST-DUE WORKSPACE and picks it up again once the payment recovers" calls the real `claimDueProjects` | S met (29/29 green) |
| AC2 boundaries: a stronger restriction is never overwritten; subscription ending while past_due | S "a soft_capped / suspended workspace is NOT overwritten"; "a subscription that ends while past_due returns the workspace…"; "a past_due redelivery… one status audit row" | S met (29/29 green) |
| AC3: `GET /billing/invoices` requires `billing:read` | S "GET /billing/invoices is billing:read: owner and admin read, manager and viewer get a 403 naming the permission" (`@RequirePermission("billing:read")`) | S met (29/29 green) |
| AC3: uses a cursor | S "the cursor walks every invoice exactly once, including rows that share a period_start" (full-precision `period_start` + `id` keyset); forged cursor, unknown key, unknown status are 400s (`.strict()` request schema) | S met (29/29 green) |
| AC3: tenant-isolated, RLS-only | S "tenant isolation · the list returns only the caller's invoices" (the query has no `workspace_id` predicate); "as nominara_app, an unfiltered read in A's context sees none of B's rows and cannot write one for B"; "an invoice event for workspace A writes nothing in workspace B" | S met (29/29 green) |
| AC4: every state change writes an audit row | S "every invoice state change writes one audit row (actor_type 'system', the Stripe event id as request_id); an unchanged re-fetch writes none" (`billing.invoice_recorded`, in the webhook transaction, so an audit failure rolls the change back); past-due: `workspace.billing_status_changed` (S above) | S met (29/29 green) |
| Empty state for never-invoiced workspaces (backend half) | S "a workspace never invoiced gets an empty list, not an error, and no next page" | S met (29/29 green) |
| Frontend (BillingSettings invoices table, empty state) | **not done**: the app repo is outside this API lane; the contract it maps to is `invoiceSchema` / `invoiceListResponseSchema` in `contracts/billing/invoice.schema.ts` | not met this week |
| Metric | `nominara_billing_invoice_events_total{outcome}`, `nominara_billing_workspace_status_changes_total{to}` | emitted; the metric assertion is not separate |
| Redacted log | S "the audit row and the log line carry no hosted-invoice URL… and the log names the workspace by id" | S met (29/29 green) |
| Spans | deferred to week 2 by owner decision (2026-10-08) | deferred |
| Real-API evidence | collected in NEW-A-17 (needs a running real API); Stripe is the fake gateway in every test | deferred |

## Decisions and known gaps (for the reviewer)

- `addon_amount` and `credit_pack_amount` are written as `0.00` (their column default). Stripe's invoice carries no breakdown by our product kinds without expanding every line's product, and deriving one locally is the arithmetic this story forbids. A breakdown belongs with STORY-076b (add-ons), which creates the add-on lines. The contract still carries both fields.
- The invoice event list is the five the story names. `invoice.marked_uncollectible` and `invoice.updated` are NOT consumed, so an `uncollectible` status reaches us only on the next consumed event. Adding either is a one-line change to `StripeInvoiceHandler.types`; not done because the story did not name them.
- Zero- and three-decimal currencies (JPY, KWD, …) are refused with a warning rather than mis-stated by a cents-to-decimal move. The product charges in USD.
- Past-due moves only `trialing`/`active` <-> `past_due` on `workspaces.status`; `past_due` stays a usable status for sign-in (`USABLE_STATUSES`) so the owner can reach billing to fix the card.
- No migration, no schema change, no new dependency, no new vocabulary. `db:rls-generate` not applicable (no table touched).

## Gate commands (worktree api-wt-d1)

| Command | Exit | Result |
|---|---|---|
| `pnpm lint` | 0 | clean |
| `pnpm typecheck` | 0 | clean |
| `pnpm test:unit` | 0 | 282 files passed, 1 skipped; 3396 tests passed, 1 skipped (re-run after merge-up 2026-10-08) |
| `pnpm contracts:generate` / `pnpm contracts:check` | 0 / 0 | openapi regenerated (adds `listInvoices`); no drift |
| `vitest run --config vitest.integration.config.ts test/integration/billing-invoices.spec.ts` | 0 | 29 passed |
| same config, `test/integration/stripe-subscriptions.spec.ts` + `stripe-webhook.spec.ts` | 0 | 85 passed |
| `pnpm test:isolation`, `pnpm test:isolation:breakers` | not run | known fixture crash (support_grants TTL), fixed by the d-admin lane; isolation is asserted under `nominara_app` in the integration spec; the merge step runs the suites |
