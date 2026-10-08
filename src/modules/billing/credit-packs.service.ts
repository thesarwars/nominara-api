import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import type { CreditPack, CreditPackPurchaseResponse } from "../../../contracts/billing/index.js";
import { DegradedError, FeatureNotInPlanError, NotFoundError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { purchasableOptions } from "../../lib/credits/wallet.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-076a / STORY-076 AC1-AC2 — the credit-pack catalog and the purchase.
//
// ⚠ NOTHING HERE MOVES A CREDIT. A purchase writes a `pending` credit_purchases
// row and mints a Stripe-hosted URL; credits land only when the signature-
// verified webhook settles it (StripeCreditPackHandler). The price and credit
// count are read from OUR catalog row at this moment and frozen on the purchase
// row — the webhook credits from that row, never from anything Stripe sends.
//
// ⚠ THE `pending` ROW IS COMMITTED BEFORE STRIPE IS ASKED FOR A SESSION, IN ITS
// OWN SHORT TRANSACTION. The request's transaction commits only after the
// response is built, so a row inserted in it could vanish (a pod killed mid-
// deploy, a dropped connection, a failing audit write) while the Stripe session
// it names stayed payable: the customer charged, the webhook finding no
// purchase, nothing credited and nothing to reconcile. An orphaned `pending` row
// is harmless; an orphaned payable session is not, so the row goes first.
//
// A Stripe failure marks the row `failed` rather than deleting it: a timeout
// does not prove the session was not created, and a `failed` purchase still
// settles if its session is paid (StripeCreditPackHandler: pending|failed ->
// succeeded). The request's transaction is still open while Stripe answers
// (one call, bounded at 10 s), the known KAD-06 deviation shared with checkout.

@Injectable()
export class CreditPacksService {
  private readonly logger = new Logger(CreditPacksService.name);

  constructor(
    @Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

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

    // Owner decision 4: the card is kept for off-session reuse only for a workspace that has switched auto-top-up on.
    const saveCard =
      (await client.query<{ auto_topup_enabled: boolean }>("SELECT auto_topup_enabled FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0]?.auto_topup_enabled === true;

    // Committed on its OWN connection before Stripe is called (see the header).
    const purchaseId = await this.inOwnTransaction(workspaceId, actorId, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, source, status, purchased_by)
         VALUES ($1, $2, $3, $4::numeric, 'manual', 'pending', $5) RETURNING id`,
        [workspaceId, pack.key, pack.credits, pack.price_usd, actorId],
      );
      return inserted.rows[0]!.id;
    });

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
        saveCard,
      });
      incrementCounter("nominara_billing_credit_pack_purchase_total", { outcome: "created" });
      this.logger.log({ message: "credit pack purchase created", workspace_id: workspaceId, purchase_id: purchaseId, pack_key: pack.key });
      return { purchase_id: purchaseId, status: "pending", checkout_url: session.url };
    } catch (error) {
      if (!(error instanceof StripeUpstreamError)) throw error;
      incrementCounter("nominara_billing_credit_pack_purchase_total", { outcome: "upstream_error" });
      await this.markFailed(workspaceId, actorId, purchaseId);
      // Status code only: Stripe's own text can echo request details.
      this.logger.error({ message: "stripe credit pack checkout failed", workspace_id: workspaceId, status: error.statusCode });
      throw new DegradedError({ message: "payment provider is unavailable" });
    }
  }

  /** No session is expected to exist, but a timeout cannot prove it: `failed` still settles if it is paid. */
  private async markFailed(workspaceId: string, actorId: string, purchaseId: string): Promise<void> {
    try {
      await this.inOwnTransaction(workspaceId, actorId, async (tx) => {
        await tx.query("UPDATE credit_purchases SET status = 'failed' WHERE id = $1 AND status = 'pending'", [purchaseId]);
      });
    } catch {
      // The row stays `pending`, which settles all the same; the Stripe failure is what the caller must see.
      this.logger.error({ message: "could not mark an unsent credit pack purchase failed", workspace_id: workspaceId, purchase_id: purchaseId });
    }
  }

  /** A short transaction on its own pooled connection, so it commits independently of the request's. */
  private async inOwnTransaction<T>(workspaceId: string, actorId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId }, fn);
    } finally {
      client.release();
    }
  }

  private tenant() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("CreditPacksService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }
}
