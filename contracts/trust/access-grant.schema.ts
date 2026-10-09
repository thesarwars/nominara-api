import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";

// NEW-D-1 — `GET /v1/trust/access-grants` (workspace:read): the live
// support-grant transparency panel (security-and-tenancy.md §11). Staff
// identities (`requested_by`, `approved_by`) are deliberately not published.
// Only grants in force are listed — unrevoked and unexpired — so an empty
// list means no support access, which is the claim the panel exists to make.
export const SUPPORT_GRANT_SCOPES = ["metadata", "findings", "full"] as const;

export const accessGrantSchema = z
  .object({
    id: z.uuid(),
    scope: z.enum(SUPPORT_GRANT_SCOPES),
    allow_write: z.boolean(),
    ticket_ref: z.string(),
    justification: z.string(),
    expires_at: z.iso.datetime(),
    created_at: z.iso.datetime(),
  })
  .strict();

export const accessGrantListQuerySchema = paginationRequestSchema;

export type AccessGrant = z.infer<typeof accessGrantSchema>;

/** `GET /v1/trust/access-grants` — the page's items; the cursor lives in the envelope's `pagination`. */
export const accessGrantListResponseSchema = z.array(accessGrantSchema);
export type AccessGrantListResponse = z.infer<typeof accessGrantListResponseSchema>;
export type AccessGrantListQuery = z.infer<typeof accessGrantListQuerySchema>;

// NEW-D-5 — security-and-tenancy.md §11: TTL <= 4 h. This is the input of the
// OPS CLI (`pnpm support:grant`), never of an HTTP route: no request schema
// anywhere accepts it, and that absence is the control. Staff are identified
// by user id; `approved_by <> requested_by` is re-checked by the CLI before
// the database's ck_support_dual_control is reached.
export const SUPPORT_GRANT_MAX_TTL_MINUTES = 240;

export const supportGrantCreateInputSchema = z
  .object({
    workspace_id: z.uuid(),
    requested_by: z.uuid(),
    approved_by: z.uuid(),
    scope: z.enum(SUPPORT_GRANT_SCOPES),
    allow_write: z.boolean().default(false),
    justification: z.string().trim().min(1).max(2000),
    ticket_ref: z.string().trim().min(1).max(200),
    ttl_minutes: z.number().int().min(1).max(SUPPORT_GRANT_MAX_TTL_MINUTES),
    /** Who ran the CLI; lands on the audit row. */
    operator: z.string().trim().min(1).max(200),
  })
  .strict();

export type SupportGrantCreateInput = z.infer<typeof supportGrantCreateInputSchema>;
