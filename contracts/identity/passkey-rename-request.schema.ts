import { z } from "zod";

// PATCH /me/passkeys/{id} — rename only.
export const passkeyRenameRequestSchema = z
  .object({
    device_label: z.string().min(1).max(100),
  })
  .strict();

export type PasskeyRenameRequest = z.infer<typeof passkeyRenameRequestSchema>;
