import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { AUDIT_CATEGORIES, AUDIT_SEVERITIES } from "./audit-log-entry.schema.js";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD");

// api-specification.md §3: "cursor, filterable by action, actor, date", plus
// the owner-approved derived `category`. `.strict()` so a typo'd filter is a
// 400 and not an unfiltered log read as "nothing found".
export const auditLogQuerySchema = paginationRequestSchema
  .extend({
    /** Exact action name, e.g. `billing.addon.create`. */
    action: z.string().min(1).max(128).optional(),
    actor_id: lowercaseUuidSchema.optional(),
    category: z.enum(AUDIT_CATEGORIES).optional(),
    severity: z.enum(AUDIT_SEVERITIES).optional(),
    /** Inclusive, UTC. */
    from: isoDate.optional(),
    /** Inclusive, UTC — the whole of this day is in range. */
    to: isoDate.optional(),
  })
  .strict();

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
