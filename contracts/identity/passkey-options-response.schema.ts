import { z } from "zod";

// STORY-024 T12 — the response contract for `POST /auth/passkey/options`.
//
// It should have shipped with STORY-014. It did not, and because
// `responseSchema` is optional on `@ApiContract()`, nothing noticed: the
// route was decorated, so the coverage gate passed, and the generated
// document simply said "no response body". T11 then inferred `z.null()`
// from that absence and published `data: {"type":"null"}` for a route whose
// body carries the entire WebAuthn ceremony — which is why the generator no
// longer infers anything and this file exists.
//
// `options` is deliberately NOT modelled field by field, following exactly
// the precedent and reasoning of webauthn-credential-json.schema.ts: the
// object is `@simplewebauthn/server`'s
// `PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON`,
// defined by the W3C WebAuthn specification and produced wholesale by that
// library. Registration and assertion carry different subsets, and
// transcribing either into zod would make this repository the source of a
// contract it does not own — the same KAD-05 failure as describing a field
// twice, one copy of which then drifts. What IS ours is the envelope around
// it: the ceremony identifier the client must hand back to
// `POST /auth/passkey/verify`, whose `ceremony_id` is `z.uuid()` in both
// assertion-verify-request.schema.ts and registration-verify-request.schema.ts
// — the same validator, so the two halves of the ceremony cannot disagree.
export const passkeyOptionsResponseSchema = z
  .object({
    ceremony_id: z.uuid(),
    options: z.record(z.string(), z.unknown()),
  })
  .strict();

export type PasskeyOptionsResponse = z.infer<typeof passkeyOptionsResponseSchema>;
