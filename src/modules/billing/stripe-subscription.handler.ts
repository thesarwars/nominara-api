import { Injectable, Logger } from "@nestjs/common";
import { applyPlanChange, type SubscriptionReconciler } from "../../lib/billing/apply-plan.js";
import { desiredFromStripeSubscription, toCents, type ClaimedPlanPrice } from "../../lib/billing/stripe/subscription-state.js";
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

    const claimedPlan = await this.claimedPlanPrice(tx, object.metadata.plan_key);
    const desired = desiredFromStripeSubscription(object.raw, object.metadata, claimedPlan);
    if (desired.kind === "ignore") {
      if (desired.mismatch === true) {
        // ⚠ ALARM, NOT A SHRUG. A customer may be paying for a plan they are
        // not being given (a portal price switch), or the other way round.
        incrementCounter("nominara_billing_plan_price_mismatch_total", {});
        this.logger.error({
          message: "stripe subscription price does not match its claimed plan: not reconciled",
          event_id: event.id,
          workspace_id: workspaceId,
          subscription_id: object.id,
          claimed_plan_key: object.metadata.plan_key ?? null,
        });
      } else {
        this.logger.warn({ message: `stripe subscription not reconciled: ${desired.reason}`, event_id: event.id, workspace_id: workspaceId });
      }
      incrementCounter("nominara_billing_subscription_reconcile_total", { outcome: desired.mismatch === true ? "price_mismatch" : "ignored" });
      return;
    }

    // ⚠ A STALE FETCH MUST NOT OVERWRITE A NEWER COMMIT. The fetch is taken
    // outside the transaction (KAD-06), so an event fetched at t1 can commit
    // after one fetched at t2 > t1 for the SAME subscription and put its older
    // state back (a cancelled plan returning to growth, plus a pro-rata grant).
    // The workspace row is the serialiser applyPlanChange also locks first;
    // taking it here makes the read below the one the write is ordered by.
    //
    // ⚠ THE MARK IS KEPT PER SUBSCRIPTION, WHETHER OR NOT THE ROW ADOPTS IT.
    // Reading it off the `subscriptions` row only covered the subscription that
    // row already tracked; a NEW subscription that was cancelled before its
    // first event committed left no mark, and the held `active` fetch then
    // resurrected it. `fetchStartedAt` is the DATABASE's clock, so two API
    // instances with skewed wall clocks order their writes consistently.
    await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    const marked = await tx.query<{ fetch_started_at: Date }>(
      "SELECT fetch_started_at FROM stripe_subscription_syncs WHERE workspace_id = $1 AND stripe_subscription_id = $2",
      [workspaceId, desired.state.providerSubscriptionId],
    );
    const markedAt = marked.rows[0]?.fetch_started_at ?? null;
    if (markedAt !== null && markedAt.getTime() > fetchStartedAt.getTime()) {
      incrementCounter("nominara_billing_subscription_reconcile_total", { outcome: "stale_fetch" });
      this.logger.warn({ message: "stripe subscription fetch is older than the committed state: skipped", event_id: event.id, workspace_id: workspaceId });
      return;
    }
    await tx.query(
      `INSERT INTO stripe_subscription_syncs (workspace_id, stripe_subscription_id, fetch_started_at) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, stripe_subscription_id) DO UPDATE SET fetch_started_at = GREATEST(stripe_subscription_syncs.fetch_started_at, EXCLUDED.fetch_started_at)`,
      [workspaceId, desired.state.providerSubscriptionId, fetchStartedAt],
    );

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

    // A paid subscription was adopted: the Checkout session that bought it is
    // settled, so a later checkout has nothing to supersede.
    if (desired.state.planKey !== "free") {
      await tx.query(
        "UPDATE subscriptions SET open_checkout_session_id = NULL WHERE workspace_id = $1 AND status IN ('trialing','active','past_due') AND open_checkout_session_id IS NOT NULL",
        [workspaceId],
      );
    }

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

  /** The catalog price of the plan a subscription's metadata claims, or null when there is no such plan. */
  private async claimedPlanPrice(tx: StripeEventContext["tx"], planKey: string | undefined): Promise<ClaimedPlanPrice | null> {
    if (planKey === undefined || planKey.length === 0) return null;
    const result = await tx.query<{ monthly_price: string; annual_price: string; currency: string }>(
      "SELECT monthly_price, annual_price, currency FROM plans WHERE key = $1",
      [planKey],
    );
    const plan = result.rows[0];
    if (plan === undefined) return null;
    return { monthlyCents: toCents(plan.monthly_price), annualCents: toCents(plan.annual_price), currency: plan.currency };
  }
}
