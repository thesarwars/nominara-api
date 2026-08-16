import { z } from "zod";

// STORY-013 (should-fix #9, code review) — validates purge_failures.detail
// (data-model.md §7 / this story's Technical Notes: "columns ... detail
// jsonb ..." — the reference names the column but not a shape). Free-form
// diagnostic context a purge-failure record MAY carry, attached by
// recordPurgeFailure (src/workers/rollup/retention.ts). Nullable — most
// failures record only `reason`, no structured detail. Optional
// errorName/errorMessage/stack triad matches what `(error as Error)`
// naturally produces, plus a passthrough so a future caller can attach
// anything else without a schema change.
export const purgeFailureDetailSchema = z
  .object({
    errorName: z.string().optional(),
    errorMessage: z.string().optional(),
    stack: z.string().optional(),
  })
  .passthrough()
  .nullable();

export type PurgeFailureDetail = z.infer<typeof purgeFailureDetailSchema>;
