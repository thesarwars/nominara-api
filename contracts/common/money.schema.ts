import { z } from "zod";

// STORY-024 T7 — `NFR-API-05`: "all money is `{amount_usd: string,
// currency: "USD"}`". A decimal STRING, never a float: every money column in
// schemas/billing-and-credits.md is `numeric(12,2)` (`price_usd:189`,
// `amount_usd:208`, `unit_price_usd:237`), and IEEE-754 cannot hold those
// values exactly — a JSON number here would make "15.00" arrive as
// 15.000000000000002 for some arithmetic path and turn a billing total into a
// rounding argument.
//
// `numeric(12,2)` is where both bounds come from: 12 significant digits with
// 2 after the point, so at most 10 before it, and Postgres always renders the
// scale it stores — "15.00", never "15". The pattern pins that exact shape so
// a hand-built "15" or a float-stringified "15.000000001" is a schema
// violation at the boundary rather than a surprise in a spreadsheet.
// Negatives are admitted because a ledger entry can be a debit.
export const MONEY_AMOUNT_USD_PATTERN = /^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;

export const moneySchema = z
  .object({
    amount_usd: z.string().regex(MONEY_AMOUNT_USD_PATTERN),
    currency: z.literal("USD"),
  })
  .strict();

export type Money = z.infer<typeof moneySchema>;
