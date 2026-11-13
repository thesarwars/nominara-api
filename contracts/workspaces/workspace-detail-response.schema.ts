import { z } from "zod";
import { workspaceResponseSchema } from "./workspace-response.schema.js";

// GET /workspaces/{id} (NEW-A-12) — the workspace plus its deletion state.
// `deletion_scheduled_at` is workspaces.deletion_execute_at: null while the
// workspace is not pending deletion (null means "not scheduled", never 0).
export const workspaceDetailResponseSchema = workspaceResponseSchema
  .extend({
    deletion_scheduled_at: z.iso.datetime().nullable(),
    /**
     * STORY-096 AC3 - the date a retention-shortening plan change allows its first purge (workspaces.retention_purge_not_before, STORY-077 slice
     * B). Null when no deferral is in force, including once the date has passed. OPTIONAL in the contract only because a new required response
     * field is classified a MAJOR change by contracts:diff and this one is purely additive; the server always sends it.
     */
    retention_purge_not_before: z.iso.datetime().nullable().optional(),
  })
  .strict();

export type WorkspaceDetailResponse = z.infer<typeof workspaceDetailResponseSchema>;
