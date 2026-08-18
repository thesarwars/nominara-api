import { z } from "zod";

// POST /auth/passkey/options, purpose 'registration'. Public route — there is
// no session to identify the caller by, so the ceremony is anchored to an
// email instead: identity.service finds-or-creates the `users` row (STORY-014
// Technical Notes; schemas/identity-and-tenancy.md's `status='unverified'`
// account class already anticipates this), and every credential registered
// against the same email accumulates on that one user — this is how test
// scenario 2 ("register a second credential") reaches the same user without
// a session existing yet.
export const registrationOptionsRequestSchema = z
  .object({
    purpose: z.literal("registration"),
    email: z.email(),
    display_name: z.string().min(1).max(200).optional(),
  })
  .strict();

export type RegistrationOptionsRequest = z.infer<typeof registrationOptionsRequestSchema>;
