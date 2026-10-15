import { ValidationFailedError } from "../../api/errors/domain-errors.js";

// api-specification.md section 1, `X-Nominara-Confirmed-Credits`: "Echoes the exact figure shown to the operator. A
// mismatch is `409 price_changed`."
//
// ONE PARSER for both ways a route can be priced: `CreditGuard` (a flat price, quoted before the handler) and the
// inline debit (prompt activation, whose price is known only inside the handler, under the project lock). Two parsers
// would be two answers to "what is a well-formed header".

/** Lower-cased because that is how Fastify presents it. */
export const CONFIRMED_CREDITS_HEADER = "x-nominara-confirmed-credits";

/**
 * The echoed figure, or `null` when the header is absent or blank.
 *
 * `null`, never 0: treating an absent header as "confirmed 0" would let any caller execute a priced action by omitting
 * a header. Anything present that is not exactly a whole number of credits was not echoed from a quote and is refused.
 */
export function parseConfirmedCredits(raw: string | readonly string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  if (value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  // Digits only: `Number()` would read "1e3" and "0x10" as figures, and "200abc" must not read as 200.
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationFailedError({
      message: `${CONFIRMED_CREDITS_HEADER} must be a non-negative integer`,
      details: { issues: [{ path: [CONFIRMED_CREDITS_HEADER], message: "must be a non-negative integer" }] },
    });
  }
  return parsed;
}

/** The figure, or a 400 naming the header: used where the price is above 0, so a figure is required. */
export function requireConfirmedCredits(confirmed: number | null): number {
  if (confirmed === null) {
    throw new ValidationFailedError({
      message: `this action is priced in credits and requires the ${CONFIRMED_CREDITS_HEADER} header`,
      details: { issues: [{ path: [CONFIRMED_CREDITS_HEADER], message: "required on a credit-priced route" }] },
    });
  }
  return confirmed;
}
