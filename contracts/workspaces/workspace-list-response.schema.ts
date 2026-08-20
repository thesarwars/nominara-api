import { z } from "zod";

// GET /workspaces response body (AC 5): "memberships only, separating owned
// from joined, each with its plan badge." This is a membership-shaped
// listing, not a `workspaceResponseSchema` array — a joined workspace's
// limits come from its own subscription, and `role` disambiguates which
// bucket a caller is looking at without re-deriving it client-side.
export const workspaceListItemSchema = z
  .object({
    workspace_id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    role: z.enum(["owner", "admin", "manager", "analyst", "viewer"]),
    plan_key: z.string(),
    status: z.enum([
      "trialing",
      "active",
      "past_due",
      "soft_capped",
      "suspended",
      "pending_deletion",
      "deleted",
    ]),
  })
  .strict();

export const workspaceListResponseSchema = z
  .object({
    owned: z.array(workspaceListItemSchema),
    joined: z.array(workspaceListItemSchema),
  })
  .strict();

export type WorkspaceListItem = z.infer<typeof workspaceListItemSchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
