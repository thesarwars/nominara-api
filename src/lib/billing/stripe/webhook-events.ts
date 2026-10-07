import type { ClientBase } from "pg";

// NEW-D-2 — the de-duplication ledger (migration 0048). Two statements and a
// sweep; the service owns the transaction around them.

/** Stripe stops redelivering well inside this (live mode: up to 3 days). */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;

/**
 * Claims `eventId`. TRUE exactly once for a given id, ever: the primary key
 * serialises concurrent deliveries — the second INSERT waits for the first
 * transaction, then conflicts (or, if the first rolled back, takes the claim).
 *
 * ⚠ THE CALLER MUST RUN THIS INSIDE THE SAME TRANSACTION AS THE EFFECT IT
 * GUARDS. A claim committed on its own, before the effect, is a lost event on a
 * crash between the two: recorded as processed, never applied, and Stripe's
 * retry then deduplicated away.
 */
export async function claimWebhookEvent(tx: ClientBase, eventId: string, type: string): Promise<boolean> {
  const result = await tx.query(
    "INSERT INTO stripe_webhook_events (event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
    [eventId, type],
  );
  return result.rowCount === 1;
}

/** A cheap pre-check that spares the Stripe fetch for an obvious redelivery. NOT the guarantee — `claimWebhookEvent` is. */
export async function webhookEventSeen(client: ClientBase, eventId: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM stripe_webhook_events WHERE event_id = $1", [eventId]);
  return (result.rowCount ?? 0) > 0;
}

/** Deletes ledger rows older than the retention window. Returns how many. */
export async function sweepStripeWebhookEvents(client: ClientBase, now: Date = new Date()): Promise<number> {
  const result = await client.query(
    "DELETE FROM stripe_webhook_events WHERE received_at < $1::timestamptz - make_interval(days => $2)",
    [now, WEBHOOK_EVENT_RETENTION_DAYS],
  );
  return result.rowCount ?? 0;
}
