import { z } from "zod";

// STORY-034 AC1 — `POST /projects/{id}/runs/estimate`, free.
//
// §3: "Returns the exact credit price and the cache forecast. This is what
// the confirmation modal renders."
//
// THE ESTIMATE BEING FREE AND SEPARATE IS WHAT MAKES THE TWO-STEP GUARD RAIL
// POSSIBLE — the story's own note. A client can always show cost before
// commitment because the price is available without committing to anything.

/**
 * What the run would do, cell by cell.
 *
 * `live` is what would reach an engine; `cached` is what the L1 and L2 layers
 * would answer without one. THE SPLIT IS WORK, NOT PRICE. `deep_scan.credits`
 * is flat and cache-independent — a run that is 90% cache-served costs the
 * same as one that is not — so these numbers set expectations about how long
 * the run takes and how fresh its answers are, and never multiply into the
 * figure above them. fair-use.ts states the reasoning at the charge hook.
 */
export const cacheForecastSchema = z
  .object({
    planned_cells: z.number().int().nonnegative(),
    live_cells: z.number().int().nonnegative(),
    cached_cells: z.number().int().nonnegative(),
    /**
     * Which layer would answer, because they are not the same claim.
     *
     * L1 is an exact-hash hit: the identical question, to the identical
     * engine, inside its TTL. L2 is semantic reuse: a DIFFERENT prompt whose
     * embedding is near enough to reuse the answer. A customer deciding
     * whether a run is worth triggering is entitled to know which of the two
     * their "cached" number is made of.
     */
    cached_by_layer: z
      .object({
        l1: z.number().int().nonnegative(),
        l2: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/**
 * STORY-074 AC2 — the wallet the modal renders, before and after.
 *
 * ⚠ `after` IS SERVER-COMPUTED, NOT `available - credits` IN THE COMPONENT.
 * The two are the same subtraction, and that is exactly why: a figure the
 * client derives is a figure the client can derive differently, and AC10's
 * "no hardcoded number in any component or modal" is only worth having if
 * the component is not doing the arithmetic either.
 *
 * ⚠ `available`, `after` AND `cycle_end` ONLY — the included/purchased/
 * reserved breakdown was here and has been removed. This route is
 * `tracking:trigger`, which a MANAGER holds; the breakdown is billing
 * information and `billing:read` is owner/admin only. There is no
 * `GET /billing/wallet` at all, so shipping it here would have made the
 * estimate the one success-path route in the product disclosing a wallet's
 * internals one permission rank below the one that gates them. §7's modal
 * renders `available` and `after`; it never renders the split.
 *
 * ⚠ AND `after` CAN BE NEGATIVE, which §5 calls unrepresentable FOR A
 * BALANCE. This is not a balance — it is "what you would be left with", and
 * for someone who cannot afford the action the honest answer is a negative
 * number the modal turns into a shortfall. `shortfall` beside it is that
 * figure made explicit, so no component has to derive it from a sign.
 */
export const estimateWalletSchema = z
  .object({
    available: z.number().int().nonnegative(),
    /** What `available` becomes if this action is confirmed. Negative when it cannot be afforded. */
    after: z.number().int(),
    /** How far short the wallet is, or null when it covers the action. AC9's purchase-in-place figure. */
    shortfall: z.number().int().positive().nullable(),
    /** `YYYY-MM-DD`, formatted by Postgres — never through a local `Date`. */
    cycle_end: z.string(),
  })
  .strict();

/** Why §7's cost modal is mandatory. Empty when it is not. */
export const escalationReasonSchema = z.enum([
  "zero_project_tier",
  "credits_above_threshold",
  "large_share_of_balance",
  "multiple_projects",
  "balance_after_below_floor",
  /** The plan's project cap could not be read. Confirm anyway — but say THAT, not that the tier has no projects. */
  "project_cap_unreadable",
]);

/**
 * STORY-074 AC7 — whether the two-step guard rail's modal is required, and
 * why.
 *
 * ⚠ DECIDED HERE AND NOT IN THE MODAL. The thresholds are comparisons
 * against the wallet, the price and the plan; a client evaluating them would
 * need its own copy of all three and its own copy of the numbers. Two
 * implementations of "is this big enough to need a click" drift, and the
 * drift is silent in the direction that matters — a stale client stops
 * confirming debits the product promised would always be confirmed.
 *
 * REASONS RATHER THAN A BARE BOOLEAN, because the modal has something to
 * say: "this would leave you under 50 credits" and "this is more than a
 * tenth of your balance" are different warnings, and a client given only
 * `true` has to invent copy for a condition it cannot see.
 */
export const confirmationSchema = z
  .object({
    required: z.boolean(),
    reasons: z.array(escalationReasonSchema),
  })
  .strict();

export const runEstimateResponseSchema = z
  .object({
    /**
     * The plan's flat deep-scan price — the exact figure the caller must echo
     * back in `X-Nominara-Confirmed-Credits`.
     */
    credits: z.number().int().nonnegative(),
    forecast: cacheForecastSchema,
    /** The full tracked set on every enabled engine — a manual scan takes no scope. */
    prompt_count: z.number().int().nonnegative(),
    engine_keys: z.array(z.string().min(1)),
    /**
     * Whether POST /projects/{id}/runs would accept this scan. `false` when
     * the scope plans no cells at all — no capture-ready engine this
     * project is entitled to, or no active prompts — in which case the
     * trigger refuses with 422 precondition_unmet and charges nothing.
     * The price, wallet and confirmation fields still describe what the
     * scan WOULD cost; this says it cannot run.
     */
    capturable: z.boolean(),
    /**
     * A LITERAL ZERO. §3 marks this route free and carries neither `✚` nor
     * `¢`; typed as the literal so an edit that made the estimate billable
     * could not ship without changing this contract.
     */
    credits_charged: z.literal(0),
    wallet: estimateWalletSchema,
    /**
     * How many more scans this balance affords at this price.
     *
     * ⚠ COMPUTED ON THE CURRENT BALANCE, NOT THE ONE AFTER. §7's wireframe
     * shows "2,400 available → 1,900 after · 4 more scans this cycle", and
     * 2400/500 is 4 while 1900/500 is 3 — so it is the former. The two differ
     * by one on every render and a customer counting scans would notice, so
     * the reading is recorded rather than silently chosen. There is no
     * per-cycle scan CAP to report: no entitlement limits deep scans by
     * count, only by what the wallet holds.
     */
    scans_affordable: z.number().int().nonnegative(),
    confirmation: confirmationSchema,
  })
  .strict();

export type CacheForecast = z.infer<typeof cacheForecastSchema>;
export type EstimateWallet = z.infer<typeof estimateWalletSchema>;
export type EscalationReasonCode = z.infer<typeof escalationReasonSchema>;
export type EstimateConfirmation = z.infer<typeof confirmationSchema>;
export type RunEstimateResponse = z.infer<typeof runEstimateResponseSchema>;
