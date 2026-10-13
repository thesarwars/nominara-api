import { z } from "zod";
import { webauthnCredentialJsonSchema } from "./webauthn-credential-json.schema.js";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// POST /auth/passkey/verify, assertion path. Same envelope as the
// registration-verify request; kept as its own named contract per purpose,
// per the two ceremonies never sharing a challenge row.
export const assertionVerifyRequestSchema = z
  .object({
    ceremony_id: lowercaseUuidSchema,
    response: webauthnCredentialJsonSchema,
  })
  .strict();

export type AssertionVerifyRequest = z.infer<typeof assertionVerifyRequestSchema>;
