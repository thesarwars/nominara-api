import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CreditPack, CreditPackPurchaseResponse } from "../../../contracts/billing/index.js";
import { DegradedError, FeatureNotInPlanError, NotFoundError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { purchasableOptions } from "../../lib/credits/wallet.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-076a / STORY-076 AC1-AC2 — the credit-pack catalog and the purchase.
//
// ⚠ NOTHING HERE MOVES A CREDIT. A purchase writes a `pending` credit_purchases
// row and mints a Stripe-hosted URL; credits land only when the signature-
// verified webhook settles it (StripeCreditPackHandler). The price and credit
// count are read from OUR catalog row at this moment and frozen on the purchase
// row — the webhook credits from that row, never from anything Stripe sends.
//
// ⚠ THE SAME KNOWN DEVIATION AS CHECKOUT (billing-subscription.service.ts): the
// request's transaction is open while Stripe answers (one call, bounded at 10 s).
// If Stripe fails the transaction rolls back, so a failed attempt leaves no
// `pending` row behind.

@Injectable()
export class CreditPacksService {
  private readonly logger = new Logger(CreditPacksService.name);

  constructor(@Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway) {}

  /** `GET /v1/billing/credit-packs` — already filtered to the caller's tier, in SQL. */
  async list(): Promise<CreditPack[]> {
    const { client, workspaceId } = this.tenant();
    const options = await purchasableOptions(client, workspaceId);
    return options.map((o) => ({
      key: o.key,
      display_name: o.displayName,
      credits: o.credits,
      price_usd: o.priceUsd,
      currency: o.currency,
      min_plan_key: o.minPlanKey,
    }));
  }

  /** `POST /v1/billing/credit-packs/{key}/purchase`. */
  async purchase(packKey: string): Promise<CreditPackPurchaseResponse> {
    if (!this.gateway.isConfigured()) {
      incrementCounter("nominara_billing_credit_pack_purchase_total", { outcome: "not_configured" });
      throw new DegradedError({ message: "payment provider is not configured" });
    }
    const { client, workspaceId, actorId } = this.tenant();

    const pack = (
      await client.query<{ key: string; display_name: string; credits: number; price_usd: string; currency: string; min_plan_key: string | null }>(
        "SELECT key, display_name, credits, price_usd::text, currency, min_plan_key FROM credit_packs WHERE key = $1 AND is_public",
        [packKey],
      )
    ).rows[0];
    if (pack === undefined) {
      incrementCounter("nominara_billing_credit_pack_purchase_total", { outcome: "unknown_pack" });
      throw new NotFoundError({ message: "no such credit pack" });
    }

    // ⚠ THE TIER CHECK COMES BEFORE ANY ROW OR STRIPE CALL. The same SQL the
    // catalog uses decides it, so a pack that is not listed cannot be bought.
    const offered = await purchasableOptions(client, workspaceId);
    if (!offered.some((o) => o.key === pack.key)) {
      incrementCounter("nominara_billing_credit_pack_purchase_total", { outcome: "above_tier" });
      throw new FeatureNotInPlanError({ details: { key: `credit_pack.${pack.key}`, min_plan: pack.min_plan_key ?? "starter" } });
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, source, status, purchased_by)
       VALUES ($1, $2, $3, $4::numeric, 'manual', 'pending', $5) RETURNING id`,
      [workspaceId, pack.key, pack.credits, pack.price_usd, actorId],
    );
    const purchaseId = inserted.rows[0]!.id;

    const returnBase = new URL("/settings/plan", loadEnv().WEBAUTHN_ORIGIN);
    const withState = (state: "success" | "cancel"): string => {
      const url = new URL(returnBase);
      url.searchParams.set("credit_pack", state);
      return url.toString();
    };

    try {
      const session = await this.gateway.createCreditPackCheckout({
        workspaceId,
        purchaseId,
        packKey: pack.key,
        productName: `Nominara ${pack.display_name} (${String(pack.credits)} credits)`,
        credits: pack.credits,
        unitAmountCents: toCents(pack.price_usd),
        currency: pack.currency.trim(),
        successUrl: withState("success"),
        cancelUrl: withState("cancel"),
      });
      incrementCounter("nominara_billing_credit_pack_purchase_total", { outcome: "created" });
      this.logger.log({ message: "credit pack purchase created", workspace_id: workspaceId, purchase_id: purchaseId, pack_key: pack.key });
      return { purchase_id: purchaseId, status: "pending", checkout_url: session.url };
    } catch (error) {
      if (!(error instanceof StripeUpstreamError)) throw error;
      incrementCounter("nominara_billing_credit_pack_purchase_total", { outcome: "upstream_error" });
      // Status code only: Stripe's own text can echo request details.
      this.logger.error({ message: "stripe credit pack checkout failed", workspace_id: workspaceId, status: error.statusCode });
      throw new DegradedError({ message: "payment provider is unavailable" });
    }
  }

  private tenant() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("CreditPacksService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }
}
