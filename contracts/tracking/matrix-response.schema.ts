import { z } from "zod";

// STORY-034 AC8 — `GET /projects/{id}/matrix`.
//
// §6's Prompt matrix: "returns one row per prompt with one cell per engine. A
// cell that could not be captured carries `result_id: null` with a `status`,
// an `error_code`, and `last_success_at` — NEVER AN EMPTY OBJECT, because 'we
// could not ask' and 'the engine did not mention you' are different facts."

/** `30d` and friends. §3's own query string writes `timeframe=30d`. */
export const matrixTimeframeSchema = z.enum(["7d", "30d", "90d"]).default("30d");

export const matrixQuerySchema = z
  .object({
    timeframe: matrixTimeframeSchema,
    /**
     * Comma-separated engine keys, as §3's query string writes them.
     *
     * A NARROWING, never a widening: an engine the project has not enabled
     * cannot be added by asking for it, because the row set is built from
     * `project_engines` and this filters it.
     */
    engines: z.string().min(1).optional(),
  })
  .strict();

/**
 * THREE ABSENCES, AND THEY ARE NOT THE SAME.
 *
 * `pending`   — planned, not yet attempted. No row exists for the cell.
 * `skipped`   — a cache layer answered it. There is a row and an answer.
 * `failed` / `blocked` — asked, and no answer came back. `error_code` says why.
 *
 * A grid that rendered all three as an empty cell would tell a customer "the
 * engine did not mention you" where the truth is "we never asked", which is
 * the exact confusion §6 forbids.
 */
export const matrixCellStatusSchema = z.enum(["pending", "captured", "parsed", "skipped", "failed", "blocked"]);

export const matrixCellSchema = z
  .object({
    engine_key: z.string().min(1),
    /** Null when nothing was captured — the cell still carries the rest. */
    result_id: z.string().uuid().nullable(),
    status: matrixCellStatusSchema,
    /** Populated on `failed` and `blocked`; null otherwise. */
    error_code: z.string().nullable(),
    captured_at: z.string().datetime({ offset: true }).nullable(),
    /**
     * The last time THIS prompt on THIS engine produced an answer, inside the
     * window or before it.
     *
     * §6 names it on the failure path specifically, and it is what turns "this
     * failed" into something actionable: a cell failing for the first time in
     * an hour reads very differently from one that has not answered since
     * March, and a grid without it cannot tell them apart.
     */
    last_success_at: z.string().datetime({ offset: true }).nullable(),
    /** `live`, `l1` or `l2` — null when nothing was captured. */
    cache_layer: z.enum(["live", "l1", "l2"]).nullable(),
  })
  .strict();

/**
 * NO SCORES IN THIS CONTRACT, AND THAT IS THE HONEST VERSION.
 *
 * §6's rendered matrix carries rank, share of voice and sentiment per cell.
 * Every one of those is produced by the parser and the scoring core —
 * EPIC-05, Slice 4 — and `answer_captures` carries their columns at
 * defaults: `brand_present false`, `sov null`, `citation_count 0`. Publishing
 * those defaults would put `brand_present: false` on the wire for a cell
 * nothing has ever parsed, which reads as "the engine did not mention you"
 * and is a measurement nobody made. They land in this schema with the parser
 * that fills them.
 */
export const matrixRowSchema = z
  .object({
    prompt_id: z.string().uuid(),
    text: z.string().min(1),
    intent_archetype: z.string().min(1),
    funnel_stage: z.string().min(1),
    is_priority: z.boolean(),
    cells: z.array(matrixCellSchema),
  })
  .strict();

export const matrixResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    timeframe: z.enum(["7d", "30d", "90d"]),
    /** The column order every row's `cells` follows, so a client need not sort. */
    engine_keys: z.array(z.string().min(1)),
    prompts: z.array(matrixRowSchema),
  })
  .strict();

export type MatrixQuery = z.infer<typeof matrixQuerySchema>;
export type MatrixCell = z.infer<typeof matrixCellSchema>;
export type MatrixRow = z.infer<typeof matrixRowSchema>;
export type MatrixResponse = z.infer<typeof matrixResponseSchema>;
