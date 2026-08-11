import { z } from "zod";

// Validates credit_ledger.unit_detail (schemas/billing-and-credits.md), which
// the reference documents only as a shape comment:
//   unit_detail jsonb, -- {prompts, engines, cells_charged, cells_cached}
// The column is nullable — not every ledger entry (e.g. a plan `grant`)
// carries unit-of-work detail, only debits that a run summary can render
// "as a statement of work done, never as billing arithmetic" (FR-CRD-03).
export const ledgerUnitDetailSchema = z
  .object({
    prompts: z.number().int().nonnegative().optional(),
    engines: z.array(z.string()).optional(),
    cellsCharged: z.number().int().nonnegative().optional(),
    cellsCached: z.number().int().nonnegative().optional(),
  })
  .nullable();

export type LedgerUnitDetail = z.infer<typeof ledgerUnitDetailSchema>;
