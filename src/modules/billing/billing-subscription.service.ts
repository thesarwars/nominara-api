import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { pendingCheckoutSchema, type PendingCheckout } from "../../../contracts/billing/pending-checkout.schema.js";
import type { CheckoutSessionRequest, CheckoutSessionResponse, PortalSessionResponse, Subscription } from "../../../contracts/billing/index.js";
import { ConflictError, DegradedError, NotFoundError, PreconditionUnmetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type StripeGateway, type SubscriptionCheckoutInput } from "../../lib/billing/stripe/stripe-gateway.js";
import { summarizePendingPlanChange } from "../../lib/billing/plan-change-intent.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { BILLING_WRITE_POOL, inBillingWriteTransaction } from "./billing-write-pool.js";

// STORY-075a / STORY-075 AC1 — checkout, portal and the subscription read.
//
// ⚠ NOTHING HERE WRITES A PLAN. These handlers only mint a Stripe-hosted URL;
// the plan changes when the signature-verified webhook reconciles the freshly
// fetched subscription (StripeSubscriptionHandler). A response that said
// "plan changed" would be a claim about money nobody has yet taken.
//
// ⚠ THE INTENT IS COMMITTED BEFORE STRIPE IS ASKED, AND THE SESSION IS RECORDED
// THE MOMENT STRIPE ANSWERS — EACH IN ITS OWN SHORT TRANSACTION. The request's
// transaction commits only after the response is built, so anything written
// there can be lost (a pod killed mid-deploy, a dropped connection, a failing
// audit write) while the session Stripe created stays payable: the retry would
// find nothing to expire and hand out a second payable session. So
// `subscriptions.pending_checkout` (the frozen plan, interval, amount and
// currency) commits first, and `open_checkout_session_id` right after the
// session exists. If even that second write is lost, the retry REPLAYS the
// intent's exact Stripe call (same Idempotency-Key, same body), which returns
// the same session, and expires it.
//
// ⚠ ONE KNOWN DEVIATION, STATED. KAD-06 says no handler holds a transaction
// open across an await on an external service, and the request's ambient
// transaction is open here while Stripe answers. The gateway bounds each call
// at 10 s, so the cost is one pooled connection for that time. CHECKOUT ALSO
// HOLDS THE WORKSPACE ROW LOCK for it (at most three Stripe calls: recover and
// expire the previous session, create the new one): the lock is what makes "at
// most one payable session" true under two simultaneous requests, and it delays
// only this workspace's own billing writes. Moving the transaction off needs a
// route that opens its own short contexts for the whole request (the
// @Streaming() precedent), which is a pattern decision for the owner, not
// something to introduce silently. The two short writes above run on their own
// connections of the BILLING WRITE POOL (never the main pool the request already
// holds a connection of: that is hold-and-wait, and it stopped the whole API) and touch only the `subscriptions`
// row (never `workspaces`), so they cannot wait on the lock the request holds.

/** The longest `checkout` waits for the workspace row lock before answering a retryable 409 (the same bound as an add-on purchase). */
const CHECKOUT_LOCK_WAIT_MS = 3_000;

interface SubscriptionRow {
  plan_key: string;
  billing_interval: "monthly" | "annual";
  status: Subscription["status"];
  provider: Subscription["provider"];
  stripe_customer_id: string;
  current_period_start: Date;
  current_period_end: Date;
  trial_ends_at: Date | null;
  cancel_at_period_end: boolean;
  seats_purchased: number;
  projects_purchased: number;
  open_checkout_session_id: string | null;
  pending_checkout: unknown;
  pending_plan_change: unknown;
  sort_order: number;
}

@Injectable()
export class BillingSubscriptionService {
  private readonly logger = new Logger(BillingSubscriptionService.name);

  constructor(
    @Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway,
    @Inject(BILLING_WRITE_POOL) private readonly pool: Pool,
  ) {}

  /** `GET /v1/billing/subscription`. */
  async subscription(): Promise<Subscription> {
    const row = await this.liveSubscription();
    return {
      plan_key: row.plan_key,
      billing_interval: row.billing_interval,
      status: row.status,
      provider: row.provider,
      current_period_start: row.current_period_start.toISOString(),
      current_period_end: row.current_period_end.toISOString(),
      trial_ends_at: row.trial_ends_at === null ? null : row.trial_ends_at.toISOString(),
      cancel_at_period_end: row.cancel_at_period_end,
      seats_purchased: row.seats_purchased,
      projects_purchased: row.projects_purchased,
      pending_plan_change: summarizePendingPlanChange(row.pending_plan_change),
    };
  }

  /** `POST /v1/billing/checkout-session`. */
  async checkout(request: CheckoutSessionRequest): Promise<CheckoutSessionResponse> {
    this.requireConfigured();
    const { client, workspaceId, actorId } = this.tenant();

    const plan = await client.query<{ key: string; display_name: string; monthly_price: string; annual_price: string; currency: string; sort_order: number }>(
      "SELECT key, display_name, monthly_price, annual_price, currency, sort_order FROM plans WHERE key = $1",
      [request.plan_key],
    );
    const target = plan.rows[0];
    if (target === undefined) {
      throw new ValidationFailedError({ message: "unknown plan", details: { issues: [{ path: ["plan_key"], message: "no such plan" }] } });
    }
    // Free has nothing to pay; enterprise is priced by contract. Neither is a card checkout.
    if (target.key === "free" || target.key === "enterprise") {
      throw new ValidationFailedError({
        message: "this plan cannot be purchased through checkout",
        details: { issues: [{ path: ["plan_key"], message: "not available through self-serve checkout" }] },
      });
    }

    // ⚠ SERIALISE CHECKOUTS PER WORKSPACE, THEN READ. A concurrent request
    // waits here until the first has recorded its session, so it sees it.
    await this.lockWorkspace(client, workspaceId);
    const current = await this.liveSubscription();
    // ⚠ A SECOND SUBSCRIPTION IS A DOUBLE CHARGE. A workspace already paying
    // through Stripe does not buy another; a comped (operator) plan at or above
    // the target is not replaced by a card checkout. The portal manages payment
    // details and cancellation — a plan is NOT changed there: the webhook takes
    // the plan from the price Stripe charges, so a portal price switch is
    // refused and alarmed, never granted.
    if (current.provider === "stripe" && current.plan_key !== "free") {
      throw new ConflictError({ message: "this workspace already has an active subscription: change its plan in Settings > Plan (the in-app plan change), or manage payment details or cancel it in the billing portal" });
    }
    if (target.sort_order <= current.sort_order) {
      throw new ConflictError({ message: "the workspace is already on this plan or a higher one" });
    }

    const price = request.billing_interval === "annual" ? target.annual_price : target.monthly_price;
    const returnBase = new URL("/settings/plan", loadEnv().WEBAUTHN_ORIGIN);
    const withState = (state: "success" | "cancel"): string => {
      const url = new URL(returnBase);
      url.searchParams.set("checkout", state);
      return url.toString();
    };
    // ONE definition of the Stripe call an intent makes: the replay of a lost
    // one must be byte-identical (Stripe refuses a reused key with a new body).
    const inputFor = (intent: PendingCheckout): SubscriptionCheckoutInput => ({
      workspaceId,
      planKey: intent.plan_key,
      billingInterval: intent.billing_interval,
      productName: intent.product_name,
      unitAmountCents: intent.unit_amount_cents,
      currency: intent.currency,
      ...(intent.customer_id === null ? {} : { customerId: intent.customer_id }),
      successUrl: intent.success_url,
      cancelUrl: intent.cancel_url,
      intentId: intent.id,
      idempotencyKey: `subscription-checkout-${intent.id}`,
    });

    try {
      // ⚠ PREVENT THE DOUBLE SUBSCRIPTION, DO NOT JUST DETECT IT. Two tabs or a
      // retry would each hand out a payable session and the customer could pay
      // twice. The session this workspace was last given is made unpayable
      // BEFORE the next one exists. If it was already paid, its webhook has yet
      // to apply: a second checkout is refused until it does.
      const previous = this.pendingOf(current);
      const previousSessionId = current.open_checkout_session_id ?? (previous === null ? null : (await this.gateway.createSubscriptionCheckout(inputFor(previous))).id);
      if (previousSessionId !== null) {
        const closed = await this.gateway.closeCheckoutSession(previousSessionId);
        if (closed.status === "complete" && closed.subscriptionLive) {
          incrementCounter("nominara_billing_checkout_session_total", { outcome: "paid_pending" });
          throw new ConflictError({ message: "a checkout for this workspace has been paid and is being confirmed: wait a moment, then refresh" });
        }
        incrementCounter("nominara_billing_checkout_session_total", { outcome: closed.status === "expired" ? "superseded" : "settled" });
      }

      const intent: PendingCheckout = {
        id: uuidV7(),
        plan_key: target.key,
        billing_interval: request.billing_interval,
        product_name: `Nominara ${target.display_name}`,
        unit_amount_cents: toCents(price),
        currency: target.currency.trim(),
        customer_id: current.provider === "stripe" ? current.stripe_customer_id : null,
        success_url: withState("success"),
        cancel_url: withState("cancel"),
      };
      // Committed BEFORE Stripe: from here a session that exists is findable.
      await this.inOwnTransaction(workspaceId, actorId, async (tx) => {
        await tx.query(
          `UPDATE subscriptions SET pending_checkout = $2::jsonb, open_checkout_session_id = NULL
            WHERE workspace_id = $1 AND status IN ('trialing','active','past_due')`,
          [workspaceId, JSON.stringify(intent)],
        );
      });
      const session = await this.gateway.createSubscriptionCheckout(inputFor(intent));
      // Committed AT ONCE, not with the request: the response still has to be built and audited.
      await this.inOwnTransaction(workspaceId, actorId, async (tx) => {
        await tx.query(
          "UPDATE subscriptions SET open_checkout_session_id = $2 WHERE workspace_id = $1 AND pending_checkout ->> 'id' = $3 AND status IN ('trialing','active','past_due')",
          [workspaceId, session.id, intent.id],
        );
      });
      incrementCounter("nominara_billing_checkout_session_total", { outcome: "created" });
      this.logger.log({ message: "stripe checkout session created", workspace_id: workspaceId, plan_key: target.key, billing_interval: request.billing_interval });
      return { checkout_url: session.url, session_id: session.id };
    } catch (error) {
      throw this.upstream(error, "checkout");
    }
  }

  /** `POST /v1/billing/portal-session`. */
  async portal(): Promise<PortalSessionResponse> {
    this.requireConfigured();
    const { workspaceId } = this.tenant();
    const current = await this.liveSubscription();
    // The customer comes from the caller's OWN workspace subscription — never from the request.
    if (current.provider !== "stripe") {
      throw new PreconditionUnmetError({ message: "this workspace has no billing account yet: start a subscription first" });
    }
    try {
      const session = await this.gateway.createPortalSession({
        customerId: current.stripe_customer_id,
        returnUrl: new URL("/settings/plan", loadEnv().WEBAUTHN_ORIGIN).toString(),
      });
      incrementCounter("nominara_billing_portal_session_total", { outcome: "created" });
      this.logger.log({ message: "stripe portal session created", workspace_id: workspaceId });
      return { portal_url: session.url };
    } catch (error) {
      throw this.upstream(error, "portal");
    }
  }

  /**
   * ⚠ THE LOCK WAIT IS BOUNDED, like an add-on purchase's. A request queued behind the holder keeps its pooled
   * connection while it waits; with enough of them queued the main pool is empty and the API answers nothing.
   * A wait of at most `CHECKOUT_LOCK_WAIT_MS` makes that a retryable 409: the waiters give their connections
   * back. The setting is transaction-local (never session-level).
   */
  private async lockWorkspace(client: ClientBase, workspaceId: string): Promise<void> {
    await client.query("SELECT set_config('lock_timeout', $1, true)", [String(CHECKOUT_LOCK_WAIT_MS)]);
    try {
      await client.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    } catch (error) {
      if ((error as { code?: string }).code !== "55P03") throw error;
      incrementCounter("nominara_billing_checkout_session_total", { outcome: "lock_wait_exceeded" });
      throw new ConflictError({ message: "another billing change for this workspace is in progress: retry shortly" });
    }
    await client.query("SELECT set_config('lock_timeout', '0', true)");
  }

  /** The workspace's last intent, or null. Fails closed on a malformed column rather than guessing. */
  private pendingOf(row: SubscriptionRow): PendingCheckout | null {
    return row.pending_checkout === null || row.pending_checkout === undefined ? null : pendingCheckoutSchema.parse(row.pending_checkout);
  }

  /**
   * A short transaction on a connection of the BILLING WRITE POOL (never the main pool the request already holds a
   * connection of: that is hold-and-wait), so it commits independently of the request's.
   */
  private async inOwnTransaction<T>(workspaceId: string, actorId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
    return await inBillingWriteTransaction(this.pool, { workspaceId, actorId }, fn);
  }

  private requireConfigured(): void {
    if (!this.gateway.isConfigured()) {
      incrementCounter("nominara_billing_checkout_session_total", { outcome: "not_configured" });
      throw new DegradedError({ message: "payment provider is not configured" });
    }
  }

  private upstream(error: unknown, what: string): unknown {
    if (!(error instanceof StripeUpstreamError)) return error;
    incrementCounter(`nominara_billing_${what}_session_total`, { outcome: "upstream_error" });
    // Status code only: Stripe's own text can echo request details.
    this.logger.error({ message: `stripe ${what} session failed`, status: error.statusCode });
    return new DegradedError({ message: "payment provider is unavailable" });
  }

  private tenant() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("BillingSubscriptionService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }

  private async liveSubscription(): Promise<SubscriptionRow> {
    const { client, workspaceId } = this.tenant();
    const result = await client.query<SubscriptionRow>(
      `SELECT s.plan_key, s.billing_interval, s.status, s.provider, s.stripe_customer_id,
              s.current_period_start, s.current_period_end, s.trial_ends_at, s.cancel_at_period_end,
              s.seats_purchased, s.projects_purchased, s.open_checkout_session_id, s.pending_checkout, s.pending_plan_change, p.sort_order
         FROM subscriptions s JOIN plans p ON p.key = s.plan_key
        WHERE s.workspace_id = $1 AND s.status IN ('trialing','active','past_due')`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "this workspace has no subscription" });
    return row;
  }
}
