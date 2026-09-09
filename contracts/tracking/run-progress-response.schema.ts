import { z } from "zod";
import { cacheForecastSchema } from "./run-estimate-response.schema.js";

// STORY-034 AC3 and AC4 — `GET /runs/{id}`, and what `POST /projects/{id}/runs`
// returns the moment it accepts.
//
// §3: "progress projection and, on a manual run, the charge with the
// live/cached split."

export const runStatusSchema = z.enum(["queued", "running", "completed", "partial", "failed", "canceled"]);

/**
 * AC4 — the charge, stated as work done.
 *
 * "On a manual run the summary reports the flat charge alongside the live and
 * cached cell split, **as a statement of work done rather than billing
 * arithmetic**." The two live side by side and neither derives the other:
 * `credits` is the plan's flat price, and the split beside it says what the
 * run actually had to ask an engine for.
 *
 * `charged` IS FALSE TODAY, ON EVERY RUN, and the field exists to say so.
 * `commitDeepScanCharge` is a hook that records its own inaction — the credit
 * wallet is EPIC-10 — so `reason` carries why nothing moved rather than
 * leaving a caller to infer it from a zero. A scheduled run reports the same
 * shape with a different reason: it is inside the subscription envelope and
 * was never going to be charged.
 */
export const runChargeSchema = z
  .object({
    credits: z.number().int().nonnegative(),
    charged: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();

export const runProgressResponseSchema = z
  .object({
    run_id: z.string().uuid(),
    project_id: z.string().uuid(),
    trigger: z.enum(["scheduled", "manual", "verification", "drift_sample", "conversion_backfill"]),
    status: runStatusSchema,
    engine_keys: z.array(z.string().min(1)),
    planned: z.number().int().nonnegative(),
    captured: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** 0–100, integer. `planned = 0` reports 100 — a run with nothing to do is done. */
    pct: z.number().int().min(0).max(100),
    /**
     * `NFR-API-05` — integer milliseconds, `_ms` suffix, and NULLABLE.
     *
     * §11's own note: "an estimate is not always computable, and zero is a
     * real estimate rather than a missing one". Null before any cell has
     * finished, because the only honest basis for an estimate is the rate
     * cells have actually been completing at.
     */
    eta_ms: z.number().int().nonnegative().nullable(),
    started_at: z.string().datetime({ offset: true }).nullable(),
    finished_at: z.string().datetime({ offset: true }).nullable(),
    /** Present on a manual run — the only trigger §5's table prices. */
    charge: runChargeSchema.nullable(),
    /** What the run had to ask an engine for, against what a cache answered. */
    forecast: cacheForecastSchema,
  })
  .strict();

export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunCharge = z.infer<typeof runChargeSchema>;
export type RunProgressResponse = z.infer<typeof runProgressResponseSchema>;
