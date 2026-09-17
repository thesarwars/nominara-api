import { z } from "zod";
import { oauthProviderSchema } from "./oauth-provider.schema.js";

// STORY-096 slice C — `GET /me/oauth`, the providers this caller has linked.
//
// ⚠ WHY THIS ROUTE EXISTS. `POST /auth/oauth/{provider}/link/start` and
// `DELETE /me/oauth/{provider}` both shipped with STORY-015 and nothing could
// read the state BETWEEN them, so a security screen could offer "Connect" and
// "Disconnect" and know which of the two was the truthful control for any
// given provider. `unlink` answers `403 forbidden` ("not the caller's
// credential") for a provider that is not linked, so a blind Disconnect is a
// button whose only outcome is an error — the same shape as the wallet
// balance before STORY-096 slice A added a route to read it.
//
// ⚠ EXHAUSTIVE BY CONSTRUCTION (`.strict()`), and the omissions are the
// point. `user_credentials` also holds `provider_subject` — the provider's
// own account identifier — and `public_key`. Neither is here and neither may
// be added: this answers "which providers can sign me in", not "who am I at
// Google", and the identifier is a cross-service correlator this product has
// no reason to publish back to a browser. Same rule
// `passkey-list-response.schema.ts` states for `credential_id`.
// ⚠ NO IDENTIFIER, AND THAT IS A LIMITATION RATHER THAN A DECISION.
// `DELETE /me/oauth/{provider}` is keyed on the PROVIDER, so publishing a row
// id here would hand a caller something they cannot act on. The consequence is
// that two accounts on one provider are visible but not individually
// addressable: `unlink` revokes the OLDEST (ordered explicitly in
// `oauth.service.ts` so it is at least a rule rather than whichever row the
// planner returned first), and the screen states which one it will take.
// Making a specific link addressable needs an id-keyed route — a change to a
// shipped contract, filed rather than folded into this one.
export const oauthLinkItemSchema = z
  .object({
    provider: oauthProviderSchema,
    last_used_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
  })
  .strict();

export const oauthLinkResponseSchema = z.array(oauthLinkItemSchema);

export type OauthLinkItem = z.infer<typeof oauthLinkItemSchema>;
export type OauthLinkResponse = z.infer<typeof oauthLinkResponseSchema>;
