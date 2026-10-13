import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// PATCH /members/{id}. `role` deliberately INCLUDES `owner` at the schema
// level — STORY-021-E-9 requires the service, not this contract, to produce
// two different refusal shapes for a `role: "owner"` request depending on
// the actor's own permission (`403 forbidden` vs. `409 conflict`). A
// `.strict()` schema that rejected `owner` outright would collapse both
// cases into an undifferentiated validation error.
export const updateMemberRoleRequestSchema = z
  .object({
    role: z.enum(["owner", "admin", "manager", "analyst", "viewer"]),
    project_scope: z.array(lowercaseUuidSchema).nullable().optional(),
  })
  .strict();

export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequestSchema>;
