import { z } from "zod";

// POST /workspaces. schemas/identity-and-tenancy.md `workspaces` DDL —
// `slug` is OPTIONAL (STORY-195 AC2): onboarding derives one, lets the user
// edit it, and sends it; absent, the server derives it from `name`
// (STORY-021-E-4). `plan_key` is fixed to `free` at creation (STORY-021-E-2),
// so it is not accepted here. `region` defaults to `us-east-1` and is immutable once the row
// exists (STORY-021-E-8) — this schema only covers what's accepted on
// creation, not the separate PATCH refusal path.
export const createWorkspaceRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .max(60)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and single hyphens only")
      .optional(),
    org_type: z.enum(["in_house", "agency"]).optional(),
    region: z.enum(["us-east-1", "eu-central-1"]).optional(),
    timezone: z.string().min(1).optional(),
  })
  .strict();

export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;
