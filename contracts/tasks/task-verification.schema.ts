import { z } from "zod";

// STORY-067 - the verification scheduler and the measured impact. Internal contracts: nothing here is a request body; the
// public surface is `completeTaskVerificationSchema` ({ at_48h, at_14d }) and the milestone's `measured_impact`.
//
// THE TWO HORIZONS. product-spec FR-AP-05 / schemas/tasks-and-goals.md: re-measurement at +48 h and +14 d after the completion.
// Both are configurable (TASK_VERIFICATION_SHORT_HOURS / TASK_VERIFICATION_LONG_DAYS) and DEFAULT to those documented values.
export const DEFAULT_VERIFICATION_SHORT_HOURS = 48;
export const DEFAULT_VERIFICATION_LONG_DAYS = 14;

/** `short` = the +48 h re-measurement; `long` = the +14 d one, the horizon at which the impact is computed. */
export const taskVerificationHorizonSchema = z.enum(["short", "long"]);

/**
 * pending   - scheduled, not yet due.
 * running   - due: its cluster-scoped capture run was planned (or, with nothing capturable, none was needed) and it awaits settling.
 * done      - settled; `outcome` says how.
 * canceled - never ran; `cancel_reason` says why. A canceled row is kept (the schedule is an audit trail), never deleted.
 */
export const taskVerificationStatusSchema = z.enum(["pending", "running", "done", "canceled"]);

/**
 * How a settled verification ended.
 *   captured / no_capture  - the short horizon: its run finished / there was nothing to capture (no cluster, or no capture-ready engine).
 *   measured               - the long horizon: both windows had enough data, so a delta was written onto the milestone.
 *   insufficient_sample    - the long horizon: a window was under the sample floor, so NO delta was written (never a wide interval).
 */
export const taskVerificationOutcomeSchema = z.enum(["captured", "no_capture", "measured", "insufficient_sample"]);

export const taskVerificationCancelReasonSchema = z.enum(["task_reopened", "task_deleted", "project_paused", "project_deleted"]);

export type TaskVerificationHorizon = z.infer<typeof taskVerificationHorizonSchema>;
export type TaskVerificationStatus = z.infer<typeof taskVerificationStatusSchema>;
export type TaskVerificationOutcome = z.infer<typeof taskVerificationOutcomeSchema>;
export type TaskVerificationCancelReason = z.infer<typeof taskVerificationCancelReasonSchema>;

/** `scoring-models.md` section 13, "Impact attribution" - the one sentence every rendered impact figure carries. */
export const MEASURED_IMPACT_CAVEAT = "Observational; concurrent changes are not controlled for.";

/**
 * `milestones.measured_impact` as the verification scheduler writes it (schemas/sources-and-rollups.md). It is only ever written when
 * a delta EXISTS: an insufficient sample writes nothing, so a reader never meets a delta-less impact.
 *
 *   visibility_before / visibility_after_14d  mean Visibility Score over the aligned windows either side of the completion day
 *   delta                                     after minus before
 *   window_days                               the length of EACH window (they are equal: aligned)
 *   confidence                                high | medium | low - accounts for OTHER milestones nearby, whatever the delta looks like
 *   method                                    names how it was measured, so a later method is distinguishable
 *   scoring_version                           the scoring version of every day in both windows
 *   n_before / n_after                        measured cells behind each mean
 *   other_milestones_nearby                   how many other milestones fell inside the window (the reason for a lowered confidence)
 */
export const measuredImpactSchema = z
  .object({
    visibility_before: z.number(),
    visibility_after_14d: z.number(),
    delta: z.number(),
    window_days: z.number().int().positive(),
    confidence: z.enum(["low", "medium", "high"]),
    method: z.string().min(1),
    /** The scoring-model version BOTH windows were read at. Windows are never mixed across versions (a formula change is not an impact). */
    scoring_version: z.string().min(1),
    caveat: z.literal(MEASURED_IMPACT_CAVEAT),
    n_before: z.number().int().nonnegative(),
    n_after: z.number().int().nonnegative(),
    other_milestones_nearby: z.number().int().nonnegative(),
  })
  .strict();

export type MeasuredImpact = z.infer<typeof measuredImpactSchema>;
