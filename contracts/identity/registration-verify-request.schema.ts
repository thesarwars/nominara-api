import { z } from "zod";
import { webauthnCredentialJsonSchema } from "./webauthn-credential-json.schema.js";

// POST /auth/passkey/verify, registration path. `ceremony_id` is the opaque
// reference to the `webauthn_challenges` row `/auth/passkey/options` created —
// never the raw challenge bytes themselves.
export const registrationVerifyRequestSchema = z
  .object({
    ceremony_id: z.uuid(),
    response: webauthnCredentialJsonSchema,
  })
  .strict();

export type RegistrationVerifyRequest = z.infer<typeof registrationVerifyRequestSchema>;
