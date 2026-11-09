import { z } from "zod";

// DELETE /workspaces/{id} — api-specification.md section 3 (`workspace:delete`, 30-day grace). The caller types the workspace's slug to
// confirm; the handler compares it with the stored slug, so a request that names the wrong workspace, or none, deletes nothing.
export const deleteWorkspaceRequestSchema = z
  .object({
    confirm_slug: z.string().min(1).max(200),
  })
  .strict();

export type DeleteWorkspaceRequest = z.infer<typeof deleteWorkspaceRequestSchema>;
