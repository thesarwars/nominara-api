import { ADDON_KINDS, type AddonKind } from "../../entitlements/resolution.js";

// STORY-076b — the pure half of add-on reconciliation. A FRESHLY FETCHED Stripe
// subscription goes in; the add-on items it holds come out. The add-on lines
// are told apart from the plan line by the product's `nominara_kind` metadata
// (the same marker `desiredFromStripeSubscription` reads), so the subscription
// must be fetched with `items.data.price.product` expanded.

export interface AddonItem {
  readonly kind: AddonKind;
  readonly quantity: number;
  /** Stripe's `si_…` id: what a later quantity change or removal addresses. */
  readonly itemId: string;
  readonly unitAmountCents: number;
  /** Lower-case ISO 4217. Only `usd` is mirrored (the column is `unit_price_usd`). */
  readonly currency: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

const KINDS: ReadonlySet<string> = new Set(ADDON_KINDS);

export function addonItemsFromSubscription(raw: Readonly<Record<string, unknown>>): AddonItem[] {
  const container = raw.items;
  if (!isRecord(container) || !Array.isArray(container.data)) return [];

  const byKind = new Map<AddonKind, AddonItem>();
  for (const line of container.data) {
    if (!isRecord(line)) continue;
    const price = line.price;
    if (!isRecord(price) || !isRecord(price.product) || !isRecord(price.product.metadata)) continue;
    const kind = price.product.metadata.nominara_kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) continue;

    // Fail closed: a line that cannot be fully described is not mirrored.
    const quantity = line.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) continue;
    if (typeof line.id !== "string" || line.id.length === 0) continue;
    const unitAmount = price.unit_amount;
    if (typeof unitAmount !== "number" || !Number.isSafeInteger(unitAmount) || unitAmount < 0) continue;
    if (typeof price.currency !== "string" || price.currency.toLowerCase() !== "usd") continue;

    const existing = byKind.get(kind as AddonKind);
    if (existing === undefined) {
      byKind.set(kind as AddonKind, { kind: kind as AddonKind, quantity, itemId: line.id, unitAmountCents: unitAmount, currency: "usd" });
    } else {
      byKind.set(kind as AddonKind, { ...existing, quantity: existing.quantity + quantity });
    }
  }
  return ADDON_KINDS.flatMap((kind) => byKind.get(kind) ?? []);
}
