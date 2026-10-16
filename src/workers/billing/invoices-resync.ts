import { fileURLToPath } from "node:url";
import type { ClientBase, Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { connect } from "../../db/client.js";
import { createPgPool } from "../../db/pg-pool.js";
import { desiredFromStripeInvoice } from "../../lib/billing/stripe/invoice-state.js";
import type { StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { StripeHttpGateway } from "../../lib/billing/stripe/stripe-http.gateway.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import { BillingInvoicesService, type InvoiceRecordOutcome } from "../../modules/billing/billing-invoices.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// Migration 0127 / the service-period fix - a ONE-OFF operator re-sync of the invoices already recorded.
//
// A paid invoice is terminal: Stripe never sends another event for it, so a row recorded before the fix keeps the
// invoice-level period ("Oct 15 - Oct 15") forever unless it is fetched again. This fetches every recorded invoice from
// Stripe and records it through BillingInvoicesService.record, the webhook's own write path: same workspace row lock, same
// tenant context, same audit row (`billing.invoice_recorded`, request_id `resync:<stripe invoice id>`).
//
// Idempotent: record() answers `unchanged` for a row already equal to Stripe's, writing nothing, so a re-run (or a run
// that was interrupted) is safe. It only touches invoices that exist locally, so only workspaces that have invoices are
// written to. It never creates an invoice. The Stripe fetch happens OUTSIDE any transaction (KAD-06).
//
// ⚠ A SCRIPT, NOT A PROVIDER: nothing a request can reach imports it.
//
// Usage:   pnpm billing:invoices-resync
// Output:  counts only - never an invoice id, a workspace name, an amount or a URL.

export interface InvoicesResyncCounts {
  readonly scanned: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly stale: number;
  /** Stripe has no such invoice any more, or it is in a shape that cannot be recorded. Nothing was written. */
  readonly skipped: number;
  /** A fetch or write failed (Stripe unavailable, workspace busy). Re-run to retry. */
  readonly failed: number;
}

export interface InvoicesResyncDeps {
  /** Cross-tenant read of (workspace_id, stripe_invoice_id) only; RLS hides the rows from a runtime role. */
  readonly discovery: ClientBase;
  readonly pool: Pool;
  readonly gateway: Pick<StripeGateway, "fetchObject">;
  readonly invoices?: BillingInvoicesService;
}

export async function resyncInvoices(deps: InvoicesResyncDeps): Promise<InvoicesResyncCounts> {
  const invoices = deps.invoices ?? new BillingInvoicesService();
  const found = await deps.discovery.query<{ workspace_id: string; stripe_invoice_id: string }>(
    "SELECT workspace_id, stripe_invoice_id FROM invoices ORDER BY workspace_id, stripe_invoice_id",
  );
  const counts: Record<keyof InvoicesResyncCounts, number> = { scanned: 0, inserted: 0, updated: 0, unchanged: 0, stale: 0, skipped: 0, failed: 0 };
  for (const row of found.rows) {
    counts.scanned += 1;
    try {
      const fetched = await deps.gateway.fetchObject("invoice", row.stripe_invoice_id);
      if (fetched === null) {
        counts.skipped += 1;
        continue;
      }
      const desired = desiredFromStripeInvoice(fetched.raw);
      if (desired.kind === "ignore") {
        counts.skipped += 1;
        continue;
      }
      const client = await deps.pool.connect();
      try {
        const outcome: InvoiceRecordOutcome = await withTenantContext(client, { workspaceId: row.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          await lockWorkspaceBounded(tx, row.workspace_id, () => new Error("workspace busy"));
          return invoices.record(tx, row.workspace_id, desired.invoice, { eventId: `resync:${row.stripe_invoice_id}`, eventType: "operator.invoices_resync" });
        });
        counts[outcome] += 1;
      } finally {
        client.release();
      }
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const gateway = new StripeHttpGateway({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
  if (!gateway.isConfigured()) {
    console.error("Stripe is not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET); nothing was fetched");
    process.exitCode = 1;
    return;
  }
  // Two connections, as credit-reconcile: the owner role for the cross-tenant scan, the runtime role for the writes.
  const discovery = await connect(env.DATABASE_URL);
  const pool = createPgPool(env.DATABASE_URL_POOLED);
  try {
    const counts = await resyncInvoices({ discovery, pool, gateway });
    console.log(JSON.stringify(counts, null, 2));
    if (counts.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
    await discovery.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
