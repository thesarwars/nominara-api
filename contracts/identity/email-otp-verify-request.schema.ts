import { z } from "zod";

// POST /auth/otp/verify. security-and-tenancy.md §5 "Email OTP": an 8-digit
// code. The regex pins the shape exactly — a bare .length(8) would also pass
// 8 non-digit characters, which the parser (and the DB row it is checked
// against) never produces.
export const emailOtpVerifyRequestSchema = z
  .object({
    // .trim() before .email(): OTP is the one flow where a client-side
    // whitespace slip shouldn't cost the ~10min wait for a fresh code.
    email: z.string().trim().email(),
    code: z.string().regex(/^\d{8}$/, "must be exactly 8 digits"),
  })
  .strict();

export type EmailOtpVerifyRequest = z.infer<typeof emailOtpVerifyRequestSchema>;
