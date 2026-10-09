import { z } from "zod";
import { workspaceResponseSchema } from "./workspace-response.schema.js";

// GET /workspaces/{id} (NEW-A-12) — the workspace plus its deletion state.
// `deletion_scheduled_at` is workspaces.deletion_execute_at: null while the
// workspace is not pending deletion (null means "not scheduled", never 0).
export const workspaceDetailResponseSchema = workspaceResponseSchema
  .extend({
    deletion_scheduled_at: z.iso.datetime().nullable(),
  })
  .strict();

export type WorkspaceDetailResponse = z.infer<typeof workspaceDetailResponseSchema>;
