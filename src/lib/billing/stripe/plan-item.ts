import { ADDON_KINDS, type AddonKind } from "../../entitlements/resolution.js";

// STORY-184 — reading the PLAN line and the ADD-ON lines off a freshly fetched Stripe subscription (fetched with
// `items.data.price.product` expanded, so a line is told apart by its product's `nominara_kind`, the same marker
// `desiredFromStripeSubscription` and `addonItemsFromSubscription` read).

export interface PlanItem {
  /** The subscription item (`si_…`) a plan update addresses. */
  readonly itemId: string;
  readonly priceId: string;
  readonly unitAmountCents: number | null;
  /** Lower-case ISO 4217. */
  readonly currency: string | null;
  readonly interval: "month" | "year" | null;
}

export interface AddonLine {
  readonly kind: AddonKind;
  readonly itemId: string;
  /** What a schedule phase names the line by. */
  readonly priceId: string;
  readonly quantity: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function lines(raw: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const container = raw.items;
  return isRecord(container) && Array.isArray(container.data) ? container.data.filter(isRecord) : [];
}

function kindOf(line: Record<string, unknown>): string | null {
  const price = line.price;
  if (!isRecord(price) || !isRecord(price.product) || !isRecord(price.product.metadata)) return null;
  const kind = price.product.metadata.nominara_kind;
  return typeof kind === "string" ? kind : null;
}

/** Every line that is a plan line. More than one is ambiguous — "the" plan item cannot be chosen — and callers refuse. */
export function planItemsOf(raw: Readonly<Record<string, unknown>>): PlanItem[] {
  const out: PlanItem[] = [];
  for (const line of lines(raw)) {
    if (kindOf(line) !== "plan" || typeof line.id !== "string" || line.id.length === 0) continue;
    const price = line.price as Record<string, unknown>;
    const interval = isRecord(price.recurring) ? price.recurring.interval : undefined;
    out.push({
      itemId: line.id,
      priceId: typeof price.id === "string" ? price.id : "",
      unitAmountCents: typeof price.unit_amount === "number" ? price.unit_amount : null,
      currency: typeof price.currency === "string" ? price.currency.toLowerCase() : null,
      interval: interval === "month" || interval === "year" ? interval : null,
    });
  }
  return out;
}

/** The add-on lines, one entry per line (not summed): a downgrade re-sends each by its price id and quantity. */
export function addonLinesOf(raw: Readonly<Record<string, unknown>>): AddonLine[] {
  const out: AddonLine[] = [];
  for (const line of lines(raw)) {
    const kind = kindOf(line);
    if (kind === null || !(ADDON_KINDS as readonly string[]).includes(kind)) continue;
    const price = line.price as Record<string, unknown>;
    if (typeof line.id !== "string" || typeof price.id !== "string" || price.id.length === 0) continue;
    if (typeof line.quantity !== "number" || !Number.isInteger(line.quantity) || line.quantity <= 0) continue;
    out.push({ kind: kind as AddonKind, itemId: line.id, priceId: price.id, quantity: line.quantity });
  }
  return out;
}

/**
 * When the subscription's CURRENT billing period began, in unix seconds, from the fresh fetch: on the subscription itself
 * (older API versions) or on its plan line (newer ones). `null` when Stripe states neither - the caller then falls back to
 * the local row, which lags the webhook.
 */
export function periodStartOf(raw: Readonly<Record<string, unknown>>): number | null {
  if (typeof raw.current_period_start === "number" && Number.isFinite(raw.current_period_start)) return raw.current_period_start;
  for (const line of lines(raw)) {
    if (kindOf(line) === "plan" && typeof line.current_period_start === "number" && Number.isFinite(line.current_period_start)) return line.current_period_start;
  }
  return null;
}
