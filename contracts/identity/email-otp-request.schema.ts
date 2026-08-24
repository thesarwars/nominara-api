import { z } from "zod";

// POST /auth/otp/request. Public route — deliberately accepts ANY email,
// known account or not (security-and-tenancy.md §5 "Enumeration": the
// response and its timing must be identical either way, D7/AC — see
// email-otp-request-response.schema.ts and the service's dummy-hash path).
export const emailOtpRequestSchema = z
  .object({
    // .trim() before .email(): OTP is the one flow where a client-side
    // whitespace slip shouldn't cost the ~10min wait for a fresh code.
    email: z.string().trim().email(),
  })
  .strict();

export type EmailOtpRequest = z.infer<typeof emailOtpRequestSchema>;
