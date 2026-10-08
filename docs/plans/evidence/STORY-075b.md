# STORY-075b evidence

Invoices as a read model, past-due status, `GET /v1/billing/invoices`. Branch `7day/d-billing-3`, base `integration/7day` (2419a21 at start).

Commits: contract `49e728c` · RED `9b1e956` · implementation `28ea168`.

## STATUS: PARTIAL — the integration spec is written and typechecks, but it has NOT been run

`df -h /System/Volumes/Data` showed 5.8 GiB free before the work and 6.5 GiB after (rule: under 8 GiB, do not start testcontainers). So:

- RAN and green: the pure mapper unit spec, lint, typecheck, `contracts:generate`/`contracts:check`, the whole unit suite.
- NOT RUN: `test/integration/billing-invoices.spec.ts` (every criterion's real-database proof below). Its RED state was therefore NOT observed against a database; only the unit spec's RED was (below). To finish: free disk to 8 GiB, then run
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run --config vitest.integration.config.ts test/integration/billing-invoices.spec.ts test/integration/stripe-subscriptions.spec.ts test/integration/stripe-webhook.spec.ts`
  and treat any failure as a defect in the implementation OR the spec (it was written without a database to check it against).

## RED

| Commit | What | Result |
|---|---|---|
| `9b1e956` | `src/lib/billing/stripe/invoice-state.spec.ts` against a missing `invoice-state.ts` | `vitest run` exit 1: "Failed to resolve import ./invoice-state.js", 1 file failed, 0 tests ran (the stated reason) |
| `9b1e956` | `test/integration/billing-invoices.spec.ts` | not run (disk); it imports only existing modules, so its RED would be assertion failures: no invoice handler registered (rows absent, `ignored` outcome), no `/billing/invoices` route (404), workspace status never `past_due` |

After `28ea168`: the unit spec passes, 37 tests.

## Acceptance criteria

| Criterion | Proof | Status |
|---|---|---|
| AC1 (STORY-075 AC9 / scenario 9): each invoice event re-fetches and upserts on `ux_invoices_stripe`, copying total, subtotal, status, hosted URL, PDF URL as issued | U `invoice-state.spec.ts` > "copies number, status, subtotal, total, currency, period, both URLs and paid_at"; S `billing-invoices.spec.ts` > "scenario 9 · an invoice event re-fetches the invoice and records it as Stripe issued it" (asserts `invoice:in_1` was fetched and the event body names only an id); "scenario 9 · successive events for one invoice upsert ONE row on ux_invoices_stripe…"; it.each over the five event types; "uncollectible is a recorded status" | unit met; S written, not run |
| AC1: a test asserts no local arithmetic produces `total` | U "scenario 9 · the total is Stripe's total even when it is not the subtotal, the lines…" and "…never from amount_due, amount_paid or the line sum"; S "scenario 9 · NO LOCAL ARITHMETIC PRODUCES `total`…". `invoice-state.ts` contains no arithmetic on money: `centsToDecimal` moves the decimal point in a string | unit met; S written, not run |
| AC1 robustness: redelivery, out-of-order, stale fetch | S "a redelivered event id is a no-op…"; S "a stale fetch cannot walk an invoice backwards…" (held fetch via `holdNextFetch`; `INVOICE_STATUS_RANK` guard); U rank-order test | S not run |
| AC2 (AC10 / scenario 10): a past_due subscription sets the subscription status | already proven in `stripe-subscriptions.spec.ts` (075a, "AUDIT MAJOR (PROBE-C)…" reaches `status: past_due`); S "scenario 10 · a past_due subscription sets the subscription status AND the workspace status" | S not run |
| AC2: the scheduler skips it | The capture scheduler EXISTS in this branch (`src/lib/capture/scheduler.ts`, `w.status IN ('trialing','active')`), so it is asserted, not deferred: `syncWorkspaceBillingStatus` sets `workspaces.status = 'past_due'`. S "scenario 10 · THE SCHEDULER SKIPS A PAST-DUE WORKSPACE and picks it up again once the payment recovers" calls the real `claimDueProjects` | S written, not run |
| AC2 boundaries: a stronger restriction is never overwritten; subscription ending while past_due | S "a soft_capped / suspended workspace is NOT overwritten"; "a subscription that ends while past_due returns the workspace…"; "a past_due redelivery… one status audit row" | S not run |
| AC3: `GET /billing/invoices` requires `billing:read` | S "GET /billing/invoices is billing:read: owner and admin read, manager and viewer get a 403 naming the permission" (`@RequirePermission("billing:read")`) | S not run |
| AC3: uses a cursor | S "the cursor walks every invoice exactly once, including rows that share a period_start" (full-precision `period_start` + `id` keyset); forged cursor, unknown key, unknown status are 400s (`.strict()` request schema) | S not run |
| AC3: tenant-isolated, RLS-only | S "tenant isolation · the list returns only the caller's invoices" (the query has no `workspace_id` predicate); "as nominara_app, an unfiltered read in A's context sees none of B's rows and cannot write one for B"; "an invoice event for workspace A writes nothing in workspace B" | S not run |
| AC4: every state change writes an audit row | S "every invoice state change writes one audit row (actor_type 'system', the Stripe event id as request_id); an unchanged re-fetch writes none" (`billing.invoice_recorded`, in the webhook transaction, so an audit failure rolls the change back); past-due: `workspace.billing_status_changed` (S above) | S not run |
| Empty state for never-invoiced workspaces (backend half) | S "a workspace never invoiced gets an empty list, not an error, and no next page" | S not run |
| Frontend (BillingSettings invoices table, empty state) | **not done**: the app repo is outside this API lane; the contract it maps to is `invoiceSchema` / `invoiceListResponseSchema` in `contracts/billing/invoice.schema.ts` | not met this week |
| Metric | `nominara_billing_invoice_events_total{outcome}`, `nominara_billing_workspace_status_changes_total{to}` | emitted; the metric assertion is not separate |
| Redacted log | S "the audit row and the log line carry no hosted-invoice URL… and the log names the workspace by id" | S not run |
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
| `pnpm test:unit` | 0 | 278 files passed, 1 skipped; 3350 tests passed, 1 skipped (was 3313; +37 from this story) |
| `pnpm contracts:generate` / `pnpm contracts:check` | 0 / 0 | openapi regenerated (adds `listInvoices`); no drift |
| `vitest run --config vitest.integration.config.ts test/integration/billing-invoices.spec.ts` | not run | disk 6.5 GiB free < 8 GiB |
| `pnpm test:isolation`, `pnpm test:isolation:breakers` | not run | known fixture crash (support_grants TTL), fixed by the d-admin lane; isolation is asserted under `nominara_app` in the integration spec; the merge step runs the suites |
