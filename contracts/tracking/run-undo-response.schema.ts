import { z } from "zod";
import { runProgressResponseSchema } from "./run-progress-response.schema.js";

// STORY-074 AC8 — `POST /runs/{id}/undo`.
//
// ⚠ IT REFUNDS; IT DOES NOT RELEASE. §7 says the undo "releases the
// reservation if the job has not started", and by the time a customer can
// press it there is no reservation: `CreditInterceptor` commits the moment
// the handler returns, and the 202 arrives with cells already dispatched at
// interactive priority. The wording predates STORY-072's settlement design.
// Refunding delivers the same promise — a brief window to back out and not be
// charged — and leaves the ledger explaining the money in both directions.

export const undoRefusalSchema = z.enum([
  /** Cells have produced results. §7: "undo after job start is disabled with an explanation." */
  "work_started",
  /** The five seconds are up. */
  "window_closed",
]);

export const runUndoResponseSchema = z
  .object({
    run: runProgressResponseSchema,
    /**
     * What went back to the wallet. Zero with no refusal means the run was
     * never charged — a scheduled run is inside the subscription envelope,
     * which is not an error.
     */
    credits_refunded: z.number().int().nonnegative(),
    /** Null when the undo went through. */
    refusal: undoRefusalSchema.nullable(),
  })
  .strict();

export type UndoRefusalCode = z.infer<typeof undoRefusalSchema>;
export type RunUndoResponse = z.infer<typeof runUndoResponseSchema>;
