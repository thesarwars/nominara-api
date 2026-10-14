import { z } from "zod";

// STORY-018 — POST /me/sessions/revoke-others. There is no request body: the
// account is the session's own and the session kept is the one asking, both read
// from the verified token, never from the request.
//
// `revoked_count` is the number of OTHER live sessions the call ended. 0 is a
// real answer (nothing else was signed in), not an absence: the call is
// idempotent and a repeat answers 0.
export const sessionsRevokeOthersResponseSchema = z
  .object({
    revoked_count: z.number().int().min(0),
  })
  .strict();

export type SessionsRevokeOthersResponse = z.infer<typeof sessionsRevokeOthersResponseSchema>;
