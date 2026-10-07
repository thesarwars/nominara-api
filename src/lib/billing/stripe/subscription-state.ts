import type { BillingInterval, ProviderSubscriptionState, SubscriptionStatus } from "../apply-plan.js";

// STORY-075 AC4 / AC5 — the pure half of fresh-fetch reconciliation. A
// FRESHLY FETCHED Stripe subscription goes in; the WHOLE local record, or a
// refusal to write one, comes out. No database, no clock: the arrival order of
// the events that triggered the fetch cannot reach this function, which is
// what makes two events delivered in either order write the same row.

export type DesiredSubscription =
  | {
      readonly kind: "write";
      readonly state: ProviderSubscriptionState;
      /** The charge that was verified, for an entitled state; null for an ended one. It is what gets frozen on the row. */
      readonly charge: FrozenCharge | null;
    }
  /** `mismatch`: the subscription claims a plan that is not what Stripe charges for it. Refused, and worth an alarm. */
  | { readonly kind: "ignore"; readonly reason: string; readonly mismatch?: true };

/**
 * What the plan a subscription CLAIMS (its `plan_key` metadata) costs, from the
 * `plans` row — the only thing the charged price is checked against. `null` =
 * no such plan.
 */
export interface ClaimedPlanPrice {
  readonly monthlyCents: number;
  readonly annualCents: number;
  /** ISO 4217, any case. */
  readonly currency: string;
  /**
   * NEW-D-2 audit — the charge ADOPTED at checkout, frozen on our side. When
   * present it is what the plan item is compared with, and the catalog above is
   * not consulted: a later catalog price change must not freeze every existing
   * subscription (their Stripe price is the one they signed up at).
   */
  readonly frozen?: FrozenCharge;
}

/** What a subscription is charged: the amount, currency and interval of its plan item. */
export interface FrozenCharge {
  readonly unitAmountCents: number;
  /** ISO 4217, any case. */
  readonly currency: string;
  readonly interval: "month" | "year";
}

/** Statuses under which the customer is entitled to the paid plan. All three are "live" for `ux_subscriptions_active`. */
const ENTITLED: ReadonlySet<string> = new Set<SubscriptionStatus>(["active", "trialing", "past_due"]);

/**
 * Statuses under which the entitlement has ended.
 *
 * ⚠ THEY WRITE `free` + `active`, NOT THE PROVIDER'S STATUS, AND THAT IS
 * DELIBERATE. `applyPlanChange` only ever finds a LIVE subscription row
 * (trialing/active/past_due) and never inserts one, so a row left `canceled`
 * would be invisible to every later event — the customer could never buy again.
 * `free` + `active` keeps the one live row and the customer link (the portal
 * and a re-subscribe both need it).
 *
 * `unpaid` is here, not with past_due: Stripe leaves a subscription `unpaid`
 * once its retries are exhausted, and continuing to serve the paid plan for it
 * is giving the product away. `paused` is a subscription with no payment
 * method at trial end — nothing is being paid for either.
 */
const ENDED: ReadonlySet<string> = new Set(["canceled", "incomplete_expired", "unpaid", "paused"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function seconds(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) return value.id;
  return null;
}

function items(raw: Record<string, unknown>): Record<string, unknown>[] {
  const container = raw.items;
  if (!isRecord(container) || !Array.isArray(container.data)) return [];
  return container.data.filter(isRecord);
}

function productKind(item: Record<string, unknown>): string | null {
  const price = item.price;
  if (!isRecord(price) || !isRecord(price.product)) return null;
  const metadata = price.product.metadata;
  return isRecord(metadata) && typeof metadata.nominara_kind === "string" ? metadata.nominara_kind : null;
}

/** Dollars as Stripe wants them: integer cents, parsed from the `numeric(12,2)` text so no float is ever involved. */
export function toCents(price: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(price);
  if (match === null) throw new Error(`not a money amount: ${price}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

// ⚠ THE PLAN IS WHAT IS CHARGED, NOT WHAT THE METADATA SAYS. `plan_key` is a
// label our checkout wrote on the subscription; Stripe's billing portal can
// switch the price without rewriting it (an upgrade charged but never granted,
// a downgrade that keeps the dearer plan). So an entitled subscription is only
// reconciled when its plan item's unit amount, currency and interval equal what
// the claimed plan was priced at WHEN THE CUSTOMER BOUGHT IT (`frozen`), or, for
// a subscription whose price was never frozen, the catalog price now. Anything
// else is a `mismatch`: refused, never guessed at. An ended subscription is
// exempt — it can only take a plan AWAY.
//
// ⚠ NEVER THE CATALOG ONCE THERE IS A FROZEN CHARGE. Existing customers keep the
// Stripe price they signed up at, so comparing them with today's catalog would
// call every one of them a mismatch after the first price change.
function planItemCharge(planItem: Record<string, unknown> | undefined): FrozenCharge | null {
  if (planItem === undefined) return null;
  const price = planItem.price;
  if (!isRecord(price) || !isRecord(price.recurring)) return null;
  const interval = price.recurring.interval;
  const intervalCount = price.recurring.interval_count;
  if (interval !== "month" && interval !== "year") return null;
  if (intervalCount !== undefined && intervalCount !== 1) return null;
  if (planItem.quantity !== undefined && planItem.quantity !== 1) return null;
  if (typeof price.unit_amount !== "number" || typeof price.currency !== "string") return null;
  return { unitAmountCents: price.unit_amount, currency: price.currency, interval };
}

function chargedPriceMatches(charged: FrozenCharge | null, claimed: ClaimedPlanPrice | null): boolean {
  if (claimed === null || charged === null) return false;
  if (charged.currency.toLowerCase() !== (claimed.frozen?.currency ?? claimed.currency).trim().toLowerCase()) return false;
  if (claimed.frozen !== undefined) return charged.interval === claimed.frozen.interval && charged.unitAmountCents === claimed.frozen.unitAmountCents;
  return charged.unitAmountCents === (charged.interval === "year" ? claimed.annualCents : claimed.monthlyCents);
}

export function desiredFromStripeSubscription(
  raw: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, string>>,
  claimedPlan: ClaimedPlanPrice | null,
): DesiredSubscription {
  const status = typeof raw.status === "string" ? raw.status : "";
  if (status === "incomplete") return { kind: "ignore", reason: "subscription is incomplete: payment has not been taken" };
  if (!ENTITLED.has(status) && !ENDED.has(status)) return { kind: "ignore", reason: "subscription has an unrecognised status" };

  const planKey = metadata.plan_key;
  if (planKey === undefined || planKey.length === 0) return { kind: "ignore", reason: "subscription carries no plan_key: not created by this product" };

  const customerId = idOf(raw.customer);
  const subscriptionId = idOf(raw);
  if (customerId === null || subscriptionId === null) return { kind: "ignore", reason: "subscription carries no customer or id" };

  const lines = items(raw);
  // The item Checkout created for the plan itself; add-on items (STORY-076b) are other lines.
  const first = lines.find((line) => productKind(line) === "plan");

  const charge = planItemCharge(first);
  if (ENTITLED.has(status) && !chargedPriceMatches(charge, claimedPlan)) {
    return { kind: "ignore", mismatch: true, reason: "the price charged does not match the plan the subscription claims" };
  }

  // API versions from 2025-03-31 moved the period onto the items; older ones
  // carry it on the subscription. Either way it is read from the fetch.
  const periodStart = seconds(raw.current_period_start) ?? seconds((first ?? lines[0])?.current_period_start);
  const periodEnd = seconds(raw.current_period_end) ?? seconds((first ?? lines[0])?.current_period_end);
  if (periodStart === null || periodEnd === null) return { kind: "ignore", reason: "subscription carries no billing period" };

  // The interval Stripe actually charges beats the metadata we wrote at checkout.
  const price = first?.price;
  const recurring = isRecord(price) && isRecord(price.recurring) ? price.recurring.interval : undefined;
  const billingInterval: BillingInterval =
    recurring === "year" ? "annual" : recurring === "month" ? "monthly" : metadata.billing_interval === "annual" ? "annual" : "monthly";

  let extraSeats = 0;
  let extraProjects = 0;
  for (const line of lines) {
    const quantity = typeof line.quantity === "number" && line.quantity > 0 ? line.quantity : 0;
    const kind = productKind(line);
    if (kind === "extra_seat") extraSeats += quantity;
    if (kind === "extra_project") extraProjects += quantity;
  }

  const entitled = ENTITLED.has(status);
  return {
    kind: "write",
    // Verified above for an entitled state, so it is exactly what gets frozen on the row.
    charge: entitled ? charge : null,
    state: {
      provider: "stripe",
      providerCustomerId: customerId,
      providerSubscriptionId: subscriptionId,
      planKey: entitled ? planKey : "free",
      billingInterval,
      status: entitled ? (status as SubscriptionStatus) : "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialEndsAt: seconds(raw.trial_end),
      cancelAtPeriodEnd: raw.cancel_at_period_end === true,
      // plans: "plan base + extra_seat add-ons" — base is the column default, 1.
      seatsPurchased: 1 + extraSeats,
      projectsPurchased: extraProjects,
    },
  };
}
