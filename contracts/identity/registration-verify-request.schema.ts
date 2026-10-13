import { z } from "zod";
import { webauthnCredentialJsonSchema } from "./webauthn-credential-json.schema.js";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// POST /me/passkeys/verify (STORY-173: registration is session-authenticated;
// the public /auth/passkey/verify serves sign-in only). `ceremony_id` is the
// opaque reference to the `webauthn_challenges` row POST /me/passkeys/options
// created for THIS account — never the raw challenge bytes themselves.
export const registrationVerifyRequestSchema = z
  .object({
    ceremony_id: lowercaseUuidSchema,
    response: webauthnCredentialJsonSchema,
  })
  .strict();

export type RegistrationVerifyRequest = z.infer<typeof registrationVerifyRequestSchema>;
