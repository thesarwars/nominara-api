import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import {
  ADDON_MAX_QUANTITY,
  pendingAddonChangesSchema,
  type AddonChangeResponse,
  type AddonCreateRequest,
  type AddonListItem,
  type AddonListQuery,
  type PendingAddonChange,
  type PendingAddonChanges,
} from "../../../contracts/billing/index.js";
import { ConflictError, DegradedError, FeatureNotInPlanError, IdempotencyConflictError, NotFoundError, PreconditionUnmetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { Entitlement } from "../../db/seed/plan-entitlements.js";
import { ADDON_CATALOG, addonGrant } from "../../lib/billing/addon-catalog.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { readPendingPlanChange } from "../../lib/billing/plan-change-intent.js";
import { isDefiniteRejection } from "../../lib/billing/stripe/definite-rejection.js";
import { addonItemsFromSubscription, duplicatedAddonKinds, type AddonItem } from "../../lib/billing/stripe/addon-items.js";
import { centsToDecimal } from "../../lib/billing/stripe/invoice-state.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { isFeatureGranted } from "../../lib/entitlements/classification.js";
import { ADDON_KINDS, resolveEntitlements, type AddonKind } from "../../lib/entitlements/resolution.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { BILLING_WRITE_POOL, inBillingWriteTransaction } from "./billing-write-pool.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";

// STORY-076b / STORY-076 AC10-AC13 — the one owner of `subscription_addons`.
//
// ⚠ THE HANDLERS CHANGE STRIPE AND WRITE NOTHING LOCAL. `add` and `remove` ask
// Stripe to change a subscription item and answer `pending`. The local add-on
// rows, `seats_purchased`, `projects_purchased` and the entitlement version
// change only in `reconcile`, which the signature-verified webhook calls with
// the FRESHLY FETCHED subscription — the same wholesale rule as the plan itself
// (STORY-075), so an add-on is never granted on a say-so and never lost to an
// event arriving out of order.
//
// ⚠ A POST ADDS, AND A RETRY MUST NOT ADD AGAIN (owner decision, 2026-10-08). The
// request's `quantity` is the number of units to add to the held quantity, which
// is read from a FRESH Stripe fetch (never the local row, which lags the webhook).
// An increment is not idempotent by itself: if Stripe applied the change and the
// reply was lost, "held + quantity" computed again on the retry charges a second
// unit. So the chain is Idempotency-Key -> STORED INTENT -> Stripe key: the first
// time a key is seen, the target total (held + quantity) and a fresh Stripe
// idempotency key are committed to `subscriptions.pending_addon_changes` in their
// own short transaction BEFORE Stripe is asked; a retry under the same key reads
// that intent and re-asks for the STORED total with the STORED key (Stripe replays
// its own answer for a key it has seen). THE CALL ITSELF IS FROZEN WITH IT, not only its total: create versus
// update, and the item id. Stripe refuses a key reused with a different endpoint or parameters (400
// `idempotency_error`), so a lost-reply CREATE retried as an UPDATE (the fresh fetch now shows the item) would be
// refused, and a refusal mistaken for a rejection would release the intent and let the next retry add a second
// unit. A retry replays the stored call byte for byte. Once Stripe accepts a change the intent is marked
// `settled_at`, and only that marker, never a comparison of quantities, makes a retry a no-op.
// While an earlier intent of the same kind is unresolved, a new purchase is a 409. The same key with a
// different kind or quantity is 409 idempotency_conflict. Two requests are
// serialised by the workspace row lock.
//
// ⚠ REMOVAL FOLLOWS THE PERIOD-END POLICY (AC13), AND STORY-077 IS NOT BUILT.
// With no downgrade/retention machinery to call, the removal is scheduled at the
// current period end in Stripe (a subscription schedule drops the item then);
// the add-on stays in force, and billed, until the reconciler sees the item gone.
// STORY-077 owns anything beyond that (pausing the projects, prompts and seats
// that no longer fit). DEFERRED, and said so here rather than left silent.
//
// ⚠ ONE KNOWN DEVIATION, THE SAME AS CHECKOUT'S: the request's transaction is
// open (and holds the workspace row lock) while Stripe answers. Each call is
// bounded at 10 s by the gateway.

interface PlanRow {
  plan_key: string;
  entitlements: Record<string, Entitlement>;
}

interface SubscriptionRow {
  plan_key: string;
  billing_interval: "monthly" | "annual";
  provider: string;
  stripe_subscription_id: string;
  current_period_end: Date;
  pending_addon_changes: unknown;
  pending_plan_change: unknown;
}

/** The most intents kept per subscription. Only intents past INTENT_RETENTION_MS are ever dropped to make room; a full map of live ones refuses (409). */
const MAX_PENDING_INTENTS = 20;

/** Stripe forgets an idempotency key after this long: an unresolved intent older than it can neither block nor be retried. */
const INTENT_RETENTION_MS = 24 * 60 * 60 * 1000;

interface AddonRow {
  id: string;
  kind: AddonKind;
  quantity: number;
  unit_price_usd: string;
  stripe_subscription_item_id: string;
  active_from: string;
  active_until: string | null;
}

interface ActiveRow {
  id: string;
  kind: AddonKind;
  quantity: number;
  unit_price_usd: string;
  stripe_subscription_item_id: string;
  subscription_id: string;
}

export interface AddonReconcileInput {
  readonly workspaceId: string;
  /** The Stripe subscription whose fresh fetch `items` came from. */
  readonly stripeSubscriptionId: string;
  /** Empty for an ended subscription: every add-on closes. */
  readonly items: readonly AddonItem[];
  readonly eventId: string;
  readonly eventType: string;
  /** `applyPlanChange` already bumped `entitlement_version` in this transaction. */
  readonly versionAlreadyBumped: boolean;
}

const ISO_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

@Injectable()
export class BillingAddonsService {
  private readonly logger = new Logger(BillingAddonsService.name);

  constructor(
    @Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway,
    @Inject(BILLING_WRITE_POOL) private readonly pool: Pool,
  ) {}

  /**
   * `GET /v1/billing/addons` — the purchasable catalog with prices, one entry per kind, and what the
   * workspace holds of each (owner decision, 2026-10-08). A kind not in force is quantity 0.
   */
  async list(query: AddonListQuery): Promise<Page<AddonListItem>> {
    const { client, workspaceId } = this.tenant();
    const after = query.cursor === undefined ? null : afterKind(query.cursor);
    const plan = await this.plan(client, workspaceId);
    // No workspace_id predicate: RLS scopes this to the context's workspace.
    const held = (
      await client.query<AddonRow>(
        `SELECT id, kind, quantity, unit_price_usd::text, stripe_subscription_item_id,
                to_char(active_from AT TIME ZONE 'UTC', ${ISO_MS}) AS active_from,
                to_char(active_until AT TIME ZONE 'UTC', ${ISO_MS}) AS active_until
           FROM subscription_addons
          WHERE active_until IS NULL`,
      )
    ).rows;
    const kinds = [...ADDON_KINDS].sort().filter((kind) => after === null || kind > after);
    const items = kinds.slice(0, query.limit + 1).map((kind): AddonListItem => {
      const entry = ADDON_CATALOG[kind];
      const row = held.find((r) => r.kind === kind);
      return {
        kind,
        display_name: entry.displayName,
        // The price in force for a held add-on is the one Stripe charges it at; the catalog's otherwise.
        unit_price_usd: row?.unit_price_usd ?? entry.monthlyUsd,
        purchasable: isFeatureGranted(plan.entitlements[entry.allowedKey]?.value ?? null),
        quantity: row?.quantity ?? 0,
        grant: addonGrant(plan.entitlements, kind),
        id: row?.id ?? null,
        active_from: row?.active_from ?? null,
        active_until: row?.active_until ?? null,
      };
    });
    return pageFrom(items, query.limit, "billing.addons", (item) => item, (item) => [item.kind]);
  }

  /** `POST /v1/billing/addons` — sets the add-on to the requested total; pro-rated by Stripe. */
  async add(request: AddonCreateRequest, idempotencyKey: string): Promise<AddonChangeResponse> {
    this.requireConfigured();
    const { client, workspaceId } = this.tenant();
    const entry = ADDON_CATALOG[request.kind];

    // ⚠ ELIGIBILITY BEFORE ANY LOCK OR STRIPE CALL. The tier that first grants
    // the flag is read from `plans`, never named here.
    const plan = await this.plan(client, workspaceId);
    if (!isFeatureGranted(plan.entitlements[entry.allowedKey]?.value ?? null)) {
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "not_in_plan" });
      throw new FeatureNotInPlanError({ details: { key: entry.allowedKey, min_plan: await this.minimumPlan(client, entry.allowedKey) } });
    }

    await this.lockWorkspace(client, workspaceId, request.kind);
    const subscription = await this.liveSubscription(client, workspaceId);
    // Stripe requires every item of a subscription to share one interval, and only a monthly add-on price is decided.
    if (subscription.billing_interval !== "monthly") {
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "annual_unsupported" });
      throw new ConflictError({ message: "add-ons are available on monthly subscriptions only" });
    }

    const intents = pendingAddonChangesSchema.parse(subscription.pending_addon_changes ?? {});
    const mapKey = intentKey(idempotencyKey);
    const stored = intents[mapKey];
    // The same Idempotency-Key must mean the same purchase: a different one is the caller's bug, not a retry.
    if (stored !== undefined && (stored.kind !== request.kind || stored.quantity !== request.quantity)) {
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "idempotency_conflict" });
      throw new IdempotencyConflictError({
        message: "this Idempotency-Key was already used for a different add-on request",
        // Hashes and a time only: the first request may have been another member's.
        details: {
          key_hash: mapKey,
          original_request_hash: createHash("sha256").update(`${stored.kind}:${String(stored.quantity)}`).digest("hex"),
          original_recorded_at: stored.created_at,
        },
      });
    }

    // ⚠ APPLIED-NESS IS A MARKER, NEVER A COMPARISON OF QUANTITIES. `settled_at` is written only after
    // Stripe accepted this very change, so a settled retry is answered without a call. Comparing the held
    // quantity to the stored total cannot tell whose change moved it: another purchase landing in between
    // made a retry look applied when it never reached Stripe (checkpoint-3 ADV-1).
    if (stored?.settled_at !== undefined) {
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "replayed_applied" });
      this.logger.log({ message: "add-on change already applied; retry answered without a Stripe call", workspace_id: workspaceId, kind: request.kind });
      return { kind: request.kind, status: "pending", quantity_requested: stored.target_total, effective: "immediate", effective_at: null, grant: addonGrant(plan.entitlements, request.kind) };
    }
    const now = Date.now();
    const live = (intent: PendingAddonChange): boolean => now - Date.parse(intent.created_at) < INTENT_RETENTION_MS;
    if (stored !== undefined && !live(stored)) {
      // Stripe has forgotten the key: re-sending could apply the change a second time, and nothing says whether it was applied.
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "intent_expired" });
      throw new ConflictError({ message: "this request is too old to retry: check the current quantity and submit again under a new Idempotency-Key" });
    }
    // An unsettled intent that froze no Stripe call (written before the field existed) cannot be replayed
    // byte for byte, and re-deriving the call is the very hazard it exists to prevent: fail closed.
    if (stored !== undefined && stored.stripe_call === undefined) {
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "intent_unreplayable" });
      throw new ConflictError({ message: "this request cannot be retried: check the current quantity and submit again under a new Idempotency-Key" });
    }
    // ⚠ ONE UNRESOLVED PURCHASE PER KIND. An earlier attempt whose outcome is unknown may or may not be in
    // Stripe; a new purchase computed from "held + quantity" could neither include it nor be told apart
    // from it. The earlier request is retried first (or ages out); never guess.
    if (stored === undefined && Object.values(intents).some((other) => other.kind === request.kind && other.settled_at === undefined && live(other))) {
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "earlier_change_unresolved" });
      throw new ConflictError({ message: "an earlier purchase of this add-on has not been confirmed yet: retry it first, or wait for it to expire" });
    }

    try {
      const fetched = await this.gateway.fetchObject("subscription", subscription.stripe_subscription_id);
      if (fetched === null) throw new PreconditionUnmetError({ message: "the payment provider has no such subscription" });
      this.refuseDuplicateLines(fetched.raw, request.kind, workspaceId);
      const held = addonItemsFromSubscription(fetched.raw).find((item) => item.kind === request.kind);
      const heldQuantity = held?.quantity ?? 0;
      // A retry asks for the STORED total, never "held + quantity" again: that would add a second unit.
      const target = stored?.target_total ?? heldQuantity + request.quantity;
      if (stored === undefined && target > ADDON_MAX_QUANTITY) {
        incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "over_cap" });
        throw new ValidationFailedError({
          message: "too many units",
          details: { issues: [{ path: ["quantity"], message: `a workspace can hold at most ${String(ADDON_MAX_QUANTITY)} of one add-on` }] },
        });
      }
      // ⚠ A SCHEDULED REMOVAL FREEZES THE NEXT PHASE'S ITEMS (audit). The schedule's second phase was
      // built from the items as they were at DELETE time; a quantity changed now would be silently
      // reverted at renewal (and the seat check of AC12 never runs for it). Refuse, with the reason,
      // until Stripe releases the schedule. Whether Stripe even accepts a direct item change on a
      // scheduled subscription is collected against the sandbox (NEW-A-17).
      const schedule = (fetched.raw as { schedule?: unknown }).schedule;
      if (schedule !== null && schedule !== undefined) {
        incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "removal_scheduled_conflict" });
        throw new ConflictError({ message: "an add-on removal is scheduled for the end of this billing period: add-ons cannot be changed until it has taken effect" });
      }
      // ⚠ COMMITTED BEFORE STRIPE IS ASKED, on its own connection: the request's transaction commits
      // only after the response is built, and a request that dies after Stripe applied the change
      // must not take the record of what it asked for with it.
      const recorded: PendingAddonChanges =
        stored !== undefined
          ? intents
          : await this.recordIntent(workspaceId, mapKey, intents, {
              kind: request.kind,
              quantity: request.quantity,
              target,
              call: held === undefined ? { operation: "create", item_id: null } : { operation: "update", item_id: held.itemId },
            });
      const intent = recorded[mapKey]!;
      // The STORED call, never the fresh fetch's: a create whose reply was lost shows an item by now.
      const call = intent.stripe_call!;
      try {
        await this.gateway.changeAddonQuantity({
          subscriptionId: subscription.stripe_subscription_id,
          kind: request.kind,
          quantity: intent.target_total,
          existingItemId: call.item_id,
          productName: `Nominara ${entry.displayName}`,
          unitAmountCents: toCents(entry.monthlyUsd),
          currency: "usd",
          interval: "month",
          proration: "create_prorations",
          idempotencyKey: intent.stripe_idempotency_key,
        });
      } catch (error) {
        // A definite rejection (4xx other than a timeout, conflict, rate limit or idempotency_error) means Stripe
        // applied nothing: release the intent so it neither blocks the next purchase nor is retried against a stale total.
        if (error instanceof StripeUpstreamError && isDefiniteRejection(error)) {
          const rest = { ...recorded };
          delete rest[mapKey];
          await this.persistIntents(workspaceId, rest);
        }
        throw error;
      }
      await this.persistIntents(workspaceId, { ...recorded, [mapKey]: { ...intent, settled_at: new Date().toISOString() } });
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "requested" });
      this.logger.log({ message: "add-on change requested", workspace_id: workspaceId, kind: request.kind, quantity_requested: intent.target_total });
      return { kind: request.kind, status: "pending", quantity_requested: intent.target_total, effective: "immediate", effective_at: null, grant: addonGrant(plan.entitlements, request.kind) };
    } catch (error) {
      throw this.upstream(error, request.kind);
    }
  }

  /** `DELETE /v1/billing/addons/{kind}` — removes the whole add-on at the period end. */
  async remove(kind: AddonKind): Promise<AddonChangeResponse> {
    this.requireConfigured();
    const { client, workspaceId } = this.tenant();
    await this.lockWorkspace(client, workspaceId, kind);

    const held = (
      await client.query<ActiveRow>(
        "SELECT id, kind, quantity, unit_price_usd::text, stripe_subscription_item_id, subscription_id FROM subscription_addons WHERE kind = $1 AND active_until IS NULL",
        [kind],
      )
    ).rows[0];
    if (held === undefined) throw new NotFoundError({ message: "this workspace has no such add-on" });

    // ⚠ BEFORE ANY STRIPE CALL (AC12): a seat is not removed from under members who occupy it.
    if (kind === "extra_seat") await this.refuseIfMembersWouldExceed(client, workspaceId, held.quantity);

    const [plan, subscription] = [await this.plan(client, workspaceId), await this.liveSubscription(client, workspaceId)];
    // ⚠ STORY-184 — a scheduled downgrade owns the subscription's schedule. Rewriting its second phase to drop an add-on
    // would silently change what the customer was shown (and the cancel of the downgrade would release the removal with
    // it), so the removal waits until the downgrade has taken effect or been cancelled.
    if (readPendingPlanChange(subscription.pending_plan_change).kind !== "none") {
      incrementCounter("nominara_billing_addon_change_total", { kind, outcome: "plan_change_pending" });
      throw new ConflictError({ message: "a plan change is pending on this subscription: wait for it to take effect, or cancel it, before removing an add-on", details: { reason: "plan_change_pending" } });
    }
    try {
      // A fresh fetch: the local row lags the webhook and cannot show a second Stripe line.
      const fetched = await this.gateway.fetchObject("subscription", subscription.stripe_subscription_id);
      if (fetched === null) throw new PreconditionUnmetError({ message: "the payment provider has no such subscription" });
      this.refuseDuplicateLines(fetched.raw, kind, workspaceId);
      await this.gateway.scheduleAddonRemoval({
        subscriptionId: subscription.stripe_subscription_id,
        itemId: held.stripe_subscription_item_id,
        idempotencyKey: `addon-removal-${uuidV7()}`,
      });
      incrementCounter("nominara_billing_addon_change_total", { kind, outcome: "removal_scheduled" });
      this.logger.log({ message: "add-on removal scheduled at the period end", workspace_id: workspaceId, kind });
      return {
        kind,
        status: "pending",
        quantity_requested: 0,
        effective: "period_end",
        effective_at: subscription.current_period_end.toISOString(),
        grant: addonGrant(plan.entitlements, kind),
      };
    } catch (error) {
      throw this.upstream(error, kind);
    }
  }

  /**
   * The ONLY writer of `subscription_addons`: mirrors the add-on items of a
   * freshly fetched subscription, wholesale, inside the webhook's tenant-context
   * transaction (the caller holds the workspace row lock). Idempotent: an
   * unchanged set writes nothing, bumps nothing and audits nothing.
   */
  async reconcile(tx: ClientBase, input: AddonReconcileInput): Promise<{ readonly changed: boolean }> {
    const subscription = await tx.query<{ id: string }>(
      "SELECT id FROM subscriptions WHERE workspace_id = $1 AND stripe_subscription_id = $2 AND status IN ('trialing','active','past_due')",
      [input.workspaceId, input.stripeSubscriptionId],
    );
    const subscriptionId = subscription.rows[0]?.id;
    if (subscriptionId === undefined) return { changed: false };

    const active = (
      await tx.query<ActiveRow>(
        `SELECT id, kind, quantity, unit_price_usd::text, stripe_subscription_item_id, subscription_id
           FROM subscription_addons WHERE workspace_id = $1 AND active_until IS NULL FOR UPDATE`,
        [input.workspaceId],
      )
    ).rows;

    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    let changed = false;
    for (const kind of ADDON_KINDS) {
      const row = active.find((r) => r.kind === kind);
      const item = input.items.find((i) => i.kind === kind);
      if (row !== undefined) before[kind] = row.quantity;
      if (item !== undefined) after[kind] = item.quantity;

      if (item === undefined) {
        if (row === undefined) continue;
        await tx.query("UPDATE subscription_addons SET active_until = now(), updated_at = now() WHERE id = $1", [row.id]);
        changed = true;
        continue;
      }
      const price = centsToDecimal(item.unitAmountCents);
      if (row === undefined) {
        await tx.query(
          `INSERT INTO subscription_addons (workspace_id, subscription_id, kind, quantity, unit_price_usd, stripe_subscription_item_id)
           VALUES ($1, $2, $3, $4, $5::numeric, $6)`,
          [input.workspaceId, subscriptionId, kind, item.quantity, price, item.itemId],
        );
        changed = true;
      } else if (
        row.quantity !== item.quantity ||
        row.unit_price_usd !== price ||
        row.stripe_subscription_item_id !== item.itemId ||
        row.subscription_id !== subscriptionId
      ) {
        await tx.query(
          `UPDATE subscription_addons
              SET quantity = $2, unit_price_usd = $3::numeric, stripe_subscription_item_id = $4, subscription_id = $5, updated_at = now()
            WHERE id = $1`,
          [row.id, item.quantity, price, item.itemId, subscriptionId],
        );
        changed = true;
      }
    }
    if (!changed) {
      incrementCounter("nominara_billing_addon_reconcile_total", { outcome: "unchanged" });
      return { changed: false };
    }

    // The version IS the cache key (plans-and-entitlements §8): any add-on change bumps it, once per transaction.
    if (!input.versionAlreadyBumped) {
      await tx.query("UPDATE workspaces SET entitlement_version = entitlement_version + 1, updated_at = now() WHERE id = $1", [input.workspaceId]);
    }
    // Inside the same transaction: an add-on change with no audit row rolls back.
    await new AuditChainService().append(tx, {
      workspaceId: input.workspaceId,
      actorType: "system",
      actorId: SYSTEM_ACTOR_ID,
      actorIp: null,
      actorUa: "operator:stripe-webhook",
      action: "billing.addons_reconciled",
      resourceType: "workspace",
      resourceId: input.workspaceId,
      beforeState: { addons: before },
      afterState: { addons: after, event_type: input.eventType },
      requestId: input.eventId,
      supportGrantId: null,
      severity: "info",
    });
    incrementCounter("nominara_billing_addon_reconcile_total", { outcome: "changed" });
    this.logger.log({ message: "add-ons reconciled from stripe", event_id: input.eventId, workspace_id: input.workspaceId, addons: after });
    return { changed: true };
  }

  /**
   * ⚠ THE LOCK WAIT IS BOUNDED. `add` commits its intent on a SECOND pooled connection while it holds
   * the lock (`add` and `remove` alike); requests queued behind it each hold a connection of their own. With enough of them queued
   * the pool is empty, the holder waits for a connection no waiter will give back, and every one of
   * them hangs. A wait of at most `WORKSPACE_LOCK_WAIT_MS` makes that a retryable 409 instead of a hang: the
   * waiters give their connections back and the holder proceeds. The setting is transaction-local.
   */
  private async lockWorkspace(client: ClientBase, workspaceId: string, kind: AddonKind): Promise<void> {
    await lockWorkspaceBounded(client, workspaceId, () => {
      incrementCounter("nominara_billing_addon_change_total", { kind, outcome: "lock_wait_exceeded" });
      return new ConflictError({ message: "another billing change for this workspace is in progress: retry shortly" });
    });
  }

  /**
   * Commits the intent for this Idempotency-Key in its own short transaction and returns it. Called with
   * the workspace row lock held by the request, so the read-modify-write of the map cannot interleave
   * with another purchase's. The map is capped, dropping the oldest, so the column cannot grow without bound.
   */
  private async recordIntent(
    workspaceId: string,
    mapKey: string,
    current: PendingAddonChanges,
    change: { readonly kind: AddonKind; readonly quantity: number; readonly target: number; readonly call: NonNullable<PendingAddonChange["stripe_call"]> },
  ): Promise<PendingAddonChanges> {
    const id = uuidV7();
    const intent: PendingAddonChange = {
      id,
      kind: change.kind,
      quantity: change.quantity,
      target_total: change.target,
      stripe_idempotency_key: `addon-${id}`,
      stripe_call: change.call,
      created_at: new Date().toISOString(),
    };
    // ⚠ NEVER EVICT AN INTENT STRIPE STILL REMEMBERS. An unsettled one is the only record that makes its retry
    // replay the stored call instead of recomputing "held + quantity" (a second unit); a settled one is what a
    // different member reusing the key is answered from (the interceptor is scoped per user). Only an intent
    // older than Stripe's key retention is of no further use, so room is made from those, oldest first, and
    // only as far as needed. A map full of live intents refuses the purchase (retryable) rather than guess.
    const now = Date.now();
    const byAge = Object.entries(current).sort(([, x], [, y]) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0));
    const expired = byAge.filter(([, other]) => now - Date.parse(other.created_at) >= INTENT_RETENTION_MS);
    const surplus = byAge.length - (MAX_PENDING_INTENTS - 1);
    if (surplus > expired.length) {
      incrementCounter("nominara_billing_addon_change_total", { kind: change.kind, outcome: "intent_store_full" });
      throw new ConflictError({ message: "too many recent add-on purchases are still being tracked: retry in a few minutes, or retry an earlier request first" });
    }
    const evict = new Set(expired.slice(0, Math.max(0, surplus)).map(([key]) => key));
    const next: PendingAddonChanges = { ...Object.fromEntries(byAge.filter(([key]) => !evict.has(key))), [mapKey]: intent };
    await this.persistIntents(workspaceId, next);
    return next;
  }

  /** Writes the whole intent map in its own short transaction (the request holds the workspace row lock). */
  private async persistIntents(workspaceId: string, next: PendingAddonChanges): Promise<void> {
    const { actorId } = this.tenant();
    await inBillingWriteTransaction(this.pool, { workspaceId, actorId }, async (tx) => {
      const result = await tx.query(
        "UPDATE subscriptions SET pending_addon_changes = $2::jsonb, updated_at = now() WHERE workspace_id = $1 AND status IN ('trialing','active','past_due')",
        [workspaceId, JSON.stringify(next)],
      );
      // Fail closed: with no record committed, Stripe must not be asked.
      if (result.rowCount !== 1) throw new PreconditionUnmetError({ message: "this workspace has no billing subscription yet: start one first" });
    });
  }

  /**
   * ⚠ MONEY ALARM. Two Stripe lines of one kind (a create that timed out but was applied, then
   * retried under a new Idempotency-Key) make "the" item ambiguous: a quantity sent to one leaves
   * the customer billed for both, and a removal of one leaves the other billing forever. Neither
   * is guessed at: 409, an alarm metric and a redacted log line, for a human to reconcile in Stripe.
   */
  private refuseDuplicateLines(raw: Readonly<Record<string, unknown>>, kind: AddonKind, workspaceId: string): void {
    if (!duplicatedAddonKinds(raw).includes(kind)) return;
    incrementCounter("nominara_billing_addon_duplicate_lines_total", { kind });
    incrementCounter("nominara_billing_addon_change_total", { kind, outcome: "duplicate_lines" });
    this.logger.error({ message: "MONEY ALARM: stripe holds more than one line of an add-on kind; change refused", workspace_id: workspaceId, kind });
    throw new ConflictError({ message: "this add-on is held on more than one billing line: it cannot be changed until support reconciles it" });
  }

  private async refuseIfMembersWouldExceed(client: ClientBase, workspaceId: string, removing: number): Promise<void> {
    const resolved = (await resolveEntitlements(client, workspaceId)).entitlements["seats.max"];
    // An override is absolute and a non-numeric ceiling is open: removing the add-on moves neither.
    if (resolved === undefined || resolved.source !== "add_on" || typeof resolved.value !== "number") return;
    const reduced = resolved.value - removing;
    // The same count the seat ceiling is enforced against (structural-usage): a removed member has released the seat, a suspended one has not.
    const members = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND status <> 'removed'", [workspaceId])).rows[0]!.n;
    if (members > reduced) {
      incrementCounter("nominara_billing_addon_change_total", { kind: "extra_seat", outcome: "members_exceed_limit" });
      throw new ConflictError({
        // ConflictError's typed details carry no limit/current, so the figures are in the message.
        message: `${String(members)} members are active but the reduced seat limit would be ${String(reduced)}: remove members first`,
      });
    }
  }

  private async plan(client: ClientBase, workspaceId: string): Promise<PlanRow> {
    const result = await client.query<PlanRow>(
      "SELECT w.plan_key, p.entitlements FROM workspaces w JOIN plans p ON p.key = w.plan_key WHERE w.id = $1",
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "workspace not found" });
    return row;
  }

  /** The lowest tier whose plan grants the flag, from `plans`. */
  private async minimumPlan(client: ClientBase, key: string): Promise<string> {
    const result = await client.query<{ key: string }>(
      "SELECT key FROM plans WHERE entitlements -> $1 -> 'value' = 'true'::jsonb ORDER BY sort_order LIMIT 1",
      [key],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no plan grants '${key}': the add-on cannot be sold`);
    return row.key;
  }

  private async liveSubscription(client: ClientBase, workspaceId: string): Promise<SubscriptionRow> {
    const result = await client.query<SubscriptionRow>(
      `SELECT plan_key, billing_interval, provider, stripe_subscription_id, current_period_end, pending_addon_changes, pending_plan_change
         FROM subscriptions WHERE workspace_id = $1 AND status IN ('trialing','active','past_due')`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined || row.provider !== "stripe" || row.stripe_subscription_id.length === 0) {
      throw new PreconditionUnmetError({ message: "this workspace has no billing subscription yet: start one first" });
    }
    return row;
  }

  private requireConfigured(): void {
    if (!this.gateway.isConfigured()) {
      incrementCounter("nominara_billing_addon_change_total", { kind: "any", outcome: "not_configured" });
      throw new DegradedError({ message: "payment provider is not configured" });
    }
  }

  private upstream(error: unknown, kind: AddonKind): unknown {
    if (!(error instanceof StripeUpstreamError)) return error;
    incrementCounter("nominara_billing_addon_change_total", { kind, outcome: "upstream_error" });
    // Status code only: Stripe's own text can echo request details.
    this.logger.error({ message: "stripe add-on change failed", status: error.statusCode });
    return new DegradedError({ message: "payment provider is unavailable" });
  }

  private tenant() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("BillingAddonsService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }
}

/** The map key an Idempotency-Key is stored under: hashed, so the caller's key (and its length) is never persisted. */
function intentKey(requestKey: string): string {
  return createHash("sha256").update(requestKey).digest("hex").slice(0, 32);
}

function afterKind(cursor: string): AddonKind {
  const [kind] = decodeCursor(cursor, "billing.addons", 1);
  if (typeof kind !== "string" || !(ADDON_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor was not issued for this list" }] },
    });
  }
  return kind as AddonKind;
}
