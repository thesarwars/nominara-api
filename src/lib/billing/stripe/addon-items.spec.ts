import { describe, expect, it } from "vitest";
import { addonItemsFromSubscription, duplicatedAddonKinds } from "./addon-items.js";

// STORY-076b — the pure half of add-on reconciliation: a FRESHLY FETCHED
// subscription in, the add-on items it holds out. No database, no clock.

const item = (kind: string | null, over: Record<string, unknown> = {}) => ({
  id: `si_${kind ?? "none"}`,
  quantity: 1,
  price: { unit_amount: 4900, currency: "usd", recurring: { interval: "month" }, product: { metadata: kind === null ? {} : { nominara_kind: kind } } },
  ...over,
});
const sub = (...items: unknown[]) => ({ id: "sub_1", items: { data: items } });

describe("STORY-076b · addonItemsFromSubscription", () => {
  it("AC1 · reads each add-on line's kind, quantity, item id and unit price from the fetched subscription", () => {
    const out = addonItemsFromSubscription(sub(item("plan"), item("extra_project", { quantity: 2 }), item("extra_seat", { quantity: 3, price: { unit_amount: 1500, currency: "usd", recurring: { interval: "month" }, product: { metadata: { nominara_kind: "extra_seat" } } } })));
    expect(out).toEqual([
      { kind: "extra_project", quantity: 2, itemId: "si_extra_project", unitAmountCents: 4900, currency: "usd" },
      { kind: "extra_seat", quantity: 3, itemId: "si_extra_seat", unitAmountCents: 1500, currency: "usd" },
    ]);
  });

  it("the plan item and lines of other products are not add-ons", () => {
    expect(addonItemsFromSubscription(sub(item("plan"), item("credit_pack"), item(null)))).toEqual([]);
  });

  it("empty and malformed subscriptions yield no add-ons rather than throwing", () => {
    expect(addonItemsFromSubscription({})).toEqual([]);
    expect(addonItemsFromSubscription({ items: null })).toEqual([]);
    expect(addonItemsFromSubscription({ items: { data: "x" } })).toEqual([]);
    expect(addonItemsFromSubscription(sub(null, 7, "x"))).toEqual([]);
  });

  it("boundary · a zero, negative, fractional or missing quantity is not a grant", () => {
    for (const quantity of [0, -1, 1.5, undefined, "2"]) {
      expect(addonItemsFromSubscription(sub(item("extra_seat", { quantity })))).toEqual([]);
    }
  });

  it("a line without an item id or an integer unit amount is not mirrored (fail closed)", () => {
    expect(addonItemsFromSubscription(sub(item("extra_seat", { id: undefined })))).toEqual([]);
    expect(addonItemsFromSubscription(sub(item("extra_seat", { price: { unit_amount: null, currency: "usd", product: { metadata: { nominara_kind: "extra_seat" } } } })))).toEqual([]);
  });

  it("a non-USD add-on line is not mirrored into a USD column", () => {
    expect(addonItemsFromSubscription(sub(item("extra_seat", { price: { unit_amount: 1500, currency: "eur", product: { metadata: { nominara_kind: "extra_seat" } } } })))).toEqual([]);
  });

  it("two lines of one kind are summed into one add-on, keeping the first item id", () => {
    const out = addonItemsFromSubscription(sub(item("extra_seat", { id: "si_a", quantity: 2 }), item("extra_seat", { id: "si_b", quantity: 3 })));
    expect(out).toEqual([{ kind: "extra_seat", quantity: 5, itemId: "si_a", unitAmountCents: 4900, currency: "usd" }]);
  });
});

describe("STORY-076b audit · duplicatedAddonKinds", () => {
  it("names a kind held on two lines, in catalog order, and no other", () => {
    expect(duplicatedAddonKinds(sub(item("plan"), item("extra_seat", { id: "si_a" }), item("extra_seat", { id: "si_b" }), item("extra_project")))).toEqual(["extra_seat"]);
    expect(duplicatedAddonKinds(sub(item("extra_seat", { id: "si_a" }), item("extra_seat", { id: "si_b" }), item("extra_project", { id: "p1" }), item("extra_project", { id: "p2" })))).toEqual(["extra_project", "extra_seat"]);
  });

  it("one line per kind, no lines, and malformed subscriptions are not duplicates", () => {
    expect(duplicatedAddonKinds(sub(item("plan"), item("extra_seat"), item("extra_project")))).toEqual([]);
    expect(duplicatedAddonKinds(sub())).toEqual([]);
    expect(duplicatedAddonKinds({})).toEqual([]);
    expect(duplicatedAddonKinds({ items: { data: [null, 3, {}] } })).toEqual([]);
  });

  it("a second line too malformed to mirror (quantity 0) still counts: it is still a line in Stripe", () => {
    expect(duplicatedAddonKinds(sub(item("extra_seat", { id: "si_a" }), item("extra_seat", { id: "si_b", quantity: 0 })))).toEqual(["extra_seat"]);
  });
});
