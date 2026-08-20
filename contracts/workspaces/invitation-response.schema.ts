import { z } from "zod";

// GET/POST /workspaces/{id}/invitations response body. `token` is present
// ONLY on the create response — the `api_keys` "shown once" precedent
// (STORY-021-E-6) — and absent when the same shape is used to list existing
// invitations, hence `.optional()` rather than a second schema.
export const invitationResponseSchema = z
  .object({
    id: z.uuid(),
    workspace_id: z.uuid(),
    email: z.email(),
    role: z.enum(["admin", "manager", "analyst", "viewer"]),
    project_scope: z.array(z.uuid()).nullable(),
    expires_at: z.iso.datetime(),
    created_at: z.iso.datetime(),
    token: z.string().optional(),
  })
  .strict();

export type InvitationResponse = z.infer<typeof invitationResponseSchema>;
