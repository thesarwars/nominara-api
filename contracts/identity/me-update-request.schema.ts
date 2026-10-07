import { z } from "zod";
import { personaSchema } from "./persona.schema.js";

// PATCH /me — the onboarding persona is the only mutable field this week.
// Strict: an unknown key is a 400, not a silent drop.
export const meUpdateRequestSchema = z
  .object({
    persona: personaSchema,
  })
  .strict();

export type MeUpdateRequest = z.infer<typeof meUpdateRequestSchema>;
