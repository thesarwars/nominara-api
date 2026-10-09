import type { z } from "zod";
import { assertionOptionsRequestSchema } from "./assertion-options-request.schema.js";

// POST /auth/passkey/options — public, and (since STORY-173) SIGN-IN ONLY.
//
// This used to be a discriminated union of `assertion` and `registration`.
// The `registration` branch took an email and, with no session to identify the
// caller, found-or-created the account for that address and anchored the
// ceremony to it — so any anonymous caller could bind their own passkey to any
// existing account and receive a session for it (an account takeover), or plant
// a working credential on an address before its owner arrived. It is gone, not
// hardened: there is no anonymous way to name an account and attach a credential.
//
// A body with `purpose: "registration"` (or an `email`) is now a 400
// validation_failed for every address, existing or not, decided before any
// account lookup — which is what makes the refusal uniform. Passkeys are added
// at POST /me/passkeys/options (session, step-up): passkey-add-options-request.schema.ts.
export const passkeyOptionsRequestSchema = assertionOptionsRequestSchema;

export type PasskeyOptionsRequest = z.infer<typeof passkeyOptionsRequestSchema>;
