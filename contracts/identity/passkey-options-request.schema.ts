import { z } from "zod";
import { registrationOptionsRequestSchema } from "./registration-options-request.schema.js";
import { assertionOptionsRequestSchema } from "./assertion-options-request.schema.js";

// POST /auth/passkey/options — one endpoint, dispatched by `purpose`
// (api-specification.md §3, STORY-014 Technical Notes). The two branches
// are each already `.strict()`; this only composes them into the one wire
// contract the single endpoint actually accepts.
export const passkeyOptionsRequestSchema = z.discriminatedUnion("purpose", [
  registrationOptionsRequestSchema,
  assertionOptionsRequestSchema,
]);

export type PasskeyOptionsRequest = z.infer<typeof passkeyOptionsRequestSchema>;
