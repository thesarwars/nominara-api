import { describe, expect, it } from "vitest";
import { centsToDecimal, desiredFromStripeInvoice, INVOICE_STATUS_RANK } from "./invoice-state.js";

// STORY-075b / STORY-075 AC9 — the pure half of invoice recording: a freshly
// fetched Stripe invoice in, the whole read-model row (or a refusal) out. Every
// money figure is Stripe's, copied; nothing here adds, multiplies or rounds.

const T0 = 1_760_000_000;
const invoice = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "in_1",
  number: "NOM-0001",
  status: "paid",
  subtotal: 12_900,
  total: 11_610,
  currency: "usd",
  period_start: T0,
  period_end: T0 + 30 * 86_400,
  hosted_invoice_url: "https://invoice.stripe.test/i/acct/in_1",
  invoice_pdf: "https://pay.stripe.test/invoice/in_1/pdf",
  status_transitions: { paid_at: T0 + 60 },
  ...over,
});

describe("STORY-075 AC9 · an invoice is copied as Stripe issued it", () => {
  it("copies number, status, subtotal, total, currency, period, both URLs and paid_at", () => {
    expect(desiredFromStripeInvoice(invoice())).toEqual({
      kind: "write",
      invoice: {
        stripeInvoiceId: "in_1",
        number: "NOM-0001",
        status: "paid",
        subtotal: "129.00",
        total: "116.10",
        addonAmount: "0.00",
        creditPackAmount: "0.00",
        currency: "USD",
        periodStart: new Date(T0 * 1000),
        periodEnd: new Date((T0 + 30 * 86_400) * 1000),
        hostedInvoiceUrl: "https://invoice.stripe.test/i/acct/in_1",
        pdfUrl: "https://pay.stripe.test/invoice/in_1/pdf",
        paidAt: new Date((T0 + 60) * 1000),
      },
    });
  });

  it("scenario 9 · the total is Stripe's total even when it is not the subtotal, the lines or anything else locally derivable", () => {
    // 100.00 of lines, a 10.00 discount and 7.25 of tax: Stripe says 97.25.
    const out = desiredFromStripeInvoice(
      invoice({
        subtotal: 10_000,
        total: 9_725,
        total_discount_amounts: [{ amount: 1_000 }],
        total_taxes: [{ amount: 725 }],
        lines: { data: [{ amount: 6_000 }, { amount: 4_000 }] },
      }),
    );
    expect(out.kind === "write" && out.invoice.total).toBe("97.25");
    expect(out.kind === "write" && out.invoice.subtotal).toBe("100.00");
  });

  it("scenario 9 · the total is taken from `total` and never from amount_due, amount_paid or the line sum", () => {
    const out = desiredFromStripeInvoice(invoice({ total: 5_000, amount_due: 1, amount_paid: 2, lines: { data: [{ amount: 9_999 }] } }));
    expect(out.kind === "write" && out.invoice.total).toBe("50.00");
  });

  it("a draft has no number, URLs or paid_at: null stays null, never an empty string or a zero date", () => {
    const out = desiredFromStripeInvoice(
      invoice({ status: "draft", number: null, hosted_invoice_url: null, invoice_pdf: null, status_transitions: { paid_at: null } }),
    );
    expect(out).toMatchObject({ kind: "write", invoice: { number: null, hostedInvoiceUrl: null, pdfUrl: null, paidAt: null, status: "draft" } });
  });

  it("a zero-total invoice is a real $0.00 invoice, not an absent one", () => {
    const out = desiredFromStripeInvoice(invoice({ subtotal: 0, total: 0 }));
    expect(out).toMatchObject({ kind: "write", invoice: { subtotal: "0.00", total: "0.00" } });
  });

  it.each(["draft", "open", "paid", "uncollectible", "void"])("status %s is recorded as issued", (status) => {
    expect(desiredFromStripeInvoice(invoice({ status }))).toMatchObject({ kind: "write", invoice: { status } });
  });

  it.each([
    ["an unrecognised status", { status: "refunded" }],
    ["a missing status", { status: undefined }],
    ["a non-integer total", { total: 10.5 }],
    ["a negative total", { total: -1 }],
    ["a missing total", { total: undefined }],
    ["a string total", { total: "100" }],
    ["a missing subtotal", { subtotal: undefined }],
    ["a missing currency", { currency: undefined }],
    ["a zero-decimal currency, whose minor unit is not a cent", { currency: "jpy" }],
    ["a missing id", { id: undefined }],
    ["no billing period at all", { period_start: undefined, period_end: undefined }],
  ])("refuses %s rather than guessing", (_name, over) => {
    expect(desiredFromStripeInvoice(invoice(over)).kind).toBe("ignore");
  });

  it("falls back to the first line's service period only when the invoice carries none", () => {
    const out = desiredFromStripeInvoice(invoice({ period_start: undefined, period_end: undefined, lines: { data: [{ period: { start: T0 + 5, end: T0 + 99 } }] } }));
    expect(out).toMatchObject({ kind: "write", invoice: { periodStart: new Date((T0 + 5) * 1000), periodEnd: new Date((T0 + 99) * 1000) } });
  });

  it("a URL that is not a URL is stored as null, not as text a client would put in an href", () => {
    const out = desiredFromStripeInvoice(invoice({ hosted_invoice_url: "javascript:alert(1)", invoice_pdf: "not a url" }));
    expect(out).toMatchObject({ kind: "write", invoice: { hostedInvoiceUrl: null, pdfUrl: null } });
  });
});

describe("centsToDecimal · integer cents to the two-digit text the money contract carries", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [9, "0.09"],
    [10, "0.10"],
    [100, "1.00"],
    [11_610, "116.10"],
    [999_999_999_999, "9999999999.99"],
  ])("%d -> %s", (cents, text) => {
    expect(centsToDecimal(cents)).toBe(text);
  });

  it.each([-1, 10 ** 12, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])("refuses %s", (cents) => {
    expect(() => centsToDecimal(cents)).toThrow();
  });
});

describe("INVOICE_STATUS_RANK · a late event can never walk an invoice backwards", () => {
  it("orders draft < open < uncollectible < paid, with void level with paid (both terminal)", () => {
    expect(INVOICE_STATUS_RANK.draft).toBeLessThan(INVOICE_STATUS_RANK.open);
    expect(INVOICE_STATUS_RANK.open).toBeLessThan(INVOICE_STATUS_RANK.uncollectible);
    expect(INVOICE_STATUS_RANK.uncollectible).toBeLessThan(INVOICE_STATUS_RANK.paid);
    expect(INVOICE_STATUS_RANK.void).toBe(INVOICE_STATUS_RANK.paid);
  });
});

// STORY-075b audit finding 1 — `addon_amount` and `credit_pack_amount` are
// published money figures; they are the sum of the invoice's OWN line amounts
// (Stripe's integer cents) for lines whose product is an add-on / a credit pack.
describe("STORY-075b audit · addon_amount and credit_pack_amount come from the invoice lines", () => {
  const T = { subtotal: 20_400, total: 20_400 };
  const planLine = { amount: 15_500, pricing: { price_details: { product: "prod_plan" } } };
  const addonLine = { amount: 4_900, pricing: { price_details: { product: { id: "nominara_addon_extra_project", metadata: { nominara_kind: "extra_project" } } } } };
  const seatLine = { amount: 1_500, pricing: { price_details: { product: { id: "x", metadata: { nominara_kind: "extra_seat" } } } } };
  const packLine = { amount: 1_500, pricing: { price_details: { product: { id: "p", metadata: { nominara_kind: "credit_pack" } } } } };
  const write = (lines: unknown[], over: Record<string, unknown> = {}) => {
    const out = desiredFromStripeInvoice(invoice({ ...T, lines: { data: lines }, ...over }));
    if (out.kind !== "write") throw new Error("expected a write");
    return out.invoice;
  };

  it("an invoice with a $49 extra_project line publishes addon_amount 49.00 and credit_pack_amount 0.00", () => {
    const inv = write([planLine, addonLine]);
    expect(inv.addonAmount).toBe("49.00");
    expect(inv.creditPackAmount).toBe("0.00");
  });

  it("two add-on kinds sum; a credit-pack line goes to credit_pack_amount only", () => {
    const inv = write([planLine, addonLine, seatLine, packLine]);
    expect(inv.addonAmount).toBe("64.00");
    expect(inv.creditPackAmount).toBe("15.00");
  });

  it("an add-on line whose product is only an id is recognised by the fixed add-on product id", () => {
    const inv = write([{ amount: 4_900, pricing: { price_details: { product: "nominara_addon_extra_project" } } }]);
    expect(inv.addonAmount).toBe("49.00");
  });

  it("the legacy line shape (price.product) is read too", () => {
    const inv = write([{ amount: 1_500, price: { product: { metadata: { nominara_kind: "extra_seat" } } } }]);
    expect(inv.addonAmount).toBe("15.00");
  });

  it("an invoice with no lines, or only unmarked lines, has 0.00 for both (a measured zero)", () => {
    expect(write([])).toMatchObject({ addonAmount: "0.00", creditPackAmount: "0.00" });
    expect(write([planLine, { amount: 100 }])).toMatchObject({ addonAmount: "0.00", creditPackAmount: "0.00" });
  });

  it("a proration credit that nets an add-on below zero publishes 0.00, not a negative money string", () => {
    const credit = { ...addonLine, amount: -2_000 };
    expect(write([credit]).addonAmount).toBe("0.00");
  });

  it("a line with a non-integer amount is not counted (fail closed on the figure, not on the invoice)", () => {
    expect(write([{ ...addonLine, amount: 49.5 }]).addonAmount).toBe("0.00");
  });

  it("the totals are still Stripe's, untouched by the line classification", () => {
    const inv = write([addonLine], { subtotal: 1, total: 2 });
    expect(inv).toMatchObject({ subtotal: "0.01", total: "0.02", addonAmount: "49.00" });
  });
});
