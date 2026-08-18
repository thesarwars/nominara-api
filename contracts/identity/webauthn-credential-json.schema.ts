import { z } from "zod";

// The raw JSON a WebAuthn authenticator/browser returns from
// `navigator.credentials.create()`/`.get()` (`@simplewebauthn/browser`'s
// `RegistrationResponseJSON`/`AuthenticationResponseJSON`). This is
// deliberately NOT `.strict()` and does not model `response`'s inner fields
// (`attestationObject`, `clientDataJSON`, `authenticatorData`, `signature`,
// `userHandle` — registration and assertion carry different subsets) —
// STORY-014's technical notes: ceremony validation, including client-data
// and attestation parsing, is delegated entirely to
// `@simplewebauthn/server`'s verify functions. This schema only proves the
// request body is *shaped like* a credential JSON before it reaches the
// library; the library owns everything about what's inside `response`.
export const webauthnCredentialJsonSchema = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal("public-key"),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  response: z.record(z.string(), z.unknown()),
});

export type WebauthnCredentialJson = z.infer<typeof webauthnCredentialJsonSchema>;
