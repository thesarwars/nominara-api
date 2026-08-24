import { z } from "zod";

// STORY-016 D8 — /auth/otp/request's response body is a FIXED constant,
// identical whether or not the address has an account (the enumeration-
// resistance AC). Both fields are literals, not just typed as string/number
// — a response carrying a different value would itself be a schema
// violation, not merely an unusual one.
export const emailOtpRequestResponseSchema = z
  .object({
    status: z.literal("sent"),
    expires_in_seconds: z.literal(600),
  })
  .strict();

export type EmailOtpRequestResponse = z.infer<typeof emailOtpRequestResponseSchema>;
