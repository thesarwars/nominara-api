-- Invoices keep the SERVICE period in period_start / period_end (the period the customer is paying for, taken from the
-- plan line), so "when did this fall due" needs its own column. Until now period_end doubled as the due date, and it was
-- the invoice-level end Stripe sets (about when the invoice was issued). With period_end now the service end, an unpaid
-- first invoice would only count as past due a month late, so BillingInvoicesService.hasPastDue reads coalesce(due_at, period_end).
--
--   due_at  timestamptz  NULL  Stripe's due_date, else the invoice-level period end; NULL only where never recorded
--
-- EXPAND phase: one nullable column, metadata-only. BACKFILL: every existing row holds the invoice-level end in period_end
-- (that is what the old code stored), which is exactly the due proxy past-due used, so due_at = period_end keeps every
-- existing invoice's past-due answer unchanged. Their displayed period is NOT corrected by this file or by a webhook (a paid invoice is terminal and Stripe never redelivers it): run
-- `pnpm billing:invoices-resync` once after deploying, which re-fetches every recorded invoice through the normal write path.
ALTER TABLE invoices ADD COLUMN due_at timestamptz;

-- FORCE ROW LEVEL SECURITY: invoices is ENABLE + FORCE (0006) with policies only TO nominara_app / nominara_worker /
-- nominara_report. In production nominara_owner (NOSUPERUSER, NOBYPASSRLS; README G-4) runs this file, and under FORCE even
-- the owner is subject to the policies, which it matches none of: the UPDATE would touch zero rows, silently. (The local
-- superuser bypasses RLS and hides this.) Same pattern as 0124/0126: FORCE is lifted for the backfill and restored straight
-- after, in this one transaction, so no other session ever sees the table unforced.
ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY;

UPDATE invoices SET due_at = period_end WHERE due_at IS NULL;

ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

-- The unforced window above must have closed. If the table is not FORCE ROW LEVEL SECURITY here, fail the whole migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.invoices'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'invoices must be ENABLE + FORCE ROW LEVEL SECURITY after 0127';
  END IF;
END
$$;
