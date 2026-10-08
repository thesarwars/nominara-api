import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import type { AutoTopupTriggerOutcome } from "../../../contracts/billing/index.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type OffSessionPaymentInput, type SavedPaymentMethod, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { lockWallet, purchasableOptions, type PurchasableOption } from "../../lib/credits/wallet.js";
import { AUTO_TOPUP_MIN_PLAN } from "./billing.service.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { EMAIL_SENDER, type EmailSender } from "../identity/ports/email-sender.js";

// NEW-D-7 / STORY-076 scenarios 7 and 9 — the auto-top-up trigger.
//
// ⚠ A TRIGGER MOVES NO CREDIT. It claims one slot of the per-cycle cap, writes
// a `pending` credit_purchases row (source 'auto_topup'), emails the billing
// contact, and asks Stripe to charge the saved card. The credits land when the
// signature-verified webhook settles that row — the same path as STORY-076a
// (StripeCreditPackHandler) — and nowhere else.
//
// ⚠ THE CAP IS CLAIMED BY ONE CONDITIONAL UPDATE. `auto_topup_count_cycle <
// auto_topup_max_per_cycle` (and enabled, and still below the threshold, and no
// charge already in flight) sit in the WHERE of the statement that increments
// the counter, behind a row lock on the wallet, so two concurrent triggers
// cannot both take the last slot. `ck_autotopup_bounded` still bounds the cap
// itself in the schema; this counter only decides whether a slot is left.
//
// ⚠ NEVER A TRANSACTION ACROSS A NETWORK CALL (KAD-06). Three short tenant
// transactions — plan, claim, record — and Stripe / the mail port are awaited
// BETWEEN them, never inside one. The claim is committed before the card is
// touched, so a crash leaves a `pending` row (harmless, and it settles if the
// charge went through) rather than a charge nobody recorded.
//
// ⚠ FAIL CLOSED. No billing contact: nobody is charged. The email cannot be
// sent: nobody is charged. No saved payment method: a recorded no-op that takes
// no cap slot. A decline disables the setting and is never retried.
//
// NOT YET CALLED FROM THE DEBIT PATH. Nothing invokes `trigger` on a balance
// drop yet: doing it inside the request would put these network calls on the
// request path (KAD-06). See docs/plans/evidence/NEW-D-7.md.

/**
 * A `pending` auto-top-up purchase older than this is RECONCILED WITH STRIPE. The clock alone proves
 * nothing about the money: a 503 or a timeout on the charge request says nothing about whether Stripe
 * took it, and a bank debit can stay `processing` for days. The clock NEVER frees the slot and a lookup
 * never does either (checkpoint-3):
 *   - `failed` (the PaymentIntent was refused) is a DECLINE: the row fails, auto-top-up is switched off,
 *     the contact is told, and nothing is charged — the same path as a synchronous decline.
 *   - `in_progress` / `succeeded`: left pending; the webhook settles it.
 *   - `none`: PaymentIntent Search is eventually consistent and lags exactly during an outage, so `none`
 *     proves nothing. The SAME charge is replayed under its own idempotency key (`auto-topup-<purchaseId>`):
 *     Stripe returns the original PaymentIntent, or creates the charge for this same purchase — never a
 *     second one. Past the key retention a replay would be a NEW charge, so it fails closed: the row stays
 *     pending and an alert is raised.
 *   - a lookup or replay that errors leaves the row pending.
 */
const STALE_PENDING_MINUTES = 60;

/** Stripe keeps an idempotency key for at least 24 hours; a replay is trusted for 23, so clock skew cannot make it a new charge. */
const IDEMPOTENCY_REPLAY_HOURS = 23;

export const AUTO_TOPUP_TRIGGERED_SUBJECT = "Nominara auto top-up triggered";
export const AUTO_TOPUP_DISABLED_SUBJECT = "Nominara auto top-up disabled after a failed payment";

interface WalletConfigRow {
  auto_topup_enabled: boolean;
  auto_topup_pack_key: string | null;
  auto_topup_threshold: number | null;
  auto_topup_max_per_cycle: number | null;
  auto_topup_count_cycle: number;
  available: number;
}

type Verdict = { readonly stop: AutoTopupTriggerOutcome } | { readonly stop: null; readonly packKey: string };

interface Ready {
  readonly packKey: string;
  readonly contact: string;
  readonly referencePaymentIntentId: string;
  /** Pending auto-top-up purchases past the stale window, to be reconciled with Stripe (never inside a transaction). */
  readonly stale: readonly StalePurchase[];
}

/** What a replay of the original charge needs, rebuilt from the purchase row — Stripe rejects a replay whose parameters differ. */
type ReplayCharge = Omit<OffSessionPaymentInput, "customerId" | "paymentMethodId">;

interface StalePurchase {
  readonly id: string;
  /** Null when the pack can no longer be priced like the original charge: then no replay is possible. */
  readonly replay: ReplayCharge | null;
  /** Older than the idempotency-key retention: a replay would be a new charge. */
  readonly pastRetention: boolean;
}

interface Claimed {
  readonly purchaseId: string;
  readonly pack: PurchasableOption;
}

@Injectable()
export class AutoTopupService {
  private readonly logger = new Logger(AutoTopupService.name);
  private readonly audit = new AuditChainService();

  constructor(
    @Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  /** Evaluates one workspace. Safe to call as often as a balance changes: a call that should not charge, does not. */
  async trigger(workspaceId: string): Promise<AutoTopupTriggerOutcome> {
    const outcome = await this.run(workspaceId);
    incrementCounter("nominara_billing_auto_topup_trigger_total", { outcome });
    this.logger.log({ message: "auto-top-up evaluated", workspace_id: workspaceId, outcome });
    return outcome;
  }

  private async run(workspaceId: string): Promise<AutoTopupTriggerOutcome> {
    // 1. PLAN — cheap checks that need no network, so a workspace at its cap costs one read.
    const planned = await this.inTx(workspaceId, (tx) => this.plan(tx, workspaceId));
    if ("outcome" in planned) return planned.outcome;
    const { packKey, contact, referencePaymentIntentId, stale } = planned.ready;

    // 2a. STALE PENDING CHARGES — reconciled with Stripe, outside any transaction (KAD-06). A stale charge is
    // finished (declined / replayed / left pending) BEFORE anything new is charged: no new claim in this run.
    if (stale.length > 0) return this.reconcileStale(workspaceId, referencePaymentIntentId, stale);

    // 2b. THE SAVED CARD — outside any transaction.
    let method: SavedPaymentMethod | null;
    try {
      method = await this.gateway.findSavedPaymentMethod(referencePaymentIntentId);
    } catch (error) {
      if (!(error instanceof StripeUpstreamError)) throw error;
      this.logger.error({ message: "auto-top-up could not look up the saved payment method", workspace_id: workspaceId, status: error.statusCode });
      return "upstream_error";
    }
    if (method === null) {
      await this.inTx(workspaceId, (tx) => this.recordSkipped(tx, workspaceId, "no_payment_method"));
      return "no_payment_method";
    }

    // 3. CLAIM — the conditional UPDATE, the pending purchase and the audit row commit together.
    const claim = await this.inTx(workspaceId, (tx) => this.claim(tx, workspaceId, packKey));
    if ("outcome" in claim) return claim.outcome;
    const { purchaseId, pack } = claim.claimed;

    // 4. EVERY TRIGGER EMAILS THE BILLING CONTACT — before the card is touched.
    try {
      await this.email.send({
        to: contact,
        subject: AUTO_TOPUP_TRIGGERED_SUBJECT,
        textBody:
          `Your workspace's credit balance fell below its auto top-up threshold, so Nominara is charging your saved card ` +
          `${pack.priceUsd} ${pack.currency.trim()} for the ${pack.displayName} (${String(pack.credits)} credits). ` +
          `The credits arrive once the payment is confirmed. You can turn auto top-up off in Billing settings.`,
      });
    } catch {
      await this.inTx(workspaceId, (tx) => this.markFailed(tx, purchaseId));
      this.logger.error({ message: "auto-top-up not charged: the notification could not be sent", workspace_id: workspaceId, purchase_id: purchaseId });
      return "email_failed";
    }

    // 5. THE CHARGE — never inside a transaction, never retried.
    try {
      const result = await this.gateway.createOffSessionPayment({
        workspaceId,
        purchaseId,
        packKey: pack.key,
        productName: `Nominara ${pack.displayName} (${String(pack.credits)} credits) — auto top-up`,
        unitAmountCents: toCents(pack.priceUsd),
        currency: pack.currency.trim(),
        customerId: method.customerId,
        paymentMethodId: method.paymentMethodId,
      });
      if (result.outcome === "declined") {
        await this.declined(workspaceId, purchaseId);
        return "declined";
      }
      return "charge_submitted";
    } catch (error) {
      if (!(error instanceof StripeUpstreamError)) throw error;
      // A timeout does not prove the charge did not happen, so the purchase STAYS pending: the in-flight
      // guard stays closed (no second charge), the webhook settles it if the payment was taken, and
      // `reconcileStale` settles it on the next run (decline / replay), never by freeing the slot.
      this.logger.error({ message: "auto-top-up charge request failed", workspace_id: workspaceId, purchase_id: purchaseId, status: error.statusCode });
      return "upstream_error";
    }
  }

  // ---- phases ------------------------------------------------------------------------------------

  private async plan(tx: ClientBase, workspaceId: string): Promise<{ ready: Ready } | { outcome: AutoTopupTriggerOutcome }> {
    const verdict = await this.verdict(tx, workspaceId);
    if (verdict.stop !== null) return { outcome: verdict.stop };

    const options = await purchasableOptions(tx, workspaceId);
    if (!options.some((o) => o.key === verdict.packKey)) return { outcome: "pack_unavailable" };

    const contact = await this.billingContact(tx, workspaceId);
    if (contact === null) return { outcome: "no_billing_contact" };

    // The reference is a completed pack purchase from OUR checkout, which asks for setup_future_usage.
    const reference = await tx.query<{ stripe_payment_intent_id: string }>(
      `SELECT stripe_payment_intent_id FROM credit_purchases
        WHERE workspace_id = $1 AND source = 'manual' AND status = 'succeeded' AND stripe_payment_intent_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspaceId],
    );
    const referencePaymentIntentId = reference.rows[0]?.stripe_payment_intent_id ?? null;
    if (referencePaymentIntentId === null) {
      await this.recordSkipped(tx, workspaceId, "no_payment_method");
      return { outcome: "no_payment_method" };
    }
    const stale = await tx.query<{ id: string; pack_key: string; credits: number; amount_usd: string; past_retention: boolean }>(
      `SELECT id, pack_key, credits, amount_usd::text AS amount_usd,
              created_at < now() - make_interval(hours => $3::int) AS past_retention
         FROM credit_purchases
        WHERE workspace_id = $1 AND source = 'auto_topup' AND status = 'pending' AND created_at < now() - make_interval(mins => $2::int)
        ORDER BY created_at, id`,
      [workspaceId, STALE_PENDING_MINUTES, IDEMPOTENCY_REPLAY_HOURS],
    );
    return {
      ready: {
        packKey: verdict.packKey,
        contact,
        referencePaymentIntentId,
        stale: stale.rows.map((r) => {
          const option = options.find((o) => o.key === r.pack_key);
          return {
            id: r.id,
            pastRetention: r.past_retention,
            replay:
              option === undefined
                ? null
                : {
                    workspaceId,
                    purchaseId: r.id,
                    packKey: r.pack_key,
                    productName: `Nominara ${option.displayName} (${String(r.credits)} credits) — auto top-up`,
                    unitAmountCents: toCents(r.amount_usd),
                    currency: option.currency.trim(),
                  },
          };
        }),
      },
    };
  }

  /** Why a trigger would not fire right now, or the pack it would buy. A read: the claim below is the authority. */
  private async verdict(tx: ClientBase, workspaceId: string): Promise<Verdict> {
    const row = (
      await tx.query<WalletConfigRow>(
        `SELECT auto_topup_enabled, auto_topup_pack_key, auto_topup_threshold, auto_topup_max_per_cycle, auto_topup_count_cycle,
                (included_balance + purchased_balance - reserved) AS available
           FROM credit_wallets WHERE workspace_id = $1`,
        [workspaceId],
      )
    ).rows[0];
    if (row === undefined || !row.auto_topup_enabled || row.auto_topup_pack_key === null || row.auto_topup_threshold === null || row.auto_topup_max_per_cycle === null) {
      return { stop: "not_enabled" };
    }
    if (!(await this.planAllows(tx, workspaceId))) return { stop: "not_in_plan" };
    if (row.available >= row.auto_topup_threshold) return { stop: "above_threshold" };
    if (row.auto_topup_count_cycle >= row.auto_topup_max_per_cycle) return { stop: "cap_reached" };
    if (await this.chargeInFlight(tx, workspaceId)) return { stop: "in_flight" };
    return { stop: null, packKey: row.auto_topup_pack_key };
  }

  /** Growth+ — the same comparison `BillingService.setAutoTopup` makes, re-asked at trigger time: a downgrade turns it off. */
  private async planAllows(tx: ClientBase, workspaceId: string): Promise<boolean> {
    const plan = await tx.query<{ eligible: boolean }>(
      `SELECT (p.sort_order >= g.sort_order) AS eligible
         FROM workspaces w JOIN plans p ON p.key = w.plan_key JOIN plans g ON g.key = $2
        WHERE w.id = $1`,
      [workspaceId, AUTO_TOPUP_MIN_PLAN],
    );
    return plan.rows[0]?.eligible === true;
  }

  private async chargeInFlight(tx: ClientBase, workspaceId: string): Promise<boolean> {
    const pending = await tx.query(
      `SELECT 1 FROM credit_purchases
        WHERE workspace_id = $1 AND source = 'auto_topup' AND status = 'pending' AND created_at >= now() - make_interval(mins => $2::int) LIMIT 1`,
      [workspaceId, STALE_PENDING_MINUTES],
    );
    return (pending.rowCount ?? 0) > 0;
  }

  /**
   * Reconciles each stale pending purchase with Stripe; see STALE_PENDING_MINUTES for the rules. Returns the
   * outcome of the run: nothing here ever takes a new cap slot or mints a new purchase id.
   */
  private async reconcileStale(workspaceId: string, referencePaymentIntentId: string, stale: readonly StalePurchase[]): Promise<AutoTopupTriggerOutcome> {
    let outcome: AutoTopupTriggerOutcome = "in_flight";
    let method: SavedPaymentMethod | null | undefined;
    for (const row of stale) {
      try {
        const state = await this.gateway.findOffSessionPayment(row.id);
        incrementCounter("nominara_billing_auto_topup_stale_lookup_total", { state });
        if (state === "failed") {
          await this.declined(workspaceId, row.id);
          return "declined";
        }
        if (state !== "none") continue; // in_progress / succeeded: the webhook settles it.

        // `none` from Search proves nothing. Replay the SAME charge under its own key — or fail closed.
        if (row.pastRetention || row.replay === null) {
          this.unreconcilable(workspaceId, row.id, row.pastRetention ? "past_idempotency_retention" : "pack_unavailable");
          continue;
        }
        method ??= await this.gateway.findSavedPaymentMethod(referencePaymentIntentId);
        if (method === null) {
          this.unreconcilable(workspaceId, row.id, "no_payment_method");
          continue;
        }
        const result = await this.gateway.createOffSessionPayment({ ...row.replay, customerId: method.customerId, paymentMethodId: method.paymentMethodId });
        incrementCounter("nominara_billing_auto_topup_stale_replay_total", { outcome: result.outcome });
        if (result.outcome === "declined") {
          await this.declined(workspaceId, row.id);
          return "declined";
        }
        outcome = "charge_submitted";
      } catch (error) {
        if (!(error instanceof StripeUpstreamError)) throw error;
        incrementCounter("nominara_billing_auto_topup_stale_lookup_total", { state: "error" });
        this.logger.error({ message: "auto-top-up could not reconcile a stale pending purchase with the provider", workspace_id: workspaceId, purchase_id: row.id, status: error.statusCode });
        return "upstream_error";
      }
    }
    return outcome;
  }

  /** A stale charge that cannot be reconciled safely stays pending (the in-flight guard stays closed) and raises an alert. */
  private unreconcilable(workspaceId: string, purchaseId: string, reason: string): void {
    incrementCounter("nominara_billing_auto_topup_stale_unreconcilable_total", { reason });
    this.logger.error({ message: "ALERT auto-top-up stale pending purchase cannot be reconciled and stays pending", workspace_id: workspaceId, purchase_id: purchaseId, reason });
  }

  /** The decline path, shared by the synchronous decline, a failed PaymentIntent found on reconcile, and a declined replay. */
  private async declined(workspaceId: string, purchaseId: string): Promise<void> {
    await this.inTx(workspaceId, async (tx) => {
      await this.markFailed(tx, purchaseId);
      await this.disableAfterFailure(tx, workspaceId, purchaseId);
    });
    await this.notifyDisabled(workspaceId);
  }

  private async claim(tx: ClientBase, workspaceId: string, packKey: string): Promise<{ claimed: Claimed } | { outcome: AutoTopupTriggerOutcome }> {
    // The row lock serialises concurrent triggers; the next statement then sees the winner's committed purchase.
    if (!(await lockWallet(tx, workspaceId))) return { outcome: "not_enabled" };
    const pack = (await purchasableOptions(tx, workspaceId)).find((o) => o.key === packKey);
    if (pack === undefined) return { outcome: "pack_unavailable" };

    const claimed = await tx.query(
      `UPDATE credit_wallets
          SET auto_topup_count_cycle = auto_topup_count_cycle + 1, updated_at = now()
        WHERE workspace_id = $1
          AND auto_topup_enabled
          AND auto_topup_pack_key = $2
          AND auto_topup_count_cycle < auto_topup_max_per_cycle
          AND EXISTS (SELECT 1 FROM workspaces w JOIN plans p ON p.key = w.plan_key JOIN plans g ON g.key = $3
                       WHERE w.id = $1 AND p.sort_order >= g.sort_order)
          AND (included_balance + purchased_balance - reserved) < auto_topup_threshold
          AND NOT EXISTS (SELECT 1 FROM credit_purchases p WHERE p.workspace_id = $1 AND p.source = 'auto_topup' AND p.status = 'pending')`,
      [workspaceId, packKey, AUTO_TOPUP_MIN_PLAN],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      const why = await this.verdict(tx, workspaceId);
      return { outcome: why.stop ?? "in_flight" };
    }

    const purchase = await tx.query<{ id: string }>(
      `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, source, status, purchased_by)
       VALUES ($1, $2, $3, $4::numeric, 'auto_topup', 'pending', NULL) RETURNING id`,
      [workspaceId, pack.key, pack.credits, pack.priceUsd],
    );
    const purchaseId = purchase.rows[0]!.id;
    await this.writeAudit(tx, workspaceId, "billing.auto_topup.triggered", "credit_purchase", purchaseId, { status: "pending" }, { pack_key: pack.key, credits: pack.credits, amount_usd: pack.priceUsd });
    return { claimed: { purchaseId, pack } };
  }

  private async recordSkipped(tx: ClientBase, workspaceId: string, reason: string): Promise<void> {
    await this.writeAudit(tx, workspaceId, "billing.auto_topup.skipped", "credit_wallet", workspaceId, null, { reason });
  }

  private async markFailed(tx: ClientBase, purchaseId: string): Promise<void> {
    await tx.query("UPDATE credit_purchases SET status = 'failed' WHERE id = $1 AND status = 'pending'", [purchaseId]);
  }

  /**
   * STORY-076 scenario 9 — the payment failed: switch auto-top-up OFF and say why.
   * Runs in the caller's transaction (the webhook's, or the decline's). It does
   * NOT touch `auto_topup_count_cycle`, and nothing in this file ever retries.
   */
  async disableAfterFailure(tx: ClientBase, workspaceId: string, purchaseId: string): Promise<void> {
    await tx.query("UPDATE credit_wallets SET auto_topup_enabled = false, updated_at = now() WHERE workspace_id = $1", [workspaceId]);
    await this.writeAudit(tx, workspaceId, "billing.auto_topup.disabled", "credit_wallet", workspaceId, { enabled: true }, { enabled: false, reason: "payment_failed", purchase_id: purchaseId });
    incrementCounter("nominara_billing_auto_topup_disabled_total", { reason: "payment_failed" });
    this.logger.warn({ message: "auto-top-up disabled after a failed payment", workspace_id: workspaceId, purchase_id: purchaseId });
  }

  /** Tells the billing contact it was switched off. A mail failure is logged and counted, never thrown: the state change has committed. */
  async notifyDisabled(workspaceId: string): Promise<void> {
    try {
      const contact = await this.inTx(workspaceId, (tx) => this.billingContact(tx, workspaceId));
      if (contact === null) {
        incrementCounter("nominara_billing_auto_topup_notify_failed_total", { reason: "no_billing_contact" });
        this.logger.error({ message: "auto-top-up disabled but nobody could be notified", workspace_id: workspaceId });
        return;
      }
      await this.email.send({
        to: contact,
        subject: AUTO_TOPUP_DISABLED_SUBJECT,
        textBody:
          "Nominara could not charge your saved card for an automatic credit top-up, so auto top-up has been switched off and will not retry. " +
          "Update your payment method and turn it back on in Billing settings.",
      });
    } catch {
      incrementCounter("nominara_billing_auto_topup_notify_failed_total", { reason: "send_failed" });
      this.logger.error({ message: "auto-top-up disabled but the notification could not be sent", workspace_id: workspaceId });
    }
  }

  // ---- helpers -----------------------------------------------------------------------------------

  /** The workspace's billing email, else its longest-standing active owner's. Null when neither exists. */
  private async billingContact(tx: ClientBase, workspaceId: string): Promise<string | null> {
    const result = await tx.query<{ email: string | null }>(
      `SELECT COALESCE(
                w.billing_email::text,
                (SELECT u.email::text FROM workspace_members m JOIN users u ON u.id = m.user_id
                  WHERE m.workspace_id = w.id AND m.role = 'owner' AND m.status = 'active' AND u.deleted_at IS NULL
                  ORDER BY m.joined_at, m.id LIMIT 1)
              ) AS email
         FROM workspaces w WHERE w.id = $1 AND w.deleted_at IS NULL`,
      [workspaceId],
    );
    return result.rows[0]?.email ?? null;
  }

  private async writeAudit(tx: ClientBase, workspaceId: string, action: string, resourceType: string, resourceId: string, before: unknown, after: unknown): Promise<void> {
    await this.audit.append(tx, {
      workspaceId,
      actorType: "system",
      actorId: SYSTEM_ACTOR_ID,
      actorIp: null,
      actorUa: "operator:auto-topup",
      action,
      resourceType,
      resourceId,
      beforeState: before,
      afterState: after,
      requestId: `auto-topup-${resourceId}`,
      supportGrantId: null,
      severity: "info",
    });
  }

  /** A short transaction on its own pooled connection, as the system actor in `workspaceId`'s context. */
  private async inTx<T>(workspaceId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
    } finally {
      client.release();
    }
  }
}
