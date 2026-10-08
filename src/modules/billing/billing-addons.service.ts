import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { ADDON_MAX_QUANTITY, type Addon, type AddonChangeResponse, type AddonCreateRequest, type AddonListQuery } from "../../../contracts/billing/index.js";
import { ConflictError, DegradedError, FeatureNotInPlanError, NotFoundError, PreconditionUnmetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { Entitlement } from "../../db/seed/plan-entitlements.js";
import { ADDON_CATALOG, addonGrant } from "../../lib/billing/addon-catalog.js";
import { STRIPE_GATEWAY, StripeUpstreamError, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { addonItemsFromSubscription, type AddonItem } from "../../lib/billing/stripe/addon-items.js";
import { centsToDecimal } from "../../lib/billing/stripe/invoice-state.js";
import { toCents } from "../../lib/billing/stripe/subscription-state.js";
import { isFeatureGranted } from "../../lib/entitlements/classification.js";
import { ADDON_KINDS, resolveEntitlements, type AddonKind } from "../../lib/entitlements/resolution.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";

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
// ⚠ A QUANTITY IS A SET, NOT AN INCREMENT, AND THE REQUEST IS THE TOTAL. The
// request's `quantity` is the desired total, fixed by the caller, so a retry
// after Stripe applied the change (reply lost, timeout, a later commit failure)
// asks for the same number and cannot add a second unit. The held quantity is
// read from a FRESH fetch (never the local row, which lags the webhook); a total
// equal to it is a no-op and a lower one is a 409 (removal is DELETE). The Stripe
// idempotency key is derived from the workspace and the request's Idempotency-Key,
// so a retry replays Stripe's own answer. Two requests are serialised by the
// workspace row lock.
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
}

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

  constructor(@Inject(STRIPE_GATEWAY) private readonly gateway: StripeGateway) {}

  /** `GET /v1/billing/addons` — the add-ons in force, with the grant each unit carries. */
  async list(query: AddonListQuery): Promise<Page<Addon>> {
    const { client, workspaceId } = this.tenant();
    const after = query.cursor === undefined ? null : afterKind(query.cursor);
    const plan = await this.plan(client, workspaceId);
    // No workspace_id predicate: RLS scopes this to the context's workspace.
    const result = await client.query<AddonRow>(
      `SELECT id, kind, quantity, unit_price_usd::text, stripe_subscription_item_id,
              to_char(active_from AT TIME ZONE 'UTC', ${ISO_MS}) AS active_from,
              to_char(active_until AT TIME ZONE 'UTC', ${ISO_MS}) AS active_until
         FROM subscription_addons
        WHERE active_until IS NULL AND ($1::text IS NULL OR kind > $1)
        ORDER BY kind
        LIMIT $2`,
      [after, query.limit + 1],
    );
    return pageFrom(
      result.rows,
      query.limit,
      (row): Addon => ({
        id: row.id,
        kind: row.kind,
        quantity: row.quantity,
        unit_price_usd: row.unit_price_usd,
        grant: addonGrant(plan.entitlements, row.kind),
        active_from: row.active_from,
        active_until: row.active_until,
      }),
      (row) => [row.kind],
    );
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

    await client.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    const subscription = await this.liveSubscription(client, workspaceId);
    // Stripe requires every item of a subscription to share one interval, and only a monthly add-on price is decided.
    if (subscription.billing_interval !== "monthly") {
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "annual_unsupported" });
      throw new ConflictError({ message: "add-ons are available on monthly subscriptions only" });
    }

    try {
      const fetched = await this.gateway.fetchObject("subscription", subscription.stripe_subscription_id);
      if (fetched === null) throw new PreconditionUnmetError({ message: "the payment provider has no such subscription" });
      const held = addonItemsFromSubscription(fetched.raw).find((item) => item.kind === request.kind);
      const heldQuantity = held?.quantity ?? 0;
      const total = request.quantity;
      if (total > ADDON_MAX_QUANTITY) {
        incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "over_cap" });
        throw new ValidationFailedError({
          message: "too many units",
          details: { issues: [{ path: ["quantity"], message: `a workspace can hold at most ${String(ADDON_MAX_QUANTITY)} of one add-on` }] },
        });
      }
      if (total < heldQuantity) {
        incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "below_held" });
        throw new ConflictError({ message: "the requested total is below what this workspace holds: remove the add-on instead" });
      }
      // Already at the total (a retry whose first attempt landed): nothing to ask of Stripe, nothing to charge.
      if (total > heldQuantity) {
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
        await this.gateway.changeAddonQuantity({
          subscriptionId: subscription.stripe_subscription_id,
          kind: request.kind,
          quantity: total,
          existingItemId: held?.itemId ?? null,
          productName: `Nominara ${entry.displayName}`,
          unitAmountCents: toCents(entry.monthlyUsd),
          currency: "usd",
          interval: "month",
          proration: "create_prorations",
          idempotencyKey: addonIdempotencyKey(workspaceId, request.kind, idempotencyKey),
        });
      }
      incrementCounter("nominara_billing_addon_change_total", { kind: request.kind, outcome: "requested" });
      this.logger.log({ message: "add-on change requested", workspace_id: workspaceId, kind: request.kind, quantity_requested: total });
      return { kind: request.kind, status: "pending", quantity_requested: total, effective: "immediate", effective_at: null, grant: addonGrant(plan.entitlements, request.kind) };
    } catch (error) {
      throw this.upstream(error, request.kind);
    }
  }

  /** `DELETE /v1/billing/addons/{kind}` — removes the whole add-on at the period end. */
  async remove(kind: AddonKind): Promise<AddonChangeResponse> {
    this.requireConfigured();
    const { client, workspaceId } = this.tenant();
    await client.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);

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
    try {
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
      `SELECT plan_key, billing_interval, provider, stripe_subscription_id, current_period_end
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

/** Stripe keys are <= 255 chars: hash the caller's key so its length and content never reach Stripe. */
function addonIdempotencyKey(workspaceId: string, kind: AddonKind, requestKey: string): string {
  return `addon-${workspaceId}-${kind}-${createHash("sha256").update(requestKey).digest("hex").slice(0, 32)}`;
}

function afterKind(cursor: string): AddonKind {
  const [kind] = decodeCursor(cursor, 1);
  if (typeof kind !== "string" || !(ADDON_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor was not issued for this list" }] },
    });
  }
  return kind as AddonKind;
}
