import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { Invoice, InvoiceListQuery } from "../../../contracts/billing/index.js";
import { ValidationFailedError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import { INVOICE_STATUS_RANK, type DesiredInvoice, type InvoiceStatus } from "../../lib/billing/stripe/invoice-state.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";

// STORY-075b — the one owner of `invoices`: the webhook's write side and
// `GET /v1/billing/invoices`'s read side.
//
// ⚠ A READ MODEL. Every figure written here is one Stripe issued, copied by
// `desiredFromStripeInvoice`; nothing in this file adds, multiplies or rounds.

export type InvoiceRecordOutcome = "inserted" | "updated" | "unchanged" | "stale";

interface StoredInvoice {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  subtotal: string;
  total: string;
  addon_amount: string;
  credit_pack_amount: string;
  currency: string;
  period_start: Date;
  period_end: Date;
  due_at: Date | null;
  hosted_invoice_url: string | null;
  pdf_url: string | null;
  paid_at: Date | null;
}

interface InvoiceRow {
  id: string;
  number: string | null;
  status: Invoice["status"];
  subtotal: string;
  addon_amount: string;
  credit_pack_amount: string;
  total: string;
  currency: string;
  hosted_invoice_url: string | null;
  pdf_url: string | null;
  period_start: string;
  period_end: string;
  paid_at: string | null;
  /** The cursor's own columns: full (microsecond) precision, which the published ones are not. */
  period_start_key: string;
}

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function same(stored: StoredInvoice, desired: DesiredInvoice): boolean {
  return (
    stored.number === desired.number &&
    stored.status === desired.status &&
    stored.subtotal === desired.subtotal &&
    stored.total === desired.total &&
    stored.addon_amount === desired.addonAmount &&
    stored.credit_pack_amount === desired.creditPackAmount &&
    stored.currency === desired.currency &&
    stored.period_start.getTime() === desired.periodStart.getTime() &&
    stored.period_end.getTime() === desired.periodEnd.getTime() &&
    stored.due_at?.getTime() === desired.dueAt.getTime() &&
    stored.hosted_invoice_url === desired.hostedInvoiceUrl &&
    stored.pdf_url === desired.pdfUrl &&
    (stored.paid_at?.getTime() ?? null) === (desired.paidAt?.getTime() ?? null)
  );
}

/** What an audit row says about an invoice. No URLs: a hosted-invoice link is a bearer link to pay. */
function auditState(invoice: { status: string; total: string; currency: string; number: string | null }, stripeInvoiceId: string) {
  return { stripe_invoice_id: stripeInvoiceId, number: invoice.number, status: invoice.status, total: invoice.total, currency: invoice.currency };
}

@Injectable()
export class BillingInvoicesService {
  /**
   * Upserts one invoice on `ux_invoices_stripe` inside the webhook's tenant-
   * context transaction, writing Stripe's CURRENT record wholesale. The caller
   * holds the workspace row lock, which serialises two events for one invoice.
   *
   * ⚠ A WRITE WHOSE STATUS RANKS BELOW THE RECORDED ONE IS STALE. The fetch is
   * taken outside the transaction (KAD-06), so an event fetched while the
   * invoice was `open` can commit after one fetched when it was `paid`, and
   * would put the older state back. Invoices only move forward.
   */
  async record(
    tx: ClientBase,
    workspaceId: string,
    desired: DesiredInvoice,
    provenance: { readonly eventId: string; readonly eventType: string },
  ): Promise<InvoiceRecordOutcome> {
    const existing = await tx.query<StoredInvoice>(
      `SELECT id, number, status, subtotal::text, total::text, addon_amount::text, credit_pack_amount::text, currency, period_start, period_end, due_at, hosted_invoice_url, pdf_url, paid_at
         FROM invoices WHERE stripe_invoice_id = $1 FOR UPDATE`,
      [desired.stripeInvoiceId],
    );
    const stored = existing.rows[0];

    let invoiceId: string;
    let outcome: InvoiceRecordOutcome;
    if (stored === undefined) {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO invoices (workspace_id, stripe_invoice_id, number, status, subtotal, total, addon_amount, credit_pack_amount, currency, period_start, period_end, due_at, hosted_invoice_url, pdf_url, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [
          workspaceId,
          desired.stripeInvoiceId,
          desired.number,
          desired.status,
          desired.subtotal,
          desired.total,
          desired.addonAmount,
          desired.creditPackAmount,
          desired.currency,
          desired.periodStart,
          desired.periodEnd,
          desired.dueAt,
          desired.hostedInvoiceUrl,
          desired.pdfUrl,
          desired.paidAt,
        ],
      );
      invoiceId = inserted.rows[0]!.id;
      outcome = "inserted";
    } else if (INVOICE_STATUS_RANK[stored.status] > INVOICE_STATUS_RANK[desired.status]) {
      return "stale";
    } else if (same(stored, desired)) {
      return "unchanged";
    } else {
      invoiceId = stored.id;
      await tx.query(
        `UPDATE invoices SET number = $2, status = $3, subtotal = $4, total = $5, addon_amount = $6, credit_pack_amount = $7, currency = $8,
                period_start = $9, period_end = $10, due_at = $11, hosted_invoice_url = $12, pdf_url = $13, paid_at = $14
          WHERE id = $1`,
        [
          invoiceId,
          desired.number,
          desired.status,
          desired.subtotal,
          desired.total,
          desired.addonAmount,
          desired.creditPackAmount,
          desired.currency,
          desired.periodStart,
          desired.periodEnd,
          desired.dueAt,
          desired.hostedInvoiceUrl,
          desired.pdfUrl,
          desired.paidAt,
        ],
      );
      outcome = "updated";
    }

    // Inside the same transaction: an invoice change with no audit row rolls back.
    await new AuditChainService().append(tx, {
      workspaceId,
      actorType: "system",
      actorId: SYSTEM_ACTOR_ID,
      actorIp: null,
      actorUa: "operator:stripe-webhook",
      action: "billing.invoice_recorded",
      resourceType: "invoice",
      resourceId: invoiceId,
      beforeState: stored === undefined ? null : auditState(stored, desired.stripeInvoiceId),
      afterState: { ...auditState(desired, desired.stripeInvoiceId), event_type: provenance.eventType },
      requestId: provenance.eventId,
      supportGrantId: null,
      severity: "info",
    });
    return outcome;
  }

  /**
   * STORY-021 / EC-15 — "no past-due invoice" before a workspace may change owner. Decision 2026-10-13: past due is ANY
   * unpaid invoice past its due date: an `open` or `uncollectible` invoice, with no `paid_at`, whose `due_at` has passed.
   * `due_at` is Stripe's `due_date`, else the invoice-level period end (about when it was issued). It is NOT `period_end`,
   * which is the service period the invoice pays for and ends a month after a first invoice is issued. Rows written before
   * `due_at` existed hold the old invoice-level end in `period_end` and are backfilled; `coalesce` covers any still null. RLS scopes the read to the context's workspace; no workspace predicate.
   */
  async hasPastDue(client: ClientBase): Promise<boolean> {
    const result = await client.query<{ past_due: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM invoices
          WHERE paid_at IS NULL AND status IN ('open', 'uncollectible') AND coalesce(due_at, period_end) < now()
       ) AS past_due`,
    );
    return result.rows[0]!.past_due;
  }

  /**
   * `GET /v1/billing/invoices` — newest billing period first, `id` breaking ties.
   *
   * ⚠ NO `workspace_id` PREDICATE, ON PURPOSE: RLS scopes this to the context's
   * workspace (see `readLedgerPage`, whose reasoning applies unchanged). The
   * cursor's key is the FULL-PRECISION `period_start`, not the published one,
   * for the reason that note records: a millisecond-truncated key drops rows.
   */
  async list(query: InvoiceListQuery): Promise<Page<Invoice>> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("BillingInvoicesService requires an active tenant context");
    const after = query.cursor === undefined ? undefined : cursorKeyOf(query.cursor);

    const result = await store.client.query<InvoiceRow>(
      `SELECT id, number, status, subtotal::text, addon_amount::text, credit_pack_amount::text, total::text, currency,
              hosted_invoice_url, pdf_url,
              to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS period_start,
              to_char(period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS period_end,
              to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS paid_at,
              to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS period_start_key
         FROM invoices
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::timestamptz IS NULL OR (period_start, id) < ($2::timestamptz, $3::uuid))
        ORDER BY period_start DESC, id DESC
        LIMIT $4`,
      [query.status ?? null, after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    return pageFrom(result.rows, query.limit, "billing.invoices", toInvoice, (row) => [row.period_start_key, row.id]);
  }
}

function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    subtotal: row.subtotal,
    addon_amount: row.addon_amount,
    credit_pack_amount: row.credit_pack_amount,
    total: row.total,
    currency: row.currency,
    period_start: row.period_start,
    period_end: row.period_end,
    hosted_invoice_url: row.hosted_invoice_url,
    pdf_url: row.pdf_url,
    paid_at: row.paid_at,
  };
}

function cursorKeyOf(cursor: string): [string, string] {
  const key = decodeCursor(cursor, "billing.invoices", 2);
  const [periodStart, id] = key;
  if (typeof periodStart !== "string" || !ISO_MICROS.test(periodStart) || typeof id !== "string" || !UUID.test(id)) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor was not issued for this list" }] },
    });
  }
  return [periodStart, id];
}
