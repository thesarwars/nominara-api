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
