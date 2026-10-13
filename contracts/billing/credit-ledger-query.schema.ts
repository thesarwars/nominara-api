import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { LEDGER_ACTION_CODES, LEDGER_ENTRY_TYPES } from "./credit-ledger-entry.schema.js";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-073 AC12's filters — "by action, project, actor, and date".
//
// ⚠ `.strict()`, SO AN UNKNOWN FILTER IS A 400 RATHER THAN A WIDER RESULT.
// A typo'd `?actor=` silently returning every row is the failure mode that
// matters here: a person auditing who spent what would read an unfiltered
// ledger and conclude the filter found nothing to narrow.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD")
  .describe("UTC calendar date");

export const creditLedgerQuerySchema = paginationRequestSchema
  .extend({
    /** The action a debit paid for. Matches `credit_ledger.action_code`. */
    action: z.enum(LEDGER_ACTION_CODES).optional(),
    /** Narrow to entries about one project. Entries with no project never match. */
    project_id: lowercaseUuidSchema.optional(),
    /**
     * One person's spend.
     *
     * ⚠ THIS CANNOT FIND AN API KEY'S ENTRIES, because they carry no actor
     * id — see `credit-ledger-entry.schema.ts`. `entry_type` and the
     * reference are how those are traced, and saying so here is better than a
     * filter that quietly returns nothing.
     */
    actor_id: lowercaseUuidSchema.optional(),
    entry_type: z.enum(LEDGER_ENTRY_TYPES).optional(),
    /** Inclusive, UTC. A day is a calendar day, not a rolling 24 hours. */
    from: isoDate.optional(),
    /** Inclusive, UTC — the whole of this day is in range. */
    to: isoDate.optional(),
  })
  .strict();

export type CreditLedgerQuery = z.infer<typeof creditLedgerQuerySchema>;
