import { z } from "zod";

// POST /workspaces/{id}/invitations/accept. The raw token (not the stored
// `token_hash`) is the only input — the invitee proves possession of the
// single-use secret shown once at creation time (STORY-021-E-6).
export const acceptInvitationRequestSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;
