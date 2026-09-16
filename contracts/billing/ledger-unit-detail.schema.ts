import { z } from "zod";

// Validates credit_ledger.unit_detail (schemas/billing-and-credits.md), which
// the reference documents only as a shape comment:
//   unit_detail jsonb, -- {prompts, engines, cells_charged, cells_cached}
// The column is nullable — not every ledger entry (e.g. a plan `grant`)
// carries unit-of-work detail, only debits that a run summary can render
// "as a statement of work done, never as billing arithmetic" (FR-CRD-03).
//
// ⚠ SNAKE_CASE, AND IT USED TO BE camelCase. The first version of this file
// quoted the shape comment above and then declared `cellsCharged` /
// `cellsCached`, which agreed with neither the reference nor the rest of the
// wire format — every other response member in this API is snake_case
// (`root_domain`, `open_task_count`, `cursor_next`). It had no route and no
// writer, so nothing had ever surfaced the disagreement. STORY-073B is the
// first story to both write this column and return it over the wire, which
// makes this the cheapest moment the casing will ever be wrong.
//
// `engines` IS A COUNT, not the list of keys the first version declared. A
// ledger row is a financial record read months later, and an engine key is a
// vendor name that can be renamed, retired, or replaced — pinning a list of
// them into an immutable row makes the row stale rather than historic. The
// run it references still carries `engine_keys`, which is where "which
// engines" belongs.
export const ledgerUnitDetailSchema = z
  .object({
    prompts: z.number().int().nonnegative(),
    engines: z.number().int().nonnegative(),
    /** Cells an engine actually had to be asked for. */
    cells_charged: z.number().int().nonnegative(),
    /** Cells the cache already had. Neither number derives the price. */
    cells_cached: z.number().int().nonnegative(),
  })
  .strict()
  .nullable();

export type LedgerUnitDetail = z.infer<typeof ledgerUnitDetailSchema>;
