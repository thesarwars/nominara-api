import { z } from "zod";

// security-and-tenancy.md §5, verbatim claim shape. EdDSA (Ed25519),
// 15-minute TTL. `ws`/`role`/`scope`/`ent_v` are all nullable — a token
// minted before any workspace exists (STORY-014: right after passkey
// registration or assertion) carries them as `null`, which is a genuine
// final state, not a placeholder pending a later fill-in. `role` and `scope`
// stay permissive here: RBAC's real shape lands in STORY-018/019.
export const accessTokenClaimsSchema = z
  .object({
    sub: z.uuid(),
    sid: z.uuid(),
    ws: z.uuid().nullable(),
    role: z.string().nullable(),
    scope: z.array(z.string()).nullable(),
    ent_v: z.number().int().nonnegative().nullable(),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.uuid(),
  })
  .strict();

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
