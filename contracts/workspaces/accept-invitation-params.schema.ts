import { z } from "zod";

// POST /workspaces/{id}/invitations/accept — the PATH contract (STORY-172).
// The route is @SkipTenantContext(), so no guard has validated `:id` before
// the handler opens its own tenant context on it; a non-UUID would reach
// `set_config('app.workspace_id', …)` and the uuid cast behind it and surface
// as a 500. Validating the shape here makes it a 400 at the boundary. It says
// nothing about whether the workspace exists — that stays the uniform refusal.
export const acceptInvitationParamsSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

export type AcceptInvitationParams = z.infer<typeof acceptInvitationParamsSchema>;
