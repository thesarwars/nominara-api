import { z } from "zod";

// PATCH /workspaces/{id}. STORY-021-E-8: `region` is deliberately ACCEPTED
// here so the service can refuse a change to it with an explanation
// (`409 conflict`, `details.reason = "region_immutable"`) — a `.strict()`
// schema that omitted `region` would answer a residency question with
// "unrecognized key", which is a validation error, not an explanation.
// No other field name in this story's references is documented as
// updatable, so nothing beyond `name`/`timezone`/`region` is accepted.
export const updateWorkspaceRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    timezone: z.string().min(1).optional(),
    region: z.enum(["us-east-1", "eu-central-1"]).optional(),
  })
  .strict();

export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;
