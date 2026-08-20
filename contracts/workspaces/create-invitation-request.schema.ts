import { z } from "zod";

// POST /workspaces/{id}/invitations. `role` EXCLUDES `owner` — ownership is
// never granted through an invitation, only through the (out-of-scope,
// unowned) transfer flow, so there is no refusal shape to design here the
// way update-member-role-request.schema.ts needs one.
export const createInvitationRequestSchema = z
  .object({
    email: z.email(),
    role: z.enum(["admin", "manager", "analyst", "viewer"]),
    project_scope: z.array(z.uuid()).nullable().optional(),
  })
  .strict();

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;
