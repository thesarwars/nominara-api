import { Inject, Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool } from "pg";
import {
  type PendingPlanChange,
  type PlanChangeCancelResponse,
  type PlanChangePreviewRequest,
  type PlanChangePreviewResponse,
  type PlanChangeQuote,
  type PlanChangeRequest,
  type PlanChangeResponse,
} from "../../../contracts/billing/plan-change.schema.js";
import { entitlementOverridesSchema } from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import { ConflictError, DegradedError, PreconditionUnmetError, ValidationFailedError, type DomainError } from "../../api/errors/domain-errors.js";
import type { Entitlement, EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { computeDowngradeExcess, readExcessUsage, splitAddons, type DowngradeExcess } from "../../lib/billing/downgrade-excess.js";
import { readPendingPlanChange } from "../../lib/billing/plan-change-intent.js";
import { proRataTopUp, utcMidnight } from "../../lib/billing/plan-grant.js";
import { isDefiniteRejection } from "../../lib/billing/stripe/definite-rejection.js";
import { centsToDecimal } from "../../lib/billing/stripe/invoice-state.js";
import { addonLinesOf, periodStartOf, planItemsOf, type PlanItem } from "../../lib/billing/stripe/plan-item.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type PlanPrice, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import type { AddonQuantities } from "../../lib/entitlements/resolution.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { BILLING_WRITE_POOL, inBillingWriteTransaction } from "./billing-write-pool.js";

// STORY-184 — the in-app paid plan change on an EXISTING Stripe subscription.
//
// ⚠ NOTHING HERE WRITES A PLAN, and this file never imports `applyPlanChange` (STORY-151's absence property,
// test/unit/billing/plan-change-import-surface.spec.ts, is unchanged). Every route asks Stripe to change the
// subscription and answers `pending`; the plan, the entitlement version and the wallet change only when the
// signature-verified webhook reconciles the FRESHLY FETCHED subscription (StripeSubscriptionHandler), which is where
// `applyPlanChange` already pro-rates an upgrade and rolls to the target grant at a downgrade's cut-over.
//
// ⚠ THE INTENT IS COMMITTED BEFORE STRIPE IS ASKED, on its own connection of the billing write pool (the checkout and
// add-on precedent). The webhook for the change can arrive before this request commits, and it verifies the
// subscription's NEW price against that intent: an intent that existed only in the request's transaction would make a
// perfectly legitimate change look like a Dashboard relabel and be refused. A definite Stripe rejection (a decline)
// clears it; an ambiguous failure keeps it, so a retry replays the SAME call under the SAME Stripe key and never charges
// twice.
//
// ⚠ AN UPGRADE IS CHARGED NOW AND ATOMICALLY WITH THE UPDATE (`always_invoice` + `error_if_incomplete`): a decline or a
// 3-D Secure requirement leaves the subscription exactly as it was (422 payment_failed). The amount the customer saw is
// ECHOED: the change re-previews at the quote's own `proration_date` and refuses (409 quote_changed) a different figure,
// and the date itself is bounded so nobody can choose an instant near the period end to pay little while the wallet is
// topped up from "now".
//
// ⚠ A DOWNGRADE IS REFUSED UNTIL USAGE IS REDUCED (owner decision 2026-10-16), with the exact list. TEMPORARY: the
// STORY-077 pause machinery does not exist. A move to Free is a cancellation and is never a plan change here.
//
// ⚠ ONE KNOWN DEVIATION, THE SAME AS CHECKOUT'S AND THE ADD-ONS': the request's transaction is open (and holds the
// workspace row lock) while Stripe answers. Each call is bounded at 10 s by the gateway.

const tracer = trace.getTracer("nominara-api");

/** A quote older than this is stale: the customer is asked to look again. */
const QUOTE_MAX_AGE_SECONDS = 30 * 60;
/** Clock skew tolerated for a quote from "the future". */
const QUOTE_MAX_FUTURE_SECONDS = 60;
/** An unsettled intent younger than this may still be in flight in a request that died; it blocks a DIFFERENT change. */
const UNSETTLED_INTENT_RECENT_MS = 10 * 60 * 1000;
/** Stripe forgets an idempotency key after this long: an unsettled intent older than it can no longer be replayed. */
const INTENT_RETENTION_MS = 24 * 60 * 60 * 1000;

interface SubscriptionRow {
  plan_key: string;
  status: string;
  provider: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  pending_plan_change: unknown;
  current_sort_order: number;
  current_credits: number;
  current_entitlements: Record<string, Entitlement>;
}

interface TargetRow {
  key: string;
  display_name: string;
  monthly_price: string;
  annual_price: string;
  currency: string;
  credits_per_cycle: number;
  sort_order: number;
  entitlements: Record<string, Entitlement>;
}

type Direction = "upgrade" | "downgrade";

interface Context {
  readonly client: ClientBase;
  readonly workspaceId: string;
  readonly sub: SubscriptionRow;
  readonly target: TargetRow;
  readonly direction: Direction;
  /** The request names the plan the workspace is already on (only ever allowed through, for a retry whose change has already been applied). */
  readonly sameAsCurrent: boolean;
}

interface Fresh {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, string>>;
  readonly planItem: PlanItem;
  readonly interval: "month" | "year";
  readonly billingInterval: "monthly" | "annual";
  /** When Stripe says the current period began (unix seconds), or null; the local row lags the webhook. */
  readonly periodStart: number | null;
}

@Injectable()
export class PlanChangeService {
  private readonly logger = new Logger(PlanChangeService.name);

  constructor(
    @Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway,
    @Inject(BILLING_WRITE_POOL) private readonly pool: Pool,
  ) {}

  /** `POST /v1/billing/subscription/change/preview` — describes the change; charges and writes nothing. */
  async preview(request: PlanChangePreviewRequest): Promise<PlanChangePreviewResponse> {
    return await this.traced("billing.plan_change.preview", async () => {
      const { client, workspaceId } = this.tenant();
      const ctx = await this.context(client, workspaceId, request.plan_key);
      const { target, direction, sub } = ctx;
      const toFree = target.key === "free";
      // Free is described, not refused: the confirmation can still say what a cancellation would cost (the change route points at the portal).
      if (!toFree) this.refuseByState(ctx);
      const fresh = await this.fetchFresh(ctx);
      if (!toFree) {
        // The pending change is reported before a schedule is (a pending downgrade OWNS the schedule): plan_change_pending, not change_scheduled.
        const pending = readPendingPlanChange(sub.pending_plan_change);
        if (pending.kind === "malformed") throw this.malformed(workspaceId, direction);
        // A change of UNKNOWN outcome (an upgrade whose reply was lost) does not block a re-preview: the customer needs one to retry.
        if (pending.kind === "intent" && (pending.intent.settled_at !== undefined || pending.intent.direction === "downgrade")) {
          this.refused(direction, "plan_change_pending");
          throw new ConflictError({ message: "a plan change is already pending on this subscription: cancel it or wait for it to be confirmed", details: { reason: "plan_change_pending" } });
        }
        await this.refuseScheduled(ctx, fresh, false);
      }

      const topUp = direction === "upgrade" ? await this.estimateTopUp(client, workspaceId, sub, target) : 0;
      const creditEstimate = { basis: "estimate" as const, top_up_now: topUp, grant_at_next_cycle: target.credits_per_cycle };
      const currency = target.currency.trim();

      if (direction === "upgrade") {
        const prorationDate = Math.floor(Date.now() / 1000);
        const quoted = await this.quote(ctx, fresh, prorationDate);
        this.outcome(direction, "previewed");
        return {
          direction,
          current_plan_key: sub.plan_key,
          target_plan_key: target.key,
          billing_interval: fresh.billingInterval,
          effective: "immediate",
          effective_at: null,
          amount_due_now: quoted.amount_due_now,
          currency: quoted.currency,
          quote: quoted,
          credit_estimate: creditEstimate,
          purchased_credits_kept: true,
          exceeds: [],
          blocked_by: null,
        };
      }

      const excess = await this.excessFor(ctx);
      this.outcome(direction, "previewed");
      return {
        direction,
        current_plan_key: sub.plan_key,
        target_plan_key: target.key,
        billing_interval: fresh.billingInterval,
        effective: "period_end",
        effective_at: sub.current_period_end.toISOString(),
        // A downgrade charges nothing: it is a schedule with no proration.
        amount_due_now: "0.00",
        currency,
        quote: null,
        credit_estimate: creditEstimate,
        purchased_credits_kept: true,
        exceeds: excess.all,
        blocked_by: toFree ? "cancel_in_portal" : excess.blocking.length > 0 ? "exceeds_limits" : null,
      };
    });
  }

  /** `POST /v1/billing/subscription/change` — upgrade now, or schedule a downgrade for the period end. */
  async change(request: PlanChangeRequest): Promise<PlanChangeResponse> {
    return await this.traced("billing.plan_change.change", async () => {
      const { client, workspaceId } = this.tenant();
      const ctx = await this.context(client, workspaceId, request.plan_key, true);
      const { target, direction } = ctx;

      // A move to Free is a cancellation at period end, done in the portal; it is never blocked by usage (owner decision).
      if (target.key === "free") {
        this.refused(direction, "cancel_in_portal");
        throw new PreconditionUnmetError({
          message: "moving to Free is a cancellation: cancel the subscription in the billing portal (it ends at the period end)",
          details: { reason: "cancel_in_portal" },
        });
      }
      if (direction === "upgrade" && request.quote === undefined) {
        this.refused(direction, "quote_missing");
        throw new ValidationFailedError({ message: "an upgrade needs the quote from the preview", details: { issues: [{ path: ["quote"], message: "required for an upgrade" }] } });
      }

      await this.lockWorkspace(client, workspaceId, direction);
      // Re-read under the lock: a concurrent change has recorded its intent by now.
      const locked = await this.context(client, workspaceId, request.plan_key, true);
      if (!locked.sameAsCurrent) this.refuseByState(locked);
      const fresh = await this.fetchFresh(locked);
      if (locked.sameAsCurrent) return await this.alreadyApplied(locked, fresh, request);

      const replay = await this.existingIntent(locked, fresh, request);
      // A REPLAY is the same change retried after a lost reply: its own schedule (a downgrade's) is already on the
      // subscription, and that must not read as "someone else's change is scheduled".
      if (replay === null) await this.refuseScheduled(locked, fresh);
      if (direction === "upgrade") return await this.upgrade(locked, fresh, request.quote!, replay);
      return await this.downgrade(locked, fresh, replay);
    });
  }

  /**
   * The request names the plan the workspace is on NOW. Normally that is a 400 (nothing to change). The exception is a RETRY
   * of an upgrade whose reply was lost AFTER the webhook adopted it: the intent is spent, so the trace is the audit row the
   * webhook wrote when it adopted the change (`billing.plan_change.adopted`: the intent's id and the quote's proration date).
   * The retry is answered like the original, without any call, ONLY when the subscription still carries that intent's id AND
   * the request's quote is the one for that very change (same proration date). Any other request for the plan the workspace
   * is on is the 400 it always was.
   */
  private async alreadyApplied(ctx: Context, fresh: Fresh, request: PlanChangeRequest): Promise<PlanChangeResponse> {
    const quote = request.quote;
    const intentId = fresh.metadata.plan_change_intent_id;
    if (quote !== undefined && intentId !== undefined && fresh.metadata.plan_key === ctx.target.key) {
      const trace = await ctx.client.query(
        `SELECT 1 FROM audit_log
          WHERE workspace_id = $1 AND action = 'billing.plan_change.adopted'
            AND after_state ->> 'intent_id' = $2 AND after_state ->> 'to_plan_key' = $3 AND after_state ->> 'proration_date' = $4
          LIMIT 1`,
        [ctx.workspaceId, intentId, ctx.target.key, String(quote.proration_date)],
      );
      if ((trace.rowCount ?? 0) > 0) {
        this.outcome("upgrade", "replayed_adopted");
        return { status: "pending", direction: "upgrade", target_plan_key: ctx.target.key, effective: "immediate", effective_at: null };
      }
    }
    this.refused("upgrade", "already_on_plan");
    throw new ValidationFailedError({ message: "the workspace is already on this plan", details: { issues: [{ path: ["plan_key"], message: "already on this plan" }] } });
  }

  /** `DELETE /v1/billing/subscription/change` — cancels a scheduled downgrade. */
  async cancel(): Promise<PlanChangeCancelResponse> {
    return await this.traced("billing.plan_change.cancel", async () => {
      this.requireConfigured();
      const { client, workspaceId } = this.tenant();
      await this.lockWorkspace(client, workspaceId, "downgrade");
      const sub = await this.subscriptionRow(client, workspaceId);
      const read = readPendingPlanChange(sub.pending_plan_change);
      if (read.kind === "malformed") throw this.malformed(workspaceId, "downgrade");
      if (read.kind === "none") {
        this.outcome("downgrade", "cancel_not_pending");
        throw new ConflictError({ message: "no plan change is pending", details: { reason: "plan_change_not_pending" } });
      }
      const intent = read.intent;
      if (intent.direction !== "downgrade") {
        // An upgrade is charged and applied by Stripe at once; there is nothing to cancel, only a webhook to wait for.
        this.outcome("upgrade", "cancel_refused_upgrade");
        throw new ConflictError({ message: "the upgrade has already been charged and cannot be cancelled: it applies as soon as Stripe confirms it", details: { reason: "plan_change_pending" } });
      }

      try {
        const fetched = await this.gateway.fetchObject("subscription", sub.stripe_subscription_id);
        if (fetched === null) throw new PreconditionUnmetError({ message: "the payment provider has no such subscription" });
        // ⚠ "EFFECTIVE" IS READ FROM THE SUBSCRIPTION, never from the schedule. A schedule that is released, canceled or
        // missing says nothing about whether the downgrade RAN (a Dashboard release, or the lost reply of our own release,
        // look the same as a completed one). The subscription does: once phase 1 has started its metadata is phase 1's,
        // naming this intent and the target plan. Effective -> keep the intent (the webhook adopts it) and say so.
        const effective = (candidate: { readonly metadata: Readonly<Record<string, string>> }): boolean =>
          candidate.metadata.plan_change_intent_id === intent.id && candidate.metadata.plan_key === intent.to_plan_key;
        if (effective(fetched)) throw this.alreadyEffective();

        const rawSchedule = (fetched.raw as { schedule?: unknown }).schedule;
        const scheduleId = intent.schedule_id ?? (typeof rawSchedule === "string" ? rawSchedule : isRecordWithId(rawSchedule) ? rawSchedule.id : null);
        if (scheduleId !== null) {
          await this.gateway.releasePlanDowngrade({ scheduleId, idempotencyKey: `plan-change-cancel-${intent.id}` });
          // The boundary race: Stripe may have started phase 1 between our read and the release. Read the subscription AGAIN
          // and apply the same rule; a released or missing schedule on a subscription that does not carry the intent is a
          // successful cancel.
          const after = await this.gateway.fetchObject("subscription", sub.stripe_subscription_id);
          if (after !== null && effective(after)) throw this.alreadyEffective();
        }
        await this.clearIntent(workspaceId, intent.id);
        this.outcome("downgrade", "cancelled");
        this.logger.log({ message: "scheduled downgrade cancelled", workspace_id: workspaceId, to_plan_key: intent.to_plan_key });
        return { status: "cancelled", target_plan_key: intent.to_plan_key };
      } catch (error) {
        throw this.upstream(error, "downgrade");
      }
    });
  }

  // ---- upgrade ------------------------------------------------------------------------------------------------

  private async upgrade(ctx: Context, fresh: Fresh, quote: PlanChangeQuote, replay: PendingPlanChange | null): Promise<PlanChangeResponse> {
    const { workspaceId, sub, target } = ctx;
    let intent: PendingPlanChange;
    if (replay !== null) {
      // A retry of an upgrade whose outcome was lost: the SAME call under the SAME Stripe key (Stripe answers from its own
      // record), never a fresh quote, so a charge that was taken is not taken again.
      intent = replay;
    } else {
      const nowSeconds = Math.floor(Date.now() / 1000);
      // The period start is STRIPE'S (fresh): a renewal the webhook has not applied yet would leave the local row a period behind.
      const periodStart = fresh.periodStart ?? Math.floor(sub.current_period_start.getTime() / 1000);
      // ⚠ THE PRORATION INSTANT IS THE SERVER'S TO BOUND. Stripe prices the credit for the unused time and the charge for
      // the new plan from this instant, while the wallet is topped up pro rata from "now": an instant near the period end
      // would make the upgrade almost free and the top-up whole.
      if (quote.proration_date < nowSeconds - QUOTE_MAX_AGE_SECONDS || quote.proration_date > nowSeconds + QUOTE_MAX_FUTURE_SECONDS || quote.proration_date < periodStart) {
        throw this.quoteChanged("stale");
      }
      const requote = await this.quote(ctx, fresh, quote.proration_date);
      if (requote.amount_due_now !== quote.amount_due_now || requote.currency !== quote.currency) {
        throw this.quoteChanged("amount_differs");
      }
      const id = uuidV7();
      intent = {
        id,
        direction: "upgrade",
        from_plan_key: sub.plan_key,
        to_plan_key: target.key,
        billing_interval: fresh.billingInterval,
        unit_amount_cents: this.unitAmountCents(target, fresh),
        currency: target.currency.trim(),
        effective: "immediate",
        effective_at: null,
        stripe_subscription_id: sub.stripe_subscription_id,
        stripe_idempotency_key: `plan-change-${id}`,
        proration_date: quote.proration_date,
        amount_due_now_cents: toCents(requote.amount_due_now),
        schedule_id: null,
        created_at: new Date().toISOString(),
      };
      // Committed BEFORE Stripe: from here the webhook can recognise the change it is about to see.
      await this.writeIntent(workspaceId, intent);
    }

    try {
      const result = await this.gateway.applyPlanUpgrade({
        subscriptionId: sub.stripe_subscription_id,
        planItemId: fresh.planItem.itemId,
        target: this.planPrice(target, intent),
        prorationDate: intent.proration_date!,
        metadata: { plan_key: intent.to_plan_key, billing_interval: intent.billing_interval, plan_change_intent_id: intent.id },
        idempotencyKey: intent.stripe_idempotency_key,
      });
      if (result.outcome === "payment_failed") {
        // Stripe applied NOTHING: the intent goes, so the webhook cannot mistake a later event for this change.
        await this.clearIntent(workspaceId, intent.id);
        this.outcome("upgrade", "payment_failed");
        this.logger.warn({ message: "plan upgrade payment failed; nothing changed", workspace_id: workspaceId, to_plan_key: target.key });
        throw new PreconditionUnmetError({
          message: "the payment for this upgrade did not go through (the card was declined or needs authentication); your plan has not changed",
          details: { reason: "payment_failed" },
        });
      }
      await this.settleIntent(workspaceId, { ...intent, settled_at: new Date().toISOString() });
      this.outcome("upgrade", "requested");
      this.logger.log({ message: "plan upgrade requested", workspace_id: workspaceId, from_plan_key: sub.plan_key, to_plan_key: target.key });
      return { status: "pending", direction: "upgrade", target_plan_key: target.key, effective: "immediate", effective_at: null };
    } catch (error) {
      if (error instanceof StripeUpstreamError && isDefiniteRejection(error)) await this.clearIntent(workspaceId, intent.id);
      throw this.upstream(error, "upgrade");
    }
  }

  // ---- downgrade ----------------------------------------------------------------------------------------------

  private async downgrade(ctx: Context, fresh: Fresh, replay: PendingPlanChange | null): Promise<PlanChangeResponse> {
    const { workspaceId, sub, target } = ctx;
    if (replay === null) {
      // ⚠ REFUSED UNTIL USAGE IS REDUCED (owner decision 2026-10-16, Q3 = refuse), before any Stripe call and any write.
      const excess = await this.excessFor(ctx);
      if (excess.blocking.length > 0) {
        this.outcome("downgrade", "exceeds_limits");
        this.logger.warn({ message: "plan downgrade refused: usage exceeds the target plan's limits", workspace_id: workspaceId, to_plan_key: target.key, excess_entries: excess.blocking.length });
        throw new ConflictError({
          message: `usage is above ${target.display_name}'s limits: reduce it first (${excess.blocking.length} limit${excess.blocking.length === 1 ? "" : "s"} exceeded)`,
          details: { reason: "downgrade_exceeds_limits", excess: excess.blocking },
        });
      }
    }

    let intent: PendingPlanChange;
    if (replay !== null) {
      intent = replay;
    } else {
      const id = uuidV7();
      intent = {
        id,
        direction: "downgrade",
        from_plan_key: sub.plan_key,
        to_plan_key: target.key,
        billing_interval: fresh.billingInterval,
        unit_amount_cents: this.unitAmountCents(target, fresh),
        currency: target.currency.trim(),
        effective: "period_end",
        effective_at: sub.current_period_end.toISOString(),
        stripe_subscription_id: sub.stripe_subscription_id,
        stripe_idempotency_key: `plan-change-${id}`,
        proration_date: null,
        amount_due_now_cents: null,
        schedule_id: null,
        created_at: new Date().toISOString(),
      };
      await this.writeIntent(workspaceId, intent);
    }

    // The add-on lines that survive the move, as Stripe holds them NOW: an add-on the target plan does not allow is dropped
    // at the cut-over (and was named in the preview).
    const keepKinds = new Set<string>(Object.keys(splitAddons(target.entitlements, this.heldFrom(fresh.raw)).surviving));
    const keepAddons = addonLinesOf(fresh.raw)
      .filter((line) => keepKinds.has(line.kind))
      .map((line) => ({ priceId: line.priceId, quantity: line.quantity }));

    try {
      const scheduled = await this.gateway.schedulePlanDowngrade({
        subscriptionId: sub.stripe_subscription_id,
        target: this.planPrice(target, intent),
        keepAddons,
        // Phase 1 replaces the subscription's metadata at the cut-over: the subscription's own, with the new plan and the intent.
        metadata: { ...fresh.metadata, plan_key: intent.to_plan_key, billing_interval: intent.billing_interval, plan_change_intent_id: intent.id },
        idempotencyKey: intent.stripe_idempotency_key,
      });
      await this.settleIntent(workspaceId, { ...intent, schedule_id: scheduled.scheduleId, settled_at: new Date().toISOString() });
      this.outcome("downgrade", "requested");
      this.logger.log({ message: "plan downgrade scheduled for the period end", workspace_id: workspaceId, from_plan_key: sub.plan_key, to_plan_key: target.key });
      return { status: "pending", direction: "downgrade", target_plan_key: target.key, effective: "period_end", effective_at: intent.effective_at };
    } catch (error) {
      if (error instanceof StripeUpstreamError && isDefiniteRejection(error)) await this.clearIntent(workspaceId, intent.id);
      throw this.upstream(error, "downgrade");
    }
  }

  // ---- shared -------------------------------------------------------------------------------------------------

  /** Loads the plans and the live subscription, and refuses what no state can change: an unknown, contract-priced or current target. */
  private async context(client: ClientBase, workspaceId: string, planKey: string, allowCurrent = false): Promise<Context> {
    this.requireConfigured();
    const targetRows = await client.query<TargetRow>(
      "SELECT key, display_name, monthly_price, annual_price, currency, credits_per_cycle, sort_order, entitlements FROM plans WHERE key = $1",
      [planKey],
    );
    const target = targetRows.rows[0];
    if (target === undefined) {
      throw new ValidationFailedError({ message: "unknown plan", details: { issues: [{ path: ["plan_key"], message: "no such plan" }] } });
    }
    // Enterprise is priced by contract (checkout refuses it for the same reason).
    if (target.key === "enterprise") {
      throw new ValidationFailedError({ message: "this plan cannot be selected here", details: { issues: [{ path: ["plan_key"], message: "contract-priced: contact sales" }] } });
    }
    const sub = await this.subscriptionRow(client, workspaceId);
    if (target.key === sub.plan_key && !allowCurrent) {
      throw new ValidationFailedError({ message: "the workspace is already on this plan", details: { issues: [{ path: ["plan_key"], message: "already on this plan" }] } });
    }
    // `>=`: equal sort orders only happen when the target IS the current plan (sameAsCurrent), which is never a downgrade. It is
    // given "upgrade" because the only request allowed to name the current plan is the retry of an upgrade (see alreadyApplied).
    const direction: Direction = target.sort_order >= sub.current_sort_order ? "upgrade" : "downgrade";
    return { client, workspaceId, sub, target, direction, sameAsCurrent: target.key === sub.plan_key };
  }

  private async subscriptionRow(client: ClientBase, workspaceId: string): Promise<SubscriptionRow> {
    const result = await client.query<SubscriptionRow>(
      `SELECT s.plan_key, s.status, s.provider, s.stripe_customer_id, s.stripe_subscription_id, s.current_period_start, s.current_period_end,
              s.cancel_at_period_end, s.pending_plan_change,
              p.sort_order AS current_sort_order, p.credits_per_cycle AS current_credits, p.entitlements AS current_entitlements
         FROM subscriptions s JOIN plans p ON p.key = s.plan_key
        WHERE s.workspace_id = $1 AND s.status IN ('trialing','active','past_due')`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined || row.provider !== "stripe" || row.stripe_subscription_id.length === 0 || row.plan_key === "free") {
      throw new PreconditionUnmetError({ message: "this workspace has no paid billing subscription to change: start one first" });
    }
    return row;
  }

  /** The states no change can start from. `past_due` first: a customer who owes money does not get a bigger plan on credit. */
  private refuseByState(ctx: Context): void {
    const { sub, direction } = ctx;
    if (sub.status === "past_due") {
      this.refused(direction, "subscription_past_due");
      throw new ConflictError({ message: "the subscription has an unpaid invoice: pay it before changing plan", details: { reason: "subscription_past_due" } });
    }
    if (sub.cancel_at_period_end) {
      this.refused(direction, "cancellation_pending");
      throw new ConflictError({ message: "the subscription is set to cancel at the period end: resume it in the billing portal before changing plan", details: { reason: "cancellation_pending" } });
    }
  }

  /**
   * A schedule on the subscription blocks a change, EXCEPT one with nothing left to do: a downgrade that took effect stays
   * attached for the whole of its last phase (a billing cycle), and refusing every change for a cycle after a customer's own
   * downgrade would be a lockout. Such a schedule is released first (the subscription does not change), then the change goes on.
   */
  private async refuseScheduled(ctx: Context, fresh: Fresh, release = true): Promise<void> {
    const schedule = (fresh.raw as { schedule?: unknown }).schedule;
    if (schedule === null || schedule === undefined) return;
    try {
      const finished = await this.gateway.releaseFinishedSchedule({
        subscriptionId: ctx.sub.stripe_subscription_id,
        expectedPlanKey: fresh.metadata.plan_key,
        idempotencyKey: `finished-schedule-${typeof schedule === "string" ? schedule : isRecordWithId(schedule) ? schedule.id : ctx.sub.stripe_subscription_id}`,
        // A PREVIEW only looks: it must change nothing at Stripe, so a finished schedule is treated as non-blocking WITHOUT releasing it.
        // The change (and the add-on paths) release it when they actually go ahead.
        dryRun: !release,
      });
      if (finished.released || (!release && finished.finished === true)) {
        this.outcome(ctx.direction, "finished_schedule_released");
        return;
      }
    } catch (error) {
      throw this.upstream(error, ctx.direction);
    }
    this.refused(ctx.direction, "change_scheduled");
    throw new ConflictError({ message: "a change is already scheduled on this subscription (an add-on removal or a plan change): wait until it has taken effect", details: { reason: "change_scheduled" } });
  }

  /** A FRESH fetch: the local row lags the webhook, and only Stripe can show the plan line, the add-on lines and a schedule. */
  private async fetchFresh(ctx: Context): Promise<Fresh> {
    try {
      const fetched = await this.gateway.fetchObject("subscription", ctx.sub.stripe_subscription_id);
      if (fetched === null) throw new PreconditionUnmetError({ message: "the payment provider has no such subscription" });
      // Defence in depth: the row says this subscription is the workspace's, and Stripe's own metadata must agree.
      if (fetched.metadata.workspace_id !== ctx.workspaceId) {
        this.logger.error({ message: "plan change refused: the subscription's workspace metadata does not match", workspace_id: ctx.workspaceId });
        throw new PreconditionUnmetError({ message: "the payment provider's subscription does not belong to this workspace" });
      }
      const status = (fetched.raw as { status?: unknown }).status;
      // A Free target is DESCRIBED, not refused (the change route points at the portal): no state refusal applies to it, local or fresh.
      if (status === "past_due" && ctx.target.key !== "free") {
        this.refused(ctx.direction, "subscription_past_due");
        throw new ConflictError({ message: "the subscription has an unpaid invoice: pay it before changing plan", details: { reason: "subscription_past_due" } });
      }
      if ((fetched.raw as { cancel_at_period_end?: unknown }).cancel_at_period_end === true && ctx.target.key !== "free") {
        this.refused(ctx.direction, "cancellation_pending");
        throw new ConflictError({ message: "the subscription is set to cancel at the period end: resume it in the billing portal before changing plan", details: { reason: "cancellation_pending" } });
      }
      const planItems = planItemsOf(fetched.raw);
      if (planItems.length !== 1) {
        // Two plan lines make "the" plan item ambiguous: an update to one leaves the customer billed for the other.
        this.outcome(ctx.direction, "plan_lines_ambiguous");
        this.logger.error({ message: "MONEY ALARM: stripe holds an unexpected number of plan lines; plan change refused", workspace_id: ctx.workspaceId, plan_lines: planItems.length });
        throw new ConflictError({ message: "this subscription cannot be changed in the app: contact support" });
      }
      const planItem = planItems[0]!;
      if (planItem.interval === null) throw new PreconditionUnmetError({ message: "the subscription's billing interval is not recognised" });
      return { raw: fetched.raw, metadata: fetched.metadata, planItem, interval: planItem.interval, billingInterval: planItem.interval === "year" ? "annual" : "monthly", periodStart: periodStartOf(fetched.raw) };
    } catch (error) {
      throw this.upstream(error, ctx.direction);
    }
  }

  /** Stripe's own figure for the upgrade at `prorationDate`, as the quote. */
  private async quote(ctx: Context, fresh: Fresh, prorationDate: number): Promise<PlanChangeQuote> {
    try {
      const result = await this.gateway.previewPlanChange({
        customerId: ctx.sub.stripe_customer_id,
        subscriptionId: ctx.sub.stripe_subscription_id,
        planItemId: fresh.planItem.itemId,
        target: this.planPrice(ctx.target, { unit_amount_cents: this.unitAmountCents(ctx.target, fresh), currency: ctx.target.currency.trim(), billing_interval: fresh.billingInterval }),
        prorationDate,
      });
      // A negative total (a credit larger than the charge) is not a payment; it is not offered as an upgrade price.
      return { proration_date: prorationDate, amount_due_now: centsToDecimal(Math.max(0, result.amountDueCents)), currency: result.currency.toUpperCase() };
    } catch (error) {
      throw this.upstream(error, ctx.direction);
    }
  }

  private async estimateTopUp(client: ClientBase, workspaceId: string, sub: SubscriptionRow, target: TargetRow): Promise<number> {
    // `to_char`, not the raw `date` columns: node-postgres parses a `date` at LOCAL midnight (the trap apply-plan documents).
    const wallet = await client.query<{ cycle_start: string; cycle_end: string }>(
      "SELECT to_char(cycle_start, 'YYYY-MM-DD') AS cycle_start, to_char(cycle_end, 'YYYY-MM-DD') AS cycle_end FROM credit_wallets WHERE workspace_id = $1",
      [workspaceId],
    );
    const cycle = wallet.rows[0];
    // No wallet yet: the first provisioning grants the new plan in full.
    if (cycle === undefined) return 0;
    return proRataTopUp(sub.current_credits, target.credits_per_cycle, utcMidnight(cycle.cycle_start), utcMidnight(cycle.cycle_end), new Date());
  }

  /** What a downgrade to `ctx.target` would exceed, from the workspace's own entitlements, add-ons, overrides and usage. */
  private async excessFor(ctx: Context): Promise<DowngradeExcess> {
    const { client, workspaceId, target } = ctx;
    const addons = await client.query<{ kind: "extra_project" | "extra_seat"; quantity: number }>(
      "SELECT kind, quantity FROM subscription_addons WHERE workspace_id = $1 AND active_until IS NULL AND active_from <= now()",
      [workspaceId],
    );
    const held: Partial<Record<"extra_project" | "extra_seat", number>> = {};
    for (const row of addons.rows) held[row.kind] = row.quantity;

    const workspace = await client.query<{ entitlement_overrides: unknown; entitlements: Record<string, Entitlement> }>(
      "SELECT w.entitlement_overrides, p.entitlements FROM workspaces w JOIN plans p ON p.key = w.plan_key WHERE w.id = $1",
      [workspaceId],
    );
    const row = workspace.rows[0];
    if (row === undefined) throw new PreconditionUnmetError({ message: "workspace not found" });
    const overrides = entitlementOverridesSchema.parse(row.entitlement_overrides);
    return computeDowngradeExcess({
      currentPlan: row.entitlements,
      targetPlan: target.entitlements,
      heldAddons: held,
      overrides: overrides as Record<string, EntitlementValue>,
      usage: await readExcessUsage(client, workspaceId),
    });
  }

  /** The add-on quantities Stripe holds, in the shape the survival split takes. */
  private heldFrom(raw: Readonly<Record<string, unknown>>): AddonQuantities {
    const held: Partial<Record<"extra_project" | "extra_seat", number>> = {};
    for (const line of addonLinesOf(raw)) held[line.kind] = (held[line.kind] ?? 0) + line.quantity;
    return held;
  }

  /**
   * Decides what an unresolved intent means for THIS request. Returns the intent to REPLAY (the same change retried), or
   * null when there is nothing to replay. Throws `plan_change_pending` for anything else that is pending.
   */
  private async existingIntent(ctx: Context, fresh: Fresh, request: PlanChangeRequest): Promise<PendingPlanChange | null> {
    const read = readPendingPlanChange(ctx.sub.pending_plan_change);
    if (read.kind === "none") return null;
    if (read.kind === "malformed") throw this.malformed(ctx.workspaceId, ctx.direction);
    const intent = read.intent;

    const sameChange =
      intent.to_plan_key === ctx.target.key &&
      intent.direction === ctx.direction &&
      (ctx.direction === "downgrade" || intent.proration_date === request.quote?.proration_date);
    const age = Date.now() - Date.parse(intent.created_at);
    const schedule = (fresh.raw as { schedule?: unknown }).schedule;
    const holdsSchedule = schedule !== null && schedule !== undefined;
    // A same-change retry replays the stored call - but only while Stripe still REMEMBERS its idempotency key. Older than
    // that, the replay would be a brand-new call carrying an old quote.
    if (intent.settled_at === undefined && sameChange && age < INTENT_RETENTION_MS) return intent;

    // An unsettled intent for something else (or too old to replay): young, it may still be in flight in a request that died
    // (refuse); old, Stripe either applied it (its id is on the subscription's metadata: the webhook will adopt it) or never
    // saw it (release it, and let the request be validated as a new one). A downgrade is different: it may have left a
    // SCHEDULE whose phase metadata is not on the subscription yet, so "my id is not on the metadata" does not prove Stripe
    // never saw it. While the subscription holds a schedule the intent is kept (the customer sees the pending downgrade and
    // can cancel it, which releases the schedule).
    if (
      intent.settled_at === undefined &&
      age >= UNSETTLED_INTENT_RECENT_MS &&
      fresh.metadata.plan_change_intent_id !== intent.id &&
      !(intent.direction === "downgrade" && holdsSchedule)
    ) {
      await this.clearIntent(ctx.workspaceId, intent.id);
      this.logger.warn({ message: "released a plan-change intent Stripe never applied", workspace_id: ctx.workspaceId });
      return null;
    }
    this.refused(ctx.direction, "plan_change_pending");
    throw new ConflictError({
      message:
        intent.direction === "downgrade" && intent.settled_at !== undefined
          ? "a downgrade is already scheduled: cancel it before changing plan again"
          : "a plan change is already in progress: wait for it to be confirmed",
      details: { reason: "plan_change_pending" },
    });
  }

  private planPrice(target: TargetRow, priced: { unit_amount_cents: number; currency: string; billing_interval: "monthly" | "annual" }): PlanPrice {
    return {
      planKey: target.key,
      productName: `Nominara ${target.display_name}`,
      unitAmountCents: priced.unit_amount_cents,
      currency: priced.currency,
      interval: priced.billing_interval === "annual" ? "year" : "month",
    };
  }

  /** Integer cents from the catalog's `numeric(12,2)` text, on the subscription's OWN interval. */
  private unitAmountCents(target: TargetRow, fresh: Fresh): number {
    return toCents(fresh.billingInterval === "annual" ? target.annual_price : target.monthly_price);
  }

  // ---- the intent, on its own connection ---------------------------------------------------------------------------

  /** Records a NEW intent. Fails closed: with no subscription row updated, Stripe must not be asked. */
  private async writeIntent(workspaceId: string, intent: PendingPlanChange): Promise<void> {
    await this.inOwnTransaction(workspaceId, async (tx) => {
      const result = await tx.query(
        "UPDATE subscriptions SET pending_plan_change = $2::jsonb, updated_at = now() WHERE workspace_id = $1 AND status IN ('trialing','active','past_due')",
        [workspaceId, JSON.stringify(intent)],
      );
      if (result.rowCount !== 1) throw new PreconditionUnmetError({ message: "this workspace has no billing subscription yet: start one first" });
    });
  }

  /** Rewrites THIS intent (matched by id), never another's. */
  private async settleIntent(workspaceId: string, intent: PendingPlanChange): Promise<void> {
    await this.inOwnTransaction(workspaceId, async (tx) => {
      await tx.query(
        "UPDATE subscriptions SET pending_plan_change = $3::jsonb, updated_at = now() WHERE workspace_id = $1 AND pending_plan_change ->> 'id' = $2",
        [workspaceId, intent.id, JSON.stringify(intent)],
      );
    });
  }

  /** Clears THIS intent (matched by id): a newer one written by another request is left alone. */
  private async clearIntent(workspaceId: string, intentId: string): Promise<void> {
    await this.inOwnTransaction(workspaceId, async (tx) => {
      await tx.query("UPDATE subscriptions SET pending_plan_change = NULL, updated_at = now() WHERE workspace_id = $1 AND pending_plan_change ->> 'id' = $2", [workspaceId, intentId]);
    });
  }

  private async inOwnTransaction<T>(workspaceId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
    return await inBillingWriteTransaction(this.pool, { workspaceId, actorId: this.tenant().actorId }, fn);
  }

  // ---- errors, metrics, plumbing -------------------------------------------------------------------------------

  private quoteChanged(why: "stale" | "amount_differs"): DomainError {
    this.outcome("upgrade", "quote_changed");
    this.logger.warn({ message: "plan upgrade refused: the quote no longer holds", workspace_id: this.workspaceIdOrNull(), why });
    return new ConflictError({ message: "the price of this change has moved since you looked: review the new amount and confirm again", details: { reason: "quote_changed" } });
  }

  private alreadyEffective(): DomainError {
    this.outcome("downgrade", "cancel_already_effective");
    return new ConflictError({ message: "the downgrade has already taken effect and cannot be cancelled", details: { reason: "downgrade_already_effective" } });
  }

  private malformed(workspaceId: string, direction: Direction): DomainError {
    this.outcome(direction, "intent_malformed");
    this.logger.error({ message: "pending_plan_change does not parse; plan change refused", workspace_id: workspaceId });
    return new ConflictError({ message: "a plan change is in an unknown state: contact support", details: { reason: "plan_change_pending" } });
  }

  private refused(direction: Direction, outcome: string): void {
    this.outcome(direction, outcome);
  }

  /**
   * EVERY outcome is one metric increment AND one log line carrying the workspace ID (never its name, never Stripe text),
   * through this one door, so no outcome can be counted without being logged or the other way round.
   */
  private outcome(direction: string, outcome: string): void {
    incrementCounter("nominara_billing_plan_change_total", { direction, outcome });
    this.logger.log({ message: "plan change outcome", workspace_id: this.workspaceIdOrNull(), direction, outcome });
  }

  private workspaceIdOrNull(): string | null {
    return currentTenantStore()?.context.workspaceId ?? null;
  }

  private async lockWorkspace(client: ClientBase, workspaceId: string, direction: Direction): Promise<void> {
    await lockWorkspaceBounded(client, workspaceId, () => {
      this.outcome(direction, "lock_wait_exceeded");
      return new ConflictError({ message: "another billing change for this workspace is in progress: retry shortly" });
    });
  }

  private requireConfigured(): void {
    if (!this.gateway.isConfigured()) {
      this.outcome("unknown", "not_configured");
      throw new DegradedError({ message: "payment provider is not configured" });
    }
  }

  private upstream(error: unknown, direction: Direction): unknown {
    if (!(error instanceof StripeUpstreamError)) return error;
    this.outcome(direction, "upstream_error");
    // Status code only: Stripe's own text can echo request details.
    this.logger.error({ message: "stripe plan change failed", workspace_id: this.workspaceIdOrNull(), status: error.statusCode });
    return new DegradedError({ message: "payment provider is unavailable" });
  }

  private tenant() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PlanChangeService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }

  private async traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return await tracer.startActiveSpan(name, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

function isRecordWithId(value: unknown): value is { id: string } {
  return value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

