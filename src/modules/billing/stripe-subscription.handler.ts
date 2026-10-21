import { Inject, Injectable, Logger } from "@nestjs/common";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { pendingCheckoutSchema } from "../../../contracts/billing/pending-checkout.schema.js";
import { adoptionRef, readPendingPlanChange } from "../../lib/billing/plan-change-intent.js";
import { addonItemsFromSubscription } from "../../lib/billing/stripe/addon-items.js";
import { applyPlanChange, type SubscriptionReconciler } from "../../lib/billing/apply-plan.js";
import { desiredFromStripeSubscription, toCents, type ClaimedPlanPrice } from "../../lib/billing/stripe/subscription-state.js";
import { syncWorkspaceBillingStatus } from "../../lib/billing/workspace-billing-status.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { BillingAddonsService } from "./billing-addons.service.js";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import type { StripeEventContext, StripeEventHandler } from "./stripe-event-handler.js";
import { reconcileAndRecordDowngradePause, sendDowngradeNotices } from "../../lib/billing/downgrade-pause-record.js";
import { EMAIL_SENDER, type EmailSender } from "../identity/ports/email-sender.js";

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

  constructor(
    private readonly addons: BillingAddonsService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async handle({ tx, workspaceId, event, object, fetchStartedAt, afterCommit }: StripeEventContext): Promise<void> {
    // checkout.session.completed is also the credit-pack event (mode=payment,
    // STORY-076a); the service has already followed a subscription-mode
    // session to its subscription, so anything else here is not ours.
    if (object.kind !== "subscription") return;

    // ⚠ THE WORKSPACE LOCK COMES FIRST. The price this subscription is verified
    // against is read from the workspace's `subscriptions` row (its frozen
    // charge, or the intent of the checkout that bought it), and a concurrent
    // adoption writes both; reading them unlocked could compare against the
    // catalog instead and refuse a customer who paid the price they were shown.
    await lockWorkspaceBounded(tx, workspaceId, () => {
      // Nothing is recorded (the claim rolls back with the transaction), so Stripe redelivers the event.
      incrementCounter("nominara_billing_webhook_lock_wait_exceeded_total", {});
      this.logger.warn({ message: "stripe webhook refused as retryable: the workspace is busy with another billing change", event_id: event.id, workspace_id: workspaceId });
      return new DegradedError({ message: "billing is busy: retry shortly" });
    });
    // ⚠ THE STALE-FETCH CHECK COMES BEFORE THE PRICE VERDICT (STORY-184). A fetch taken before a newer event committed
    // describes a subscription as it WAS - for an in-app upgrade, the old plan at the old price with no intent (the intent
    // was spent when the new plan was adopted) - and judged first it reads as a relabel and raises a false mismatch alarm
    // for a customer who did nothing wrong. Stale means "not looked at", so it is skipped before anything is judged.
    // ⚠ A STALE FETCH MUST NOT OVERWRITE A NEWER COMMIT. The fetch is taken
    // outside the transaction (KAD-06), so an event fetched at t1 can commit
    // after one fetched at t2 > t1 for the SAME subscription and put its older
    // state back (a cancelled plan returning to growth, plus a pro-rata grant).
    // The workspace row is the serialiser applyPlanChange also locks first; it
    // was taken above, so the read below is the one the write is ordered by.
    //
    // ⚠ THE MARK IS KEPT PER SUBSCRIPTION, WHETHER OR NOT THE ROW ADOPTS IT.
    // Reading it off the `subscriptions` row only covered the subscription that
    // row already tracked; a NEW subscription that was cancelled before its
    // first event committed left no mark, and the held `active` fetch then
    // resurrected it. `fetchStartedAt` is the DATABASE's clock, so two API
    // instances with skewed wall clocks order their writes consistently.
    const marked = await tx.query<{ fetch_started_at: Date }>(
      "SELECT fetch_started_at FROM stripe_subscription_syncs WHERE workspace_id = $1 AND stripe_subscription_id = $2",
      [workspaceId, object.id],
    );
    const markedAt = marked.rows[0]?.fetch_started_at ?? null;
    if (markedAt !== null && markedAt.getTime() > fetchStartedAt.getTime()) {
      incrementCounter("nominara_billing_subscription_reconcile_total", { outcome: "stale_fetch" });
      this.logger.warn({ message: "stripe subscription fetch is older than the committed state: skipped", event_id: event.id, workspace_id: workspaceId });
      return;
    }
    const claimedPlan = await this.claimedPlanPrice(tx, workspaceId, object.metadata, object.id);
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

    // STORY-075b — a past_due subscription takes the workspace out of the
    // capture scheduler's reach; recovery (or the end of the subscription) puts
    // it back. Idempotent: an unchanged status writes nothing.
    const billingStatus = await syncWorkspaceBillingStatus(tx, workspaceId, { eventId: event.id, eventType: event.type });
    if (billingStatus?.changed === true) {
      incrementCounter("nominara_billing_workspace_status_changes_total", { to: billingStatus.to });
      this.logger.warn({ message: "workspace billing status changed", event_id: event.id, workspace_id: workspaceId, from: billingStatus.from, to: billingStatus.to });
    }

    // STORY-076b — the add-on items of THIS fresh fetch, mirrored wholesale (the
    // only writer of `subscription_addons`). An ended subscription holds none.
    const addonOutcome = await this.addons.reconcile(tx, {
      workspaceId,
      stripeSubscriptionId: desired.state.providerSubscriptionId,
      items: desired.state.planKey === "free" ? [] : addonItemsFromSubscription(object.raw),
      eventId: event.id,
      eventType: event.type,
      versionAlreadyBumped: outcome.changed,
    });

    // STORY-077 slice A — plans-and-entitlements.md §14 at the cut-over: AFTER the plan and the add-ons are adopted (the
    // limits are the resolved ones), in this same transaction. Only when what the workspace is entitled to MOVED (the
    // plan or the add-ons): a redelivery, or a phase-0 event while a downgrade is still pending, changes nothing here, and
    // a workspace that was already over its limits before this slice shipped is not paused by an unrelated event.
    if (outcome.changed || addonOutcome.changed) await this.reconcilePause(tx, workspaceId, event.id, outcome.changed && outcome.from !== outcome.to, afterCommit);

    // The charge this subscription was verified at is frozen on the row, so a
    // later catalog price change cannot turn it into a "mismatch". Only the
    // subscription the row tracks owns it; an ended one clears it.
    await tx.query(
      `UPDATE subscriptions
          SET charged_unit_amount_cents = $3, charged_currency = $4, charged_interval = $5
        WHERE workspace_id = $1 AND stripe_subscription_id = $2 AND status IN ('trialing','active','past_due')
          AND (charged_unit_amount_cents, charged_currency, charged_interval) IS DISTINCT FROM ($3::integer, $4::char(3), $5::text)`,
      [workspaceId, desired.state.providerSubscriptionId, desired.charge?.unitAmountCents ?? null, desired.charge?.currency.toLowerCase() ?? null, desired.charge?.interval ?? null],
    );

    // STORY-184 - the adoption is RECORDED before the intent is spent (an audit row in this transaction, naming the intent's id and
    // the quote's proration date). It is the trace a retry whose reply was lost after the adoption is matched against: "the
    // workspace is already on this plan" is answered as a replay only for the quote of the change that was really adopted.
    const adoptable = await tx.query<{ intent: unknown }>(
      `SELECT pending_plan_change AS intent FROM subscriptions
        WHERE workspace_id = $1 AND stripe_subscription_id = $2 AND status IN ('trialing','active','past_due')
          AND pending_plan_change ->> 'id' = $3 AND pending_plan_change ->> 'to_plan_key' = $4`,
      [workspaceId, desired.state.providerSubscriptionId, object.metadata.plan_change_intent_id ?? "", desired.state.planKey],
    );
    const adopted = readPendingPlanChange(adoptable.rows[0]?.intent);
    if (adopted.kind === "intent") {
      await new AuditChainService().append(tx, {
        workspaceId,
        actorType: "system",
        actorId: SYSTEM_ACTOR_ID,
        actorIp: null,
        actorUa: `operator:${WEBHOOK_OPERATOR}`,
        action: "billing.plan_change.adopted",
        resourceType: "workspace",
        resourceId: workspaceId,
        beforeState: { from_plan_key: adopted.intent.from_plan_key },
        afterState: { intent_ref: adoptionRef(workspaceId, adopted.intent.id), direction: adopted.intent.direction, to_plan_key: adopted.intent.to_plan_key, proration_date: adopted.intent.proration_date },
        requestId: event.id,
        supportGrantId: null,
        severity: "info",
      });
    }

    // STORY-184 — the in-app plan change is spent once its plan is adopted (or the subscription ended). Only THIS
    // subscription's intent, and only when the plan it names is the plan now held AND the subscription names this intent's id: an event that left the row where it was
    // (a phase-0 event while a downgrade is pending) must leave the intent where it is too.
    await tx.query(
      `UPDATE subscriptions SET pending_plan_change = NULL, updated_at = now()
        WHERE workspace_id = $1 AND stripe_subscription_id = $2 AND status IN ('trialing','active','past_due')
          AND pending_plan_change IS NOT NULL
          AND ((pending_plan_change ->> 'to_plan_key' = $3 AND pending_plan_change ->> 'id' = $4) OR $3 = 'free')`,
      [workspaceId, desired.state.providerSubscriptionId, desired.state.planKey, object.metadata.plan_change_intent_id ?? ""],
    );

    // A paid subscription was adopted: the Checkout session that bought it is
    // settled, so a later checkout has nothing to supersede.
    if (desired.state.planKey !== "free") {
      await tx.query(
        `UPDATE subscriptions SET open_checkout_session_id = NULL, pending_checkout = NULL
          WHERE workspace_id = $1 AND status IN ('trialing','active','past_due')
            AND (open_checkout_session_id IS NOT NULL OR pending_checkout IS NOT NULL)`,
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

  /**
   * STORY-077 — pauses the most recently created excess projects and prompts (never deletes), resumes what an earlier
   * downgrade paused once the limits allow it (oldest first), audits each, and emails the list AFTER the commit. The
   * same step `plan:set` runs (downgrade-pause-record.ts).
   */
  private async reconcilePause(tx: StripeEventContext["tx"], workspaceId: string, eventId: string, planChanged: boolean, afterCommit: StripeEventContext["afterCommit"]): Promise<void> {
    const notices = await reconcileAndRecordDowngradePause(tx, workspaceId, { requestId: eventId, operator: WEBHOOK_OPERATOR, planChanged });
    if (notices.length > 0) afterCommit.push(async () => await sendDowngradeNotices((message) => this.email.send(message), workspaceId, notices));
  }

  /**
   * What the subscription's plan item is verified against. The catalog row for
   * the plan its metadata claims, plus, when we hold one, the charge FROZEN for
   * it: first the charge the row recorded when it adopted THIS subscription,
   * else the intent of the checkout that bought it (named by the subscription's
   * own `checkout_intent_id`, and honoured only when it is this workspace's
   * pending intent for this plan). A frozen charge always wins over the catalog,
   * and is only ever used for the plan it was frozen for.
   */
  private async claimedPlanPrice(
    tx: StripeEventContext["tx"],
    workspaceId: string,
    metadata: Readonly<Record<string, string>>,
    subscriptionId: string,
  ): Promise<ClaimedPlanPrice | null> {
    const planKey = metadata.plan_key;
    if (planKey === undefined || planKey.length === 0) return null;
    const result = await tx.query<{ monthly_price: string; annual_price: string; currency: string }>(
      "SELECT monthly_price, annual_price, currency FROM plans WHERE key = $1",
      [planKey],
    );
    const plan = result.rows[0];
    if (plan === undefined) return null;
    const catalog: ClaimedPlanPrice = { monthlyCents: toCents(plan.monthly_price), annualCents: toCents(plan.annual_price), currency: plan.currency };

    const live = await tx.query<{
      plan_key: string;
      provider: string;
      stripe_subscription_id: string;
      charged_unit_amount_cents: number | null;
      charged_currency: string | null;
      charged_interval: "month" | "year" | null;
      pending_checkout: unknown;
      pending_plan_change: unknown;
    }>(
      `SELECT plan_key, provider, stripe_subscription_id, charged_unit_amount_cents, charged_currency, charged_interval, pending_checkout, pending_plan_change
         FROM subscriptions WHERE workspace_id = $1 AND status IN ('trialing','active','past_due')`,
      [workspaceId],
    );
    const row = live.rows[0];
    if (row === undefined) return catalog;

    // ⚠ STORY-184 — A TRACKED SUBSCRIPTION CHANGES PLAN ONLY THROUGH THE WORKSPACE'S OWN INTENT. This row already tracks
    // this very Stripe subscription on a paid plan, and the event claims a DIFFERENT plan. Before the in-app plan change
    // the catalog vouched for any such claim whose price matched it, so a Dashboard edit (the price AND the label moved to
    // another plan's) was adopted as an upgrade nobody had asked the product for. Now the one door is the intent this
    // workspace recorded BEFORE it asked Stripe for the change, and it opens only when all three agree: the intent's id is
    // the one on the subscription's own metadata, the plan it names is the plan claimed, and the subscription is the one the
    // intent was made for. The charge verified is the intent's frozen one (never the catalog's), so a price that is not what
    // the customer was quoted is still refused. Anything else returns null: the caller refuses and ALARMS (a relabel).
    if (row.provider === "stripe" && row.plan_key !== "free" && row.stripe_subscription_id === subscriptionId && planKey !== row.plan_key) {
      const read = readPendingPlanChange(row.pending_plan_change);
      if (
        read.kind === "intent" &&
        read.intent.id === metadata.plan_change_intent_id &&
        read.intent.to_plan_key === planKey &&
        read.intent.stripe_subscription_id === subscriptionId
      ) {
        return {
          ...catalog,
          frozen: { unitAmountCents: read.intent.unit_amount_cents, currency: read.intent.currency, interval: read.intent.billing_interval === "annual" ? "year" : "month" },
        };
      }
      return null;
    }

    if (
      row.stripe_subscription_id === subscriptionId &&
      row.plan_key === planKey &&
      row.charged_unit_amount_cents !== null &&
      row.charged_currency !== null &&
      row.charged_interval !== null
    ) {
      return { ...catalog, frozen: { unitAmountCents: row.charged_unit_amount_cents, currency: row.charged_currency, interval: row.charged_interval } };
    }

    const pending = row.pending_checkout === null || row.pending_checkout === undefined ? undefined : pendingCheckoutSchema.safeParse(row.pending_checkout);
    if (pending?.success === true && pending.data.id === metadata.checkout_intent_id && pending.data.plan_key === planKey) {
      return {
        ...catalog,
        frozen: { unitAmountCents: pending.data.unit_amount_cents, currency: pending.data.currency, interval: pending.data.billing_interval === "annual" ? "year" : "month" },
      };
    }
    return catalog;
  }
}
