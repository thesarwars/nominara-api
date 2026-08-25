import { z } from "zod";
import { creditPackSchema } from "../common/error-details.schema.js";

// STORY-026 T19 — api-specification.md §11's quota and credit events.
//
// `packs[]` reuses `creditPackSchema` from the error-details contract rather
// than restating it. A purchasable pack is one shape whether it arrives in a
// `402 insufficient_credits` body or in a `credits.depleted` event, and two
// definitions of it would drift the moment a pack gained a field.
//
// CREDITS ARE NOT MONEY. They are whole units and are typed as integers; only
// a pack's PRICE is money, and `creditPackSchema` already carries that in
// `NFR-API-05`'s `{amount_usd, currency}` shape. Typing a credit balance as
// money would put a decimal string on something that cannot have a fraction.

const uuid = z.uuid();

export const quotaThresholdEventSchema = z
  .object({
    metric: z.string().min(1),
    used: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    pct: z.number().min(0).max(100),
    resets_at: z.iso.datetime(),
  })
  .strict();

export const creditsDebitedEventSchema = z
  .object({
    action_code: z.string().min(1),
    credits: z.number().int().positive(),
    available_after: z.number().int().nonnegative(),
    reference_type: z.string().min(1),
    reference_id: z.string().min(1),
    // A debit that belongs to no project — an account-level action — carries
    // null rather than a placeholder id a client would try to navigate to.
    project_id: uuid.nullable(),
  })
  .strict();

export const creditsThresholdEventSchema = z
  .object({
    available: z.number().int().nonnegative(),
    included_balance: z.number().int().nonnegative(),
    purchased_balance: z.number().int().nonnegative(),
    pct_remaining: z.number().min(0).max(100),
    cycle_end: z.iso.datetime(),
    packs: z.array(creditPackSchema),
  })
  .strict();

export const creditsDepletedEventSchema = z
  .object({
    cycle_end: z.iso.datetime(),
    // §11 pins this as a literal `true`, and it is a PROMISE rather than a
    // field: scheduled scans keep running when the wallet empties. A boolean
    // that could be false would make the promise conditional, which is a
    // different product.
    scheduled_scans_unaffected: z.literal(true),
    packs: z.array(creditPackSchema),
  })
  .strict();

export const creditsToppedUpEventSchema = z
  .object({
    pack_key: z.string().min(1),
    credits: z.number().int().positive(),
    source: z.string().min(1),
    available_after: z.number().int().nonnegative(),
  })
  .strict();

export const reportReadyEventSchema = z
  .object({
    report_artifact_id: uuid,
    download_url_expires_at: z.iso.datetime(),
  })
  .strict();

export type QuotaThresholdEvent = z.infer<typeof quotaThresholdEventSchema>;
export type CreditsDebitedEvent = z.infer<typeof creditsDebitedEventSchema>;
export type CreditsThresholdEvent = z.infer<typeof creditsThresholdEventSchema>;
export type CreditsDepletedEvent = z.infer<typeof creditsDepletedEventSchema>;
export type CreditsToppedUpEvent = z.infer<typeof creditsToppedUpEventSchema>;
export type ReportReadyEvent = z.infer<typeof reportReadyEventSchema>;
