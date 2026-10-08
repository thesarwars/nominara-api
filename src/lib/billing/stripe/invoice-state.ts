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
  /** ISO 4217, upper case (the column is `char(3)` and the contract is `^[A-Z]{3}$`). */
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
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

  // The invoice's own period; failing that, the service period of its first line.
  const firstLine = isRecord(raw.lines) && Array.isArray(raw.lines.data) ? raw.lines.data.find(isRecord) : undefined;
  const linePeriod = firstLine !== undefined && isRecord(firstLine.period) ? firstLine.period : undefined;
  const periodStart = seconds(raw.period_start) ?? seconds(linePeriod?.start);
  const periodEnd = seconds(raw.period_end) ?? seconds(linePeriod?.end);
  if (periodStart === null || periodEnd === null) return { kind: "ignore", reason: "invoice carries no billing period" };

  const transitions = isRecord(raw.status_transitions) ? raw.status_transitions : undefined;
  return {
    kind: "write",
    invoice: {
      stripeInvoiceId: id,
      number: text(raw.number),
      status: raw.status,
      subtotal,
      total,
      currency: currency.toUpperCase(),
      periodStart,
      periodEnd,
      hostedInvoiceUrl: link(raw.hosted_invoice_url),
      pdfUrl: link(raw.invoice_pdf),
      paidAt: seconds(transitions?.paid_at),
    },
  };
}
