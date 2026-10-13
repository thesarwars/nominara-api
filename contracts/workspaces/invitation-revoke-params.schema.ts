import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// DELETE /workspaces/{id}/invitations/{invitationId} (NEW-A-12) — path
// contract. The response is empty (200, no body).
export const invitationRevokeParamsSchema = z
  .object({
    id: lowercaseUuidSchema,
    invitationId: lowercaseUuidSchema,
  })
  .strict();

export type InvitationRevokeParams = z.infer<typeof invitationRevokeParamsSchema>;
