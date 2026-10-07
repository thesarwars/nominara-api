import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { provisionWalletWithGrant, recordPurchase } from "../../lib/credits/balance.js";
import { readWallet } from "../../lib/credits/wallet.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import type { StripeEventContext, StripeEventHandler } from "./stripe-event-handler.js";

// STORY-076a / STORY-076 AC2-AC3 — settles a credit-pack purchase.
//
// ⚠ CREDITS LAND HERE AND NOWHERE ELSE, and only from the purchase row our own
// purchase route wrote. The webhook says "this payment succeeded"; the amount
// credited is `credit_purchases.credits`, never a number from Stripe. The
// charged amount is only CHECKED against the row's price: a mismatch credits
// nothing and is alarmed (fail closed), because crediting 5,000 credits against
// a $1 charge is the one thing that must be impossible.
//
// ⚠ A REDELIVERY IS STRUCTURALLY A NO-OP, in three layers: the event id claim
// (stripe_webhook_events), the row's status under FOR UPDATE (so two DIFFERENT
// events for one payment — checkout.session.completed and payment_intent.
// succeeded — serialise and the second sees `succeeded`), and the ledger's
// unique idempotency key = the PaymentIntent id (ux_credit_ledger_idem).
//
// ⚠ NEVER A DELTA, NEVER A DOWNGRADE. `pending|failed -> succeeded` is the only
// way credits land (a customer may retry a declined card on the same session);
// `succeeded` is terminal here, so a late failure event cannot undo it.

const uuid = z.uuid();

export const CREDIT_PURCHASE_TTL_MONTHS = 12;

interface PurchaseRow {
  id: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  credits: number;
  amount_usd: string;
  pack_key: string;
}

@Injectable()
export class StripeCreditPackHandler implements StripeEventHandler {
  readonly types = ["checkout.session.completed", "payment_intent.succeeded", "payment_intent.payment_failed"] as const;

  private readonly logger = new Logger(StripeCreditPackHandler.name);
  private readonly audit = new AuditChainService();

  async handle({ tx, workspaceId, event, object }: StripeEventContext): Promise<void> {
    const purchaseId = uuid.safeParse(object.metadata.purchase_id);
    if (!purchaseId.success) return; // not a credit-pack object (subscription invoices, plan checkouts)

    let paymentIntentId: string;
    let chargedCents: unknown;
    let chargedCurrency: unknown;
    let outcome: "paid" | "failed" | "not_paid";
    if (object.kind === "checkout_session") {
      if (object.raw.mode !== "payment") return;
      const pi = typeof object.raw.payment_intent === "string" ? object.raw.payment_intent : undefined;
      if (pi === undefined || object.raw.payment_status !== "paid") {
        this.record(workspaceId, purchaseId.data, event.id, "not_paid");
        return;
      }
      paymentIntentId = pi;
      chargedCents = object.raw.amount_total;
      chargedCurrency = object.raw.currency;
      outcome = "paid";
    } else if (object.kind === "payment_intent") {
      paymentIntentId = object.id;
      chargedCents = object.raw.amount_received;
      chargedCurrency = object.raw.currency;
      outcome = event.type === "payment_intent.payment_failed" ? "failed" : object.raw.status === "succeeded" ? "paid" : "not_paid";
      if (outcome === "not_paid") {
        this.record(workspaceId, purchaseId.data, event.id, "not_paid");
        return;
      }
    } else {
      return;
    }

    // The serialiser: concurrent events for one purchase queue on this lock.
    // RLS scopes it to the workspace, so another tenant's purchase id finds nothing.
    const purchase = (
      await tx.query<PurchaseRow>(
        "SELECT id, status, credits, amount_usd::text, pack_key FROM credit_purchases WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [purchaseId.data, workspaceId],
      )
    ).rows[0];
    if (purchase === undefined) {
      this.logger.warn({ message: "credit pack settlement names no purchase of this workspace", event_id: event.id, workspace_id: workspaceId });
      this.record(workspaceId, purchaseId.data, event.id, "unknown_purchase");
      return;
    }

    if (outcome === "failed") {
      if (purchase.status !== "pending") {
        this.record(workspaceId, purchase.id, event.id, "duplicate");
        return;
      }
      await tx.query("UPDATE credit_purchases SET status = 'failed' WHERE id = $1", [purchase.id]);
      await this.writeAudit(tx, workspaceId, purchase, "billing.credit_purchase.failed", event.id);
      this.record(workspaceId, purchase.id, event.id, "failed");
      return;
    }

    if (purchase.status === "succeeded" || purchase.status === "refunded") {
      this.record(workspaceId, purchase.id, event.id, "duplicate");
      return;
    }

    // Fail closed: the charge must equal the price frozen on the row.
    const expectedCents = toCents(purchase.amount_usd);
    if (chargedCents !== expectedCents || typeof chargedCurrency !== "string" || chargedCurrency.toLowerCase() !== "usd") {
      this.logger.error({
        message: "credit pack charge does not match the purchase row: nothing credited",
        event_id: event.id,
        workspace_id: workspaceId,
        purchase_id: purchase.id,
      });
      this.record(workspaceId, purchase.id, event.id, "amount_mismatch");
      return;
    }

    await this.ensureWallet(tx, workspaceId);
    // The ledger key IS the PaymentIntent id: a second recording is refused by
    // ux_credit_ledger_idem and reports `applied: false`.
    await recordPurchase(
      tx,
      {
        workspaceId,
        idempotencyKey: paymentIntentId,
        actorId: null,
        actorType: "system",
        referenceType: "credit_purchase",
        referenceId: purchase.id,
      },
      purchase.credits,
    );
    await tx.query(
      `UPDATE credit_purchases
          SET status = 'succeeded', stripe_payment_intent_id = $2, expires_at = now() + make_interval(months => $3)
        WHERE id = $1`,
      [purchase.id, paymentIntentId, CREDIT_PURCHASE_TTL_MONTHS],
    );
    await this.writeAudit(tx, workspaceId, purchase, "billing.credit_purchase.succeeded", event.id);
    this.record(workspaceId, purchase.id, event.id, "succeeded");
  }

  /** The first priced request normally provisions the wallet; a purchase can precede it. */
  private async ensureWallet(tx: StripeEventContext["tx"], workspaceId: string): Promise<void> {
    if ((await readWallet(tx, workspaceId)) !== null) return;
    const resolved = await resolveEntitlements(tx, workspaceId);
    const value = resolved.entitlements["credits.included_per_cycle"]?.value;
    const grant = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
    await provisionWalletWithGrant(tx, workspaceId, grant, await resolveBillingPeriod(tx, workspaceId));
  }

  private async writeAudit(tx: StripeEventContext["tx"], workspaceId: string, purchase: PurchaseRow, action: string, eventId: string): Promise<void> {
    await this.audit.append(tx, {
      workspaceId,
      actorType: "system",
      actorId: SYSTEM_ACTOR_ID,
      actorIp: null,
      actorUa: "operator:stripe-webhook",
      action,
      resourceType: "credit_purchase",
      resourceId: purchase.id,
      beforeState: { status: purchase.status },
      afterState: { pack_key: purchase.pack_key, credits: purchase.credits, amount_usd: purchase.amount_usd },
      requestId: eventId,
      supportGrantId: null,
      severity: "info",
    });
  }

  private record(workspaceId: string, purchaseId: string, eventId: string, outcome: string): void {
    incrementCounter("nominara_billing_credit_pack_settlement_total", { outcome });
    this.logger.log({ message: "credit pack settlement", workspace_id: workspaceId, purchase_id: purchaseId, event_id: eventId, outcome });
  }
}
