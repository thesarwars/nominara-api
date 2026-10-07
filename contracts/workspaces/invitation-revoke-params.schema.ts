import { z } from "zod";

// DELETE /workspaces/{id}/invitations/{invitationId} (NEW-A-12) — path
// contract. The response is empty (200, no body).
export const invitationRevokeParamsSchema = z
  .object({
    id: z.uuid(),
    invitationId: z.uuid(),
  })
  .strict();

export type InvitationRevokeParams = z.infer<typeof invitationRevokeParamsSchema>;
