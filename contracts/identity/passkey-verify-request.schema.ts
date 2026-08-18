import { z } from "zod";
import { registrationVerifyRequestSchema } from "./registration-verify-request.schema.js";
import { assertionVerifyRequestSchema } from "./assertion-verify-request.schema.js";

// POST /auth/passkey/verify — one endpoint, dispatched by whichever
// ceremony purpose was stored against `ceremony_id` (STORY-014 Technical
// Notes). This is a z.union rather than a z.discriminatedUnion: the
// registration and assertion envelopes are intentionally byte-identical on
// the wire (no discriminant field), kept as two separately named contracts
// per ceremony purpose rather than one shared shape. A union of two
// identical schemas validates identically to either one alone; it exists
// so this endpoint's DTO is honestly typed as accepting both named
// contracts instead of always validating against the registration one.
export const passkeyVerifyRequestSchema = z.union([registrationVerifyRequestSchema, assertionVerifyRequestSchema]);

export type PasskeyVerifyRequest = z.infer<typeof passkeyVerifyRequestSchema>;
