import { z } from "zod";

// STORY-085-A — POST /v1/command/parse (api-specification.md §10).
// `.strict()`: an unknown key is a 400, never a silent drop.
export const commandParseRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
  })
  .strict();

export type CommandParseRequest = z.infer<typeof commandParseRequestSchema>;
