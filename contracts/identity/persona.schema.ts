import { z } from "zod";

// The onboarding persona (schemas/identity-and-tenancy.md `users.persona_*`).
// It drives UI defaults only and gates nothing. `volume` is the number of
// brands the workspace will track (NEW-A-2 / decision O5); `skipped` records
// that the person dismissed the question, which is different from never having
// been asked (the whole object is null in the response).
export const personaSchema = z
  .object({
    org_type: z.enum(["in_house", "agency"]).nullable(),
    volume: z.enum(["one", "2_5", "6_20", "gt_20"]).nullable(),
    focus: z.enum(["ecommerce", "technical_seo", "corporate_pr", "mixed"]).nullable(),
    skipped: z.boolean(),
  })
  .strict();

export type Persona = z.infer<typeof personaSchema>;
