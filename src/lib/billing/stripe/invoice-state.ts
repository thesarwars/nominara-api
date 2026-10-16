import { INVOICE_STATUSES } from "../../../../contracts/billing/invoice.schema.js";

// STORY-075b / STORY-075 AC9 — the pure half of invoice recording. A FRESHLY
// FETCHED Stripe invoice goes in; the whole read-model row, or a refusal to
// write one, comes out.
//
// ⚠ NOTHING IN THIS FILE DOES MONEY ARITHMETIC. `subtotal` and `total` are
// Stripe's `subtotal` and `total`, in integer cents, rendered as the two-digit
// text the money contract carries by moving the decimal point in the STRING.
// They are never derived from the lines, the tax, the discount, `amount_due` or
// each other: a second opinion on a total is only ever a second chance to
// disagree with what the customer was actually charged.

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface DesiredInvoice {
  readonly stripeInvoiceId: string;
  readonly number: string | null;
  readonly status: InvoiceStatus;
  /** `numeric(12,2)` text, e.g. "116.10". */
  readonly subtotal: string;
  readonly total: string;
  /** Sum of the invoice's own add-on line amounts (Stripe's cents, as text). "0.00" is a measured zero. */
  readonly addonAmount: string;
  /** Sum of the invoice's own credit-pack line amounts. */
  readonly creditPackAmount: string;
  /** ISO 4217, upper case (the column is `char(3)` and the contract is `^[A-Z]{3}$`). */
  readonly currency: string;
  /** The SERVICE period the invoice pays for (see `servicePeriod`), not Stripe's invoice-level one. */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** When the invoice fell due: Stripe's `due_date`, else the invoice-level `period_end` (roughly when it was issued). */
  readonly dueAt: Date;
  readonly hostedInvoiceUrl: string | null;
  readonly pdfUrl: string | null;
  readonly paidAt: Date | null;
}

export type DesiredInvoiceResult = { readonly kind: "write"; readonly invoice: DesiredInvoice } | { readonly kind: "ignore"; readonly reason: string };

/**
 * How far along an invoice is. A write whose status ranks BELOW the recorded one
 * is stale (an older fetch committing late) and is skipped. `void` is level with
 * `paid`: both are terminal, and neither is ever reached from the other.
 */
export const INVOICE_STATUS_RANK: Readonly<Record<InvoiceStatus, number>> = {
  draft: 0,
  open: 1,
  uncollectible: 2,
  paid: 3,
  void: 3,
};

/**
 * `numeric(12,2)` holds ten integer digits. Currencies whose minor unit is not a
 * hundredth (zero- and three-decimal ones) would render a wrong amount through
 * a cents-to-decimal move, so they are refused rather than mis-stated.
 */
const MAX_CENTS = 10 ** 12 - 1;
const NOT_TWO_DECIMAL: ReadonlySet<string> = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
  "bhd", "iqd", "jod", "kwd", "lyd", "omr", "tnd",
]);

/** Integer cents to "d.dd" by moving the point in the text. Throws for anything that is not a non-negative safe integer inside the column's range. */
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CENTS) throw new Error(`not a representable amount in cents: ${String(cents)}`);
  const digits = String(cents).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function seconds(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A link a client will put in an href: http(s) or nothing. Never an arbitrary scheme. */
function link(value: unknown): string | null {
  const candidate = text(value);
  if (candidate === null || !URL.canParse(candidate)) return null;
  const protocol = new URL(candidate).protocol;
  return protocol === "https:" || protocol === "http:" ? candidate : null;
}

const ADDON_KIND_VALUES: ReadonlySet<string> = new Set(["extra_project", "extra_seat"]);
const ADDON_PRODUCT_PREFIX = "nominara_addon_";

/** The line's product: an expanded object (`pricing.price_details.product` or legacy `price.product`) or a bare id. */
function lineProduct(line: Record<string, unknown>): unknown {
  const pricing = isRecord(line.pricing) ? line.pricing : undefined;
  const details = pricing !== undefined && isRecord(pricing.price_details) ? pricing.price_details : undefined;
  if (details !== undefined && details.product !== undefined) return details.product;
  return isRecord(line.price) ? line.price.product : undefined;
}

function lineCategory(line: Record<string, unknown>): "addon" | "credit_pack" | null {
  const product = lineProduct(line);
  if (typeof product === "string") {
    // Add-on products are created by our gateway under this fixed id.
    return product.startsWith(ADDON_PRODUCT_PREFIX) && ADDON_KIND_VALUES.has(product.slice(ADDON_PRODUCT_PREFIX.length)) ? "addon" : null;
  }
  if (!isRecord(product)) return null;
  const kind = isRecord(product.metadata) ? product.metadata.nominara_kind : undefined;
  if (kind === "credit_pack") return "credit_pack";
  if (typeof kind === "string" && ADDON_KIND_VALUES.has(kind)) return "addon";
  if (typeof product.id === "string") return lineCategory({ pricing: { price_details: { product: product.id } } });
  return null;
}

/**
 * Integer cents of the lines in each category, as the two text figures. Only
 * Stripe's own line `amount`s are added; a line without an integer amount is
 * not counted, and a category netting below zero (a proration credit) is
 * published as 0.00 because the money contract carries no negative amount.
 */
function categoryAmounts(lines: readonly unknown[]): { addon: string; creditPack: string } {
  let addon = 0;
  let creditPack = 0;
  for (const line of lines) {
    if (!isRecord(line) || typeof line.amount !== "number" || !Number.isSafeInteger(line.amount)) continue;
    const category = lineCategory(line);
    if (category === "addon") addon += line.amount;
    else if (category === "credit_pack") creditPack += line.amount;
  }
  return { addon: centsToDecimal(Math.max(0, addon)), creditPack: centsToDecimal(Math.max(0, creditPack)) };
}

function linePeriod(line: Record<string, unknown>): { start: Date; end: Date } | null {
  if (!isRecord(line.period)) return null;
  const start = seconds(line.period.start);
  const end = seconds(line.period.end);
  return start === null || end === null ? null : { start, end };
}

/** A recurring (subscription) line: the 2025+ `parent.subscription_item_details`, the older `type`, or a recurring price; never a proration. */
function isRecurringLine(line: Record<string, unknown>): boolean {
  const parent = isRecord(line.parent) ? line.parent : undefined;
  const details = parent !== undefined && isRecord(parent.subscription_item_details) ? parent.subscription_item_details : undefined;
  if (details?.proration === true || line.proration === true) return false;
  if (details !== undefined) return true;
  if (line.type === "subscription") return true;
  const price = isRecord(line.price) ? line.price : undefined;
  const pricing = isRecord(line.pricing) ? line.pricing : undefined;
  return (price !== undefined && isRecord(price.recurring)) || (pricing !== undefined && isRecord(pricing.price_details) && isRecord(pricing.price_details.recurring));
}

// ⚠ THE PERIOD THE CUSTOMER IS PAYING FOR IS THE PLAN LINE'S, NOT THE INVOICE'S. On a Stripe subscription invoice the
// invoice-level `period_start`/`period_end` bracket the usage billed in arrears; on a first invoice both are the creation
// instant ("Oct 15 - Oct 15"). The service period is the `period` of the recurring plan line: a line that is a subscription
// item and neither an add-on nor a credit pack (a credit pack is a one-off and an add-on may be prorated mid-cycle, so
// neither speaks for the plan). Failing that the first line with a period; failing that the caller uses the invoice's own.
function servicePeriod(lines: readonly unknown[]): { start: Date; end: Date } | null {
  const candidates = lines.filter(isRecord).filter((line) => linePeriod(line) !== null);
  const plan = candidates.find((line) => lineCategory(line) === null && isRecurringLine(line)) ?? candidates[0];
  return plan === undefined ? null : linePeriod(plan);
}

function isStatus(value: unknown): value is InvoiceStatus {
  return typeof value === "string" && (INVOICE_STATUSES as readonly string[]).includes(value);
}

export function desiredFromStripeInvoice(raw: Readonly<Record<string, unknown>>): DesiredInvoiceResult {
  const id = text(raw.id);
  if (id === null) return { kind: "ignore", reason: "invoice carries no id" };
  if (!isStatus(raw.status)) return { kind: "ignore", reason: "invoice has an unrecognised status" };

  const currency = text(raw.currency)?.toLowerCase();
  if (currency === undefined || !/^[a-z]{3}$/u.test(currency)) return { kind: "ignore", reason: "invoice carries no currency" };
  if (NOT_TWO_DECIMAL.has(currency)) return { kind: "ignore", reason: "invoice currency does not have a two-digit minor unit" };

  let subtotal: string;
  let total: string;
  try {
    subtotal = centsToDecimal(raw.subtotal as number);
    total = centsToDecimal(raw.total as number);
  } catch {
    return { kind: "ignore", reason: "invoice subtotal or total is not an amount in cents" };
  }

  const lines = isRecord(raw.lines) && Array.isArray(raw.lines.data) ? raw.lines.data : [];
  const service = servicePeriod(lines);
  const periodStart = service?.start ?? seconds(raw.period_start);
  const periodEnd = service?.end ?? seconds(raw.period_end);
  if (periodStart === null || periodEnd === null) return { kind: "ignore", reason: "invoice carries no billing period" };
  // Past-due semantics ride on this, not on the service period (which ends a month AFTER a first invoice is issued).
  const dueAt = seconds(raw.due_date) ?? seconds(raw.period_end) ?? periodEnd;

  let amounts: { addon: string; creditPack: string };
  try {
    amounts = categoryAmounts(lines);
  } catch {
    return { kind: "ignore", reason: "invoice line amounts are not representable" };
  }

  const transitions = isRecord(raw.status_transitions) ? raw.status_transitions : undefined;
  return {
    kind: "write",
    invoice: {
      stripeInvoiceId: id,
      number: text(raw.number),
      status: raw.status,
      subtotal,
      total,
      addonAmount: amounts.addon,
      creditPackAmount: amounts.creditPack,
      currency: currency.toUpperCase(),
      periodStart,
      periodEnd,
      dueAt,
      hostedInvoiceUrl: link(raw.hosted_invoice_url),
      pdfUrl: link(raw.invoice_pdf),
      paidAt: seconds(transitions?.paid_at),
    },
  };
}
