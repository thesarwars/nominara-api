import { z } from "zod";
import { autoTopupConfigSchema } from "./auto-topup.schema.js";
import { usageMeterSchema } from "./usage.schema.js";

// STORY-096 — `GET /v1/billing/wallet`. `FR-CRD-10`: "Wallet state —
// available, reserved, expiring-soon, per-project spend, and daily remaining
// where applicable — is visible in-product."
//
// ⚠ THE ESTIMATE ALREADY RETURNS A WALLET AND THIS IS NOT THAT ONE.
// `run-estimate-response.schema.ts` carries `available`/`after`/`shortfall`
// for ONE project's deep scan, at `tracking:trigger`. This is the workspace's
// standing position at `billing:read`, which is a different question asked by
// a different person: a manager can price a scan they are about to run; only
// an owner or admin sees the wallet as an account.
//
// The bucket breakdown lives HERE and deliberately not there — that was a
// second-engineer review finding on STORY-074, where the split had leaked
// onto the estimate at the lower permission.

export const expiringCreditsSchema = z
  .object({
    credits: z.number().int().positive(),
    /** `YYYY-MM-DD`, formatted by Postgres — never through a local `Date`. */
    expires_at: z.string(),
  })
  .strict();

export const walletResponseSchema = z
  .object({
    /** §5: included + purchased − reserved. What a new action can draw on. */
    available: z.number().int().nonnegative(),
    /**
     * The two balances, which are accounting rather than a customer concept
     * (`FR-CRD-18`) — but an owner reading a billing screen is doing
     * accounting, which is why they are here and not on the estimate.
     */
    included_balance: z.number().int().nonnegative(),
    purchased_balance: z.number().int().nonnegative(),
    /** Held by actions in flight. Subtracted from `available` already. */
    reserved: z.number().int().nonnegative(),

    /**
     * What lapses next, and when.
     *
     * ⚠ NULL WHEN NOTHING EXPIRES, WHICH IS NOT THE SAME AS ZERO. A workspace
     * whose included balance is spent has nothing to lose at cycle end, and
     * rendering "0 credits expiring on 2026-10-01" invites the reader to
     * wonder what they did wrong. Absence is the honest shape.
     *
     * Included credits only. §4: "At cycle_end, included_balance is RESET to
     * the plan grant, not added — unused included credits expire." Purchased
     * credits roll over twelve months FIFO by lot, and `credit_purchases` has
     * no rows until STORY-076 creates them, so reporting a purchased expiry
     * today would be reporting on an empty table.
     */
    expiring_soon: expiringCreditsSchema.nullable(),

    /** `YYYY-MM-DD`. The cycle this wallet is in. */
    cycle_end: z.string(),

    /** What has ever been granted, bought and spent. A statement, not a balance. */
    lifetime_granted: z.number().int().nonnegative(),
    lifetime_purchased: z.number().int().nonnegative(),
    lifetime_spent: z.number().int().nonnegative(),

    /**
     * The auto-top-up configuration (api-specification.md §3: the wallet
     * carries "auto-top-up config"). OFF by default; `used_this_cycle` is the
     * schema counter that only a cycle roll resets (NEW-D-6).
     * The counter resets when the BILLING cycle rolls (apply-plan.ts: a reconciled
     * period that starts later than the one on file), not when this config changes.
     */
    auto_topup: autoTopupConfigSchema,

    /**
     * STORY-095 AC12 - the SHARED daily lookup cap (every capture-backed tool draws on the one counter), beside the balance a tool surface
     * already reads, so "N of M today" renders as a limit of its own, apart from the credit balance. The same figures as
     * `GET /billing/usage`'s `daily_lookups` and `daily_resets_at`: `used` is today's UTC row of `credit_daily_counters` (0 with none, never
     * absent), `cap` the plan's CURRENT entitlement (`null` where the plan sets none, which is not 0). Buying credits does not lift it. OPTIONAL in the contract only because
     * contracts:diff classes a new required response field a MAJOR change (as on `usage.schema.ts`); the server always sends both.
     */
    daily_lookups: usageMeterSchema.optional(),
    /** The next UTC midnight, when the daily counter rolls over. */
    daily_resets_at: z.iso.datetime().optional(),
  })
  .strict();

export type ExpiringCredits = z.infer<typeof expiringCreditsSchema>;
export type WalletResponse = z.infer<typeof walletResponseSchema>;
