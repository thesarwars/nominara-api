import type { BillingInterval, ProviderSubscriptionState, SubscriptionStatus } from "../apply-plan.js";

// STORY-075 AC4 / AC5 — the pure half of fresh-fetch reconciliation. A
// FRESHLY FETCHED Stripe subscription goes in; the WHOLE local record, or a
// refusal to write one, comes out. No database, no clock: the arrival order of
// the events that triggered the fetch cannot reach this function, which is
// what makes two events delivered in either order write the same row.

export type DesiredSubscription =
  | { readonly kind: "write"; readonly state: ProviderSubscriptionState }
  | { readonly kind: "ignore"; readonly reason: string };

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

export function desiredFromStripeSubscription(
  raw: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, string>>,
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
  const first = lines[0];

  // API versions from 2025-03-31 moved the period onto the items; older ones
  // carry it on the subscription. Either way it is read from the fetch.
  const periodStart = seconds(raw.current_period_start) ?? seconds(first?.current_period_start);
  const periodEnd = seconds(raw.current_period_end) ?? seconds(first?.current_period_end);
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
