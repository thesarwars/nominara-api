import { z } from "zod";

// GET /workspaces/{id}/members list item. Mirrors
// schemas/identity-and-tenancy.md's `workspace_members` DDL. `role` includes
// `owner` here (unlike the invitation schemas) because a real membership row
// can legitimately be the owner's own.
export const memberResponseSchema = z
  .object({
    id: z.uuid(),
    user_id: z.uuid(),
    // NEW-A-12 — the member's display name (users.full_name, null until they
    // set one) and address. Joined from `users`, which has no RLS, starting
    // from the RLS-scoped workspace_members row. OPTIONAL ON THE WIRE (the
    // server always sends them) so the addition is `patch` under
    // contracts:diff, not a major — the NEW-A-5 option-A rule.
    name: z.string().nullable().optional(),
    email: z.string().optional(),
    role: z.enum(["owner", "admin", "manager", "analyst", "viewer"]),
    project_scope: z.array(z.uuid()).nullable(),
    status: z.enum(["active", "suspended", "removed"]),
    joined_at: z.iso.datetime(),
    last_active_at: z.iso.datetime().nullable(),
  })
  .strict();

export type MemberResponse = z.infer<typeof memberResponseSchema>;
