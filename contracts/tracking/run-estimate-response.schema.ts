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
     * A LITERAL ZERO. §3 marks this route free and carries neither `✚` nor
     * `¢`; typed as the literal so an edit that made the estimate billable
     * could not ship without changing this contract.
     */
    credits_charged: z.literal(0),
  })
  .strict();

export type CacheForecast = z.infer<typeof cacheForecastSchema>;
export type RunEstimateResponse = z.infer<typeof runEstimateResponseSchema>;
