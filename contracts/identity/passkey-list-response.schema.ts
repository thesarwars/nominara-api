import { z } from "zod";

// GET /me/passkeys. Exhaustive by construction (`.strict()`) — `public_key`,
// `credential_id`, and `sign_count` are deliberately absent and must never be
// added to this schema (STORY-014 acceptance criteria, test scenario 8).
export const passkeyListItemSchema = z
  .object({
    id: z.uuid(),
    device_label: z.string().nullable(),
    authenticator_attachment: z.enum(["platform", "cross-platform"]).nullable(),
    transports: z.array(z.string()).nullable(),
    last_used_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
  })
  .strict();

export const passkeyListResponseSchema = z.array(passkeyListItemSchema);

export type PasskeyListItem = z.infer<typeof passkeyListItemSchema>;
export type PasskeyListResponse = z.infer<typeof passkeyListResponseSchema>;
