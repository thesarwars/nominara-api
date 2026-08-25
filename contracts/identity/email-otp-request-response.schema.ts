import { z } from "zod";

// STORY-016 D8 — /auth/otp/request's response body is a FIXED constant,
// identical whether or not the address has an account (the enumeration-
// resistance AC). Both fields are literals, not just typed as string/number
// — a response carrying a different value would itself be a schema
// violation, not merely an unusual one.
export const emailOtpRequestResponseSchema = z
  .object({
    status: z.literal("sent"),
    // STORY-117 — was `expires_in_seconds: 600`, which `NFR-API-05` forbids:
    // "all durations are integer milliseconds with a `_ms` suffix". No
    // reference document ever asked for seconds; the field was invented in
    // code. The unit AND the name change together — a renamed unit keeping
    // the old name would be worse than either alone.
    expires_in_ms: z.literal(600_000),
  })
  .strict();

export type EmailOtpRequestResponse = z.infer<typeof emailOtpRequestResponseSchema>;
