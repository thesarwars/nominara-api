import { Injectable, Logger } from "@nestjs/common";
import { applyPlanChange, type SubscriptionReconciler } from "../../lib/billing/apply-plan.js";
import { desiredFromStripeSubscription } from "../../lib/billing/stripe/subscription-state.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import type { StripeEventContext, StripeEventHandler } from "./stripe-event-handler.js";

// STORY-075a / STORY-075 AC4 — the ONLY customer-reachable path to
// `applyPlanChange`, and the one the plan-change-import-surface gate names.
//
// ⚠ WHY THIS IS NOT THE SELF-SERVICE PLAN ROUTE STORY-151 FORBADE. Nothing a
// caller sends reaches this file. It runs only from `StripeWebhookService`,
// after (1) the signature over the raw body verified, (2) the subscription was
// RE-FETCHED from Stripe and (3) the workspace was read from THAT object's
// metadata, which our own Checkout wrote. The plan written is Stripe's current
// state of a subscription that was actually paid for — the old route's flaw was
// that a caller's say-so would have been the input.
//
// ⚠ NEVER A DELTA. The event only says "this subscription changed". The record
// written is `desiredFromStripeSubscription(<fetched>)` in full, so any two
// events delivered in any order leave the same row, and a redelivery is a
// no-op (`applyPlanChange` returns `changed: false` and writes no audit row).

export const WEBHOOK_OPERATOR = "stripe-webhook";

@Injectable()
export class StripeSubscriptionHandler implements StripeEventHandler {
  readonly types = [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ] as const;

  private readonly logger = new Logger(StripeSubscriptionHandler.name);

  async handle({ tx, workspaceId, event, object, fetchStartedAt }: StripeEventContext): Promise<void> {
    // checkout.session.completed is also the credit-pack event (mode=payment,
    // STORY-076a); the service has already followed a subscription-mode
    // session to its subscription, so anything else here is not ours.
    if (object.kind !== "subscription") return;

    const desired = desiredFromStripeSubscription(object.raw, object.metadata);
    if (desired.kind === "ignore") {
      incrementCounter("nominara_billing_subscription_reconcile_total", { outcome: "ignored" });
      this.logger.warn({ message: `stripe subscription not reconciled: ${desired.reason}`, event_id: event.id, workspace_id: workspaceId });
      return;
    }

    // ⚠ A STALE FETCH MUST NOT OVERWRITE A NEWER COMMIT. The fetch is taken
    // outside the transaction (KAD-06), so an event fetched at t1 can commit
    // after one fetched at t2 > t1 for the SAME subscription and put its older
    // state back (a cancelled plan returning to growth, plus a pro-rata grant).
    // The workspace row is the serialiser applyPlanChange also locks first;
    // taking it here makes the read below the one the write is ordered by.
    await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    const synced = await tx.query<{ provider_synced_at: Date | null }>(
      `SELECT provider_synced_at FROM subscriptions
        WHERE workspace_id = $1 AND status IN ('trialing','active','past_due') AND stripe_subscription_id = $2`,
      [workspaceId, desired.state.providerSubscriptionId],
    );
    const syncedAt = synced.rows[0]?.provider_synced_at ?? null;
    if (syncedAt !== null && syncedAt.getTime() > fetchStartedAt.getTime()) {
      incrementCounter("nominara_billing_subscription_reconcile_total", { outcome: "stale_fetch" });
      this.logger.warn({ message: "stripe subscription fetch is older than the committed state: skipped", event_id: event.id, workspace_id: workspaceId });
      return;
    }

    let doubleSubscriptionWith: string | null = null;
    const reconcile: SubscriptionReconciler = (current) => {
      // ⚠ A STALE SUBSCRIPTION MUST NOT UNDO A NEWER ONE. A late event for an
      // old subscription that has since ended fetches as `canceled`, which
      // reconciles to `free` — and would take the plan away from a workspace
      // that has meanwhile bought a new subscription. Only the subscription the
      // row currently tracks may END an entitlement.
      if (desired.state.planKey === "free" && desired.state.providerSubscriptionId !== current.providerSubscriptionId) return current;
      // ⚠ ONE LIVE STRIPE SUBSCRIPTION PER WORKSPACE. The row tracks a paid,
      // still-live Stripe subscription and this event is for a DIFFERENT paid
      // one (a second checkout completed after the first). Overwriting would
      // flip the plan and customer on every event and mint a pro-rata grant on
      // each flip up. The row is kept and the double charge is alarmed.
      if (
        desired.state.planKey !== "free" &&
        current.provider === "stripe" &&
        current.planKey !== "free" &&
        current.providerSubscriptionId.length > 0 &&
        current.providerSubscriptionId !== desired.state.providerSubscriptionId
      ) {
        doubleSubscriptionWith = current.providerSubscriptionId;
        return current;
      }
      return desired.state;
    };

    const outcome = await applyPlanChange(
      tx,
      workspaceId,
      reconcile,
      { requestId: event.id, operator: WEBHOOK_OPERATOR, reason: `stripe ${event.type}` },
      { allowDowngrade: true },
    );

    if (doubleSubscriptionWith !== null) {
      incrementCounter("nominara_billing_double_subscription_total", {});
      this.logger.error({
        message: "workspace has two live stripe subscriptions: the tracked one was kept, the other needs cancelling and refunding",
        event_id: event.id,
        workspace_id: workspaceId,
        tracked_subscription_id: doubleSubscriptionWith,
        other_subscription_id: desired.state.providerSubscriptionId,
      });
      return;
    }

    // Stamp the fetch that produced the row, so an older one cannot undo it.
    await tx.query(
      `UPDATE subscriptions SET provider_synced_at = GREATEST(COALESCE(provider_synced_at, '-infinity'::timestamptz), $3)
        WHERE workspace_id = $1 AND status IN ('trialing','active','past_due') AND stripe_subscription_id = $2`,
      [workspaceId, desired.state.providerSubscriptionId, fetchStartedAt],
    );

    incrementCounter("nominara_billing_subscription_reconcile_total", { outcome: outcome.changed ? "changed" : "unchanged" });
    this.logger.log({
      message: "stripe subscription reconciled",
      event_id: event.id,
      workspace_id: workspaceId,
      changed: outcome.changed,
      from: outcome.from,
      to: outcome.to,
      entitlement_version: outcome.entitlementVersion,
    });
  }
}
