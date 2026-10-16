// STORY-184 — the ONE place a two-phase subscription schedule is shaped. A scheduled downgrade and a scheduled add-on
// removal both go through `buildTwoPhaseSchedule`; they used to be separate shapes, and the removal one was wrong.
//
// ⚠ A PHASE'S METADATA REPLACES THE SUBSCRIPTION'S WHEN THE PHASE STARTS. A phase built without `metadata` strips
// `plan_key` and `workspace_id` from the subscription at the cut-over, and the webhook then ignores it ("not created by
// this product"): the customer is billed for a plan the product no longer sees. So metadata is a REQUIRED part of both
// phases here — an empty object is passed as an empty object, never omitted — and the types make leaving it out a
// compile error.
//
// ⚠ NEITHER PHASE PRORATES. Phase 0 is the current plan to the period end, unchanged; phase 1 starts at the renewal,
// where there is nothing to pro-rate, and a stray credit or charge at the boundary would be money nobody quoted.

/** A line that names a price already in Stripe (the current plan, or an add-on). */
export interface PhaseLine {
  readonly price: string;
  readonly quantity?: number;
}

/** A line priced inline against a fixed product — the target plan item of a downgrade. */
export interface PhasePriceDataLine {
  readonly price_data: {
    readonly currency: string;
    readonly product: string;
    readonly unit_amount: number;
    readonly recurring: { readonly interval: "month" | "year" };
  };
  readonly quantity: number;
}

export type PhaseItem = PhaseLine | PhasePriceDataLine;

export interface TwoPhaseInput {
  readonly current: {
    readonly items: readonly PhaseLine[];
    readonly startDate: number;
    readonly endDate: number;
    readonly metadata: Readonly<Record<string, string>>;
  };
  readonly next: {
    readonly items: readonly PhaseItem[];
    readonly metadata: Readonly<Record<string, string>>;
    readonly interval: "month" | "year";
  };
}

export interface TwoPhaseSchedule {
  readonly end_behavior: "release";
  readonly phases: [
    {
      items: PhaseItem[];
      start_date: number;
      end_date: number;
      metadata: Record<string, string>;
      proration_behavior: "none";
    },
    {
      items: PhaseItem[];
      duration: { interval: "month" | "year"; interval_count: 1 };
      metadata: Record<string, string>;
      proration_behavior: "none";
    },
  ];
}

export function buildTwoPhaseSchedule(input: TwoPhaseInput): TwoPhaseSchedule {
  return {
    end_behavior: "release",
    phases: [
      {
        items: input.current.items.map((line) => ({ ...line })),
        start_date: input.current.startDate,
        end_date: input.current.endDate,
        metadata: { ...input.current.metadata },
        proration_behavior: "none",
      },
      {
        items: [...input.next.items],
        duration: { interval: input.next.interval, interval_count: 1 },
        metadata: { ...input.next.metadata },
        proration_behavior: "none",
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * The price-id lines of a schedule phase as Stripe returned them (`price` is an id, or an object carrying one). A line
 * with no price id cannot be re-sent and is dropped; a line with no quantity stays without one.
 */
export function phaseLinesOf(items: readonly unknown[]): PhaseLine[] {
  const out: PhaseLine[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const price = typeof item.price === "string" ? item.price : isRecord(item.price) && typeof item.price.id === "string" ? item.price.id : "";
    if (price.length === 0) continue;
    out.push(typeof item.quantity === "number" ? { price, quantity: item.quantity } : { price });
  }
  return out;
}

/** A metadata map as plain strings (Stripe's metadata is a flat string map; anything else is not carried). */
export function stringMetadataOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") out[key] = entry;
    }
  }
  return out;
}
