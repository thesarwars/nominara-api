import { z } from "zod";
import { personaSchema } from "./persona.schema.js";

// GET /me and PATCH /me response (api-specification §2). The caller's own
// identity. `active_workspace_id` is the verified access token's `ws` claim —
// null before a workspace is chosen — and is never read from a query or body.
// `persona` is null when the person has never answered or skipped.
export const meResponseSchema = z
  .object({
    user: z
      .object({
        user_id: z.uuid(),
        name: z.string(),
        email: z.string(),
      })
      .strict(),
    active_workspace_id: z.uuid().nullable(),
    persona: personaSchema.nullable(),
    locale: z.string(),
    timezone: z.string(),
  })
  .strict();

export type MeResponse = z.infer<typeof meResponseSchema>;
