import { z } from "zod";

// NEW-D-1 — `GET /v1/audit-log` item (audit_log:read).
//
// OWNER DECISION — `category`: DERIVED SERVER-SIDE FROM THE ACTION NAMESPACE
// (the segment before the first dot: `billing.*` -> billing, `auth.*`/`apikey.*`
// /`support.*` -> security, `workspace.*`/`member.*` -> workspace, everything
// else -> data). There is no `category` column and none is added; the mapping
// lives in the handler with a test that an unmapped namespace lands in `data`
// rather than being dropped.
export const AUDIT_CATEGORIES = ["security", "billing", "workspace", "data"] as const;
export const AUDIT_ACTOR_TYPES = ["user", "api_key", "system", "support"] as const;
export const AUDIT_SEVERITIES = ["info", "notice", "warning", "critical"] as const;

export const auditLogEntrySchema = z
  .object({
    /**
     * The row's `audit_log.seq`, as a decimal string. NEVER a hash: row N's
     * `prev_hash` is row N-1's `row_hash`, so exposing either leaks the chain
     * (checkpoint-4). It is the same value the opaque cursor is keyed on, and
     * it is stable. Trade-off, recorded: seq is a global sequence, so ids are
     * monotonic across workspaces; the ledger avoids that with a uuid, but
     * audit_log has no id column and a schema change is not part of NEW-D-3.
     */
    id: z.string().regex(/^[0-9]{1,18}$/u),
    occurred_at: z.iso.datetime(),
    actor_type: z.enum(AUDIT_ACTOR_TYPES),
    /** Null for `system`. No route returns member names, so a client shows type + id. */
    actor_id: z.uuid().nullable(),
    action: z.string(),
    category: z.enum(AUDIT_CATEGORIES),
    resource_type: z.string(),
    resource_id: z.uuid().nullable(),
    severity: z.enum(AUDIT_SEVERITIES),
    request_id: z.string(),
    /** Set when the action was taken under a support grant. */
    support_grant_id: z.uuid().nullable(),
  })
  .strict();

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/** `GET /v1/audit-log` — the page's items; the cursor lives in the envelope's `pagination`. */
export const auditLogListResponseSchema = z.array(auditLogEntrySchema);
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;
