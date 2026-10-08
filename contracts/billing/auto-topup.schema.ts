import { z } from "zod";

// NEW-D-1 — `PUT /v1/billing/wallet/auto-topup` (billing:write, Growth+).
// api-specification.md §3: `{enabled, pack_key, threshold, max_per_cycle}`;
// "the cap is enforced in the schema".
//
// THE CAP IS 1..20, from `ck_autotopup_bounded`, NOT the demo's 1..10. The
// database CHECK is the control; this bound only turns the same refusal into
// a 400 before it reaches the database.
export const AUTO_TOPUP_MAX_PER_CYCLE_MIN = 1;
export const AUTO_TOPUP_MAX_PER_CYCLE_MAX = 20;

/** Why auto-top-up was switched off by the system (never by the customer). */
export const AUTO_TOPUP_DISABLED_REASONS = ["payment_failed"] as const;

const maxPerCycle = z
  .number()
  .int()
  .min(AUTO_TOPUP_MAX_PER_CYCLE_MIN)
  .max(AUTO_TOPUP_MAX_PER_CYCLE_MAX);

export const autoTopupRequestSchema = z
  .object({
    enabled: z.boolean(),
    /** Required when `enabled` — mirrors the CHECK's `auto_topup_pack_key IS NOT NULL`. */
    pack_key: z.string().min(1).max(64).nullable(),
    /** Fires when `available` drops below this many credits. */
    threshold: z.number().int().positive().nullable(),
    max_per_cycle: maxPerCycle.nullable(),
  })
  .strict()
  .refine((v) => !v.enabled || (v.pack_key !== null && v.threshold !== null && v.max_per_cycle !== null), {
    message: "pack_key, threshold and max_per_cycle are required when enabled",
  });

// Read side. OWNER DECISION: the spec puts auto-top-up config on
// `GET /billing/wallet`, so it is read THERE, as this object under the
// wallet's `auto_topup` member (added to walletResponseSchema together with
// its handler in NEW-D-6; adding it here alone would break the live wallet
// handler's typing). There is no `GET /billing/wallet/auto-topup`.
// `PUT` returns this same object.
export const autoTopupConfigSchema = z
  .object({
    enabled: z.boolean(),
    pack_key: z.string().nullable(),
    threshold: z.number().int().positive().nullable(),
    max_per_cycle: maxPerCycle.nullable(),
    /** `auto_topup_count_cycle`: fires so far this cycle. Not reset by a config change. */
    used_this_cycle: z.number().int().nonnegative(),
    /** False in week 1: the configuration ships, the off-session trigger does not. */
    trigger_active: z.boolean(),
    /**
     * NEW-D-7 — present only while auto-top-up is OFF because a charge failed
     * (STORY-076 scenario 9). Absent otherwise: a workspace that simply never
     * enabled it, or has since re-enabled it, has no failure to explain.
     */
    disabled_reason: z.enum(AUTO_TOPUP_DISABLED_REASONS).optional(),
  })
  .strict();

/**
 * NEW-D-7 — the outcome of one trigger evaluation (`AutoTopupService.trigger`).
 * Internal: no route returns it. `charge_submitted` is the only outcome that
 * consumed a cap slot and reached the provider; credits still land only on the
 * webhook. `declined` and `email_failed` consumed a slot and charged nothing.
 * `not_in_plan`: the workspace was downgraded below Growth after enabling it.
 */
export const AUTO_TOPUP_TRIGGER_OUTCOMES = [
  "not_enabled",
  "not_in_plan",
  "above_threshold",
  "cap_reached",
  "in_flight",
  "pack_unavailable",
  "no_billing_contact",
  "no_payment_method",
  "email_failed",
  "declined",
  "upstream_error",
  "charge_submitted",
] as const;
export const autoTopupTriggerOutcomeSchema = z.enum(AUTO_TOPUP_TRIGGER_OUTCOMES);
export type AutoTopupTriggerOutcome = z.infer<typeof autoTopupTriggerOutcomeSchema>;

export type AutoTopupRequest = z.infer<typeof autoTopupRequestSchema>;
export type AutoTopupConfig = z.infer<typeof autoTopupConfigSchema>;
