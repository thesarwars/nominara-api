import { fileURLToPath } from "node:url";
import type { ClientBase, Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { connect } from "../../db/client.js";
import { createPgPool } from "../../db/pg-pool.js";
import { desiredFromStripeInvoice } from "../../lib/billing/stripe/invoice-state.js";
import { StripeUpstreamError, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { StripeHttpGateway } from "../../lib/billing/stripe/stripe-http.gateway.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import { BillingInvoicesService } from "../../modules/billing/billing-invoices.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// Migration 0127 / the service-period fix - a ONE-OFF operator re-sync of the invoices already recorded.
//
// A paid invoice is terminal: Stripe never sends another event for it, so a row recorded before the fix keeps the
// invoice-level period ("Oct 15 - Oct 15") forever unless it is fetched again. This fetches every recorded invoice from
// Stripe and records it through BillingInvoicesService.record.
//
// WHAT IS THE SAME AS THE WEBHOOK'S WRITE: the invoice -> row mapping (`desiredFromStripeInvoice`), the upsert and its
// unchanged / stale rules (`record`), the workspace row lock (`lockWorkspaceBounded`), the tenant context on the runtime
// role (RLS in force), and the hash-chained audit row `billing.invoice_recorded`, written in the same transaction.
// WHAT IS DIFFERENT: it is not driven by an event, so there is no claimed webhook-event row and no event id. Its audit row
// carries the operator (`actorUa` = `operator:invoices-resync:<operator>`) and the ticket (`request_id`); it re-fetches by
// the stored Stripe invoice id and checks that Stripe's own workspace metadata names the workspace the row belongs to
// (the webhook resolves the workspace FROM that metadata; here the row is the authority, so a disagreement is refused);
// and it never inserts - a row that vanished between the scan and the write is reported, not recreated.
//
// Idempotent: record() answers `unchanged` for a row already equal to Stripe's, writing nothing, so a re-run (or a run
// that was interrupted) is safe. It only touches invoices that exist locally, in workspaces that are not soft-deleted.
// The Stripe fetch happens OUTSIDE any transaction (KAD-06).
//
// NO ADVISORY LOCK IS NEEDED. Two concurrent runs (or a run racing a webhook) serialise on the workspace row lock that
// every write takes, and the loser reads the winner's row under `FOR UPDATE` and finds it `unchanged` (or `stale`).
// Unlike credit-reconcile there is no non-idempotent step for a second copy to double.
//
// ⚠ A SCRIPT, NOT A PROVIDER: nothing a request can reach imports it.
//
// ⚠ NEEDS A SESSION THAT SEES ACROSS TENANTS. `invoices` is FORCE ROW LEVEL SECURITY, so a NOSUPERUSER, NOBYPASSRLS
// `DATABASE_URL` (the production nominara_owner) sees ZERO rows and a scan would "succeed" having looked at nothing. The
// command checks the role first and refuses (exit 1) rather than report that.
//
// Usage:   pnpm billing:invoices-resync --operator <who> --ticket <ref>
// Output:  counts only - never an invoice id, a workspace id or name, an amount or a URL.

export interface InvoicesResyncCounts {
  readonly scanned: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly stale: number;
  /** Stripe has no such invoice any more, or it is in a shape that cannot be recorded. Nothing was written. */
  readonly skipped: number;
  /** Stripe's workspace metadata is missing or names a different workspace than the row. Nothing was written. */
  readonly mismatched: number;
  /** record() would have INSERTED (the row disappeared after the scan). The transaction was rolled back. */
  readonly unexpected_insert: number;
  /** Total failed, and by cause. Re-run to retry. */
  readonly failed: number;
  readonly failed_stripe_upstream: number;
  readonly failed_lock_timeout: number;
  readonly failed_db: number;
  readonly failed_other: number;
}

export interface InvoicesResyncDeps {
  /** Cross-tenant read of (workspace_id, stripe_invoice_id) only. Must be a session RLS does not hide rows from. */
  readonly discovery: ClientBase;
  readonly pool: Pool;
  readonly gateway: Pick<StripeGateway, "fetchObject">;
  readonly operator: string;
  readonly ticket: string;
  readonly invoices?: BillingInvoicesService;
}

export class ResyncUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResyncUsageError";
  }
}

export class CrossTenantVisibilityError extends Error {
  constructor() {
    super(
      "refusing to scan: the discovery connection (DATABASE_URL) is subject to row level security on `invoices` " +
        "(NOSUPERUSER, NOBYPASSRLS, and the table is FORCE ROW LEVEL SECURITY), so it would see zero rows and report success. " +
        "Run with a DATABASE_URL for a role that bypasses RLS (a superuser or BYPASSRLS role)",
    );
    this.name = "CrossTenantVisibilityError";
  }
}

class LockTimeoutError extends Error {}
class UnexpectedInsertError extends Error {}

/** `--operator` and `--ticket` are both mandatory: they land on a hash-chained audit row, as plan:set's do. */
export function parseResyncArgs(argv: readonly string[]): { operator: string; ticket: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ResyncUsageError(`${token} needs a value`);
    flags.set(token.slice(2), value);
    i += 1;
  }
  const missing = ["operator", "ticket"].filter((name) => (flags.get(name) ?? "").trim() === "");
  if (missing.length > 0) throw new ResyncUsageError(`missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);
  return { operator: flags.get("operator")!, ticket: flags.get("ticket")! };
}

/**
 * FORCE ROW LEVEL SECURITY subjects even the table's owner to the policies, so the only sessions that see every tenant's
 * rows are a superuser or a BYPASSRLS role - or the owner of a table that is NOT forced (never `invoices`; checked anyway).
 */
export async function assertCrossTenantVisibility(discovery: ClientBase): Promise<void> {
  const result = await discovery.query<{ visible: boolean }>(
    `SELECT (r.rolsuper OR r.rolbypassrls OR (c.relowner = r.oid AND NOT c.relforcerowsecurity)) AS visible
       FROM pg_roles r, pg_class c
      WHERE r.rolname = current_user AND c.oid = 'public.invoices'::regclass`,
  );
  if (result.rows[0]?.visible !== true) throw new CrossTenantVisibilityError();
}

type FailureClass = "failed_stripe_upstream" | "failed_lock_timeout" | "failed_db" | "failed_other";

function classify(error: unknown): FailureClass {
  if (error instanceof StripeUpstreamError) return "failed_stripe_upstream";
  if (error instanceof LockTimeoutError) return "failed_lock_timeout";
  // A node-postgres error carries a five-character SQLSTATE.
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return "failed_db";
  return "failed_other";
}

export async function resyncInvoices(deps: InvoicesResyncDeps): Promise<InvoicesResyncCounts> {
  await assertCrossTenantVisibility(deps.discovery);
  const invoices = deps.invoices ?? new BillingInvoicesService();
  const found = await deps.discovery.query<{ workspace_id: string; stripe_invoice_id: string }>(
    `SELECT i.workspace_id, i.stripe_invoice_id
       FROM invoices i JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
      ORDER BY i.workspace_id, i.stripe_invoice_id`,
  );
  const counts: Record<keyof InvoicesResyncCounts, number> = {
    scanned: 0, updated: 0, unchanged: 0, stale: 0, skipped: 0, mismatched: 0, unexpected_insert: 0,
    failed: 0, failed_stripe_upstream: 0, failed_lock_timeout: 0, failed_db: 0, failed_other: 0,
  };
  for (const row of found.rows) {
    counts.scanned += 1;
    try {
      const fetched = await deps.gateway.fetchObject("invoice", row.stripe_invoice_id);
      if (fetched === null) {
        counts.skipped += 1;
        continue;
      }
      // The row is the authority for which workspace this is; Stripe must agree. An invoice whose metadata names another
      // workspace (or none) is never written into this one.
      if (fetched.metadata.workspace_id !== row.workspace_id) {
        counts.mismatched += 1;
        continue;
      }
      const desired = desiredFromStripeInvoice(fetched.raw);
      if (desired.kind === "ignore") {
        counts.skipped += 1;
        continue;
      }
      const client = await deps.pool.connect();
      try {
        const outcome = await withTenantContext(client, { workspaceId: row.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          await lockWorkspaceBounded(tx, row.workspace_id, () => new LockTimeoutError("workspace busy"));
          const recorded = await invoices.record(tx, row.workspace_id, desired.invoice, {
            eventId: deps.ticket,
            // Short on purpose: redactState masks a 20+ character label.
            eventType: "resync",
            actorUa: `operator:invoices-resync:${deps.operator}`,
          });
          // The scan saw this row, so an INSERT means it was deleted since. Roll back rather than recreate it.
          if (recorded === "inserted") throw new UnexpectedInsertError("row vanished after the scan");
          return recorded;
        });
        counts[outcome] += 1;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof UnexpectedInsertError) {
        counts.unexpected_insert += 1;
        continue;
      }
      counts.failed += 1;
      counts[classify(error)] += 1;
    }
  }
  return counts;
}

/** The only thing printed: the counts. */
export function formatCounts(counts: InvoicesResyncCounts): string {
  return JSON.stringify(counts, null, 2);
}

async function main(): Promise<void> {
  try {
    const { operator, ticket } = parseResyncArgs(process.argv.slice(2));
    const env = loadEnv();
    const gateway = new StripeHttpGateway({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET });
    if (!gateway.isConfigured()) throw new ResyncUsageError("Stripe is not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET); nothing was fetched");
    // Two connections, as credit-reconcile: a cross-tenant one for the scan, the runtime role for the writes.
    const discovery = await connect(env.DATABASE_URL);
    const pool = createPgPool(env.DATABASE_URL_POOLED);
    try {
      const counts = await resyncInvoices({ discovery, pool, gateway, operator, ticket });
      console.log(formatCounts(counts));
      if (counts.failed > 0) process.exitCode = 1;
    } finally {
      await pool.end();
      await discovery.end();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
