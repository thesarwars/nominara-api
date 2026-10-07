import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CheckoutSessionRequest, CheckoutSessionResponse, PortalSessionResponse, Subscription } from "../../../contracts/billing/index.js";
import { ConflictError, DegradedError, NotFoundError, PreconditionUnmetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-075a / STORY-075 AC1 — checkout, portal and the subscription read.
//
// ⚠ NOTHING HERE WRITES A PLAN. These handlers only mint a Stripe-hosted URL;
// the plan changes when the signature-verified webhook reconciles the freshly
// fetched subscription (StripeSubscriptionHandler). A response that said
// "plan changed" would be a claim about money nobody has yet taken.
//
// ⚠ ONE KNOWN DEVIATION, STATED. KAD-06 says no handler holds a transaction
// open across an await on an external service, and the request's ambient
// transaction is open here while Stripe answers. It has taken only reads — no
// row lock, no write — and the gateway bounds the call at 10 s, so the cost is
// one pooled connection for that time. Moving it off needs a route that opens
// its own short contexts (the @Streaming() precedent), which is a pattern
// decision for the owner, not something to introduce silently.

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
  sort_order: number;
}

@Injectable()
export class BillingSubscriptionService {
  private readonly logger = new Logger(BillingSubscriptionService.name);

  constructor(@Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway) {}

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
    };
  }

  /** `POST /v1/billing/checkout-session`. */
  async checkout(request: CheckoutSessionRequest): Promise<CheckoutSessionResponse> {
    this.requireConfigured();
    const { client, workspaceId } = this.tenant();

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

    const current = await this.liveSubscription();
    // ⚠ A SECOND SUBSCRIPTION IS A DOUBLE CHARGE. A workspace already paying
    // through Stripe changes plan in the portal; a comped (operator) plan at or
    // above the target is not replaced by a card checkout.
    if (current.provider === "stripe" && current.plan_key !== "free") {
      throw new ConflictError({ message: "this workspace already has an active subscription: change it in the billing portal" });
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

    try {
      const session = await this.gateway.createSubscriptionCheckout({
        workspaceId,
        planKey: target.key,
        billingInterval: request.billing_interval,
        productName: `Nominara ${target.display_name}`,
        unitAmountCents: toCents(price),
        currency: target.currency.trim(),
        ...(current.provider === "stripe" ? { customerId: current.stripe_customer_id } : {}),
        successUrl: withState("success"),
        cancelUrl: withState("cancel"),
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
    return { client: store.client, workspaceId: store.context.workspaceId };
  }

  private async liveSubscription(): Promise<SubscriptionRow> {
    const { client, workspaceId } = this.tenant();
    const result = await client.query<SubscriptionRow>(
      `SELECT s.plan_key, s.billing_interval, s.status, s.provider, s.stripe_customer_id,
              s.current_period_start, s.current_period_end, s.trial_ends_at, s.cancel_at_period_end,
              s.seats_purchased, s.projects_purchased, p.sort_order
         FROM subscriptions s JOIN plans p ON p.key = s.plan_key
        WHERE s.workspace_id = $1 AND s.status IN ('trialing','active','past_due')`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "this workspace has no subscription" });
    return row;
  }
}
