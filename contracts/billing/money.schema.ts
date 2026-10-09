import { z } from "zod";

// NEW-D-1 — money on the wire. The columns are `numeric(12,2)` and
// conventions.md bans a float for money, so a JSON number (a float in every
// consumer) is not offered: an amount travels as a decimal STRING with exactly
// two fractional digits, "15.00", and `currency` travels beside it as ISO 4217.
// Never summed or compared by a client as a number.
export const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/u;

export const moneySchema = z.string().regex(MONEY_PATTERN, "expected a decimal with two fraction digits");

export const currencySchema = z.string().length(3).regex(/^[A-Z]{3}$/u);

export type Money = z.infer<typeof moneySchema>;
