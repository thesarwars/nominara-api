import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-085 (decisions 78c, 79) — POST /v1/command/execute.
//
// The parse id is single-use and bound to the workspace, the user and the
// action it was issued for; `action_id` must be the one the parse offered.
// `.strict()`: an unknown key is a 400, never a silent drop.
//
// `project_id` is the caller's disambiguation when the parse could not bind a
// project from the typed text (a bare "create a task ..." names none). It is
// checked against the caller's own visible projects at execute; it can never
// widen what the parse bound, and a value that disagrees with a bound project is
// a 400.
export const commandExecuteRequestSchema = z
  .object({
    parse_id: lowercaseUuidSchema,
    action_id: z.string().min(1).max(64),
    project_id: lowercaseUuidSchema.optional(),
  })
  .strict();

export type CommandExecuteRequest = z.infer<typeof commandExecuteRequestSchema>;
