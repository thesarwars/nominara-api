import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// The :id of DELETE /workspaces/{id}. Validated at the boundary so a non-UUID is a 400 rather than a uuid-cast 500 deeper in.
export const deleteWorkspaceParamsSchema = z.object({ id: lowercaseUuidSchema }).strict();

export type DeleteWorkspaceParams = z.infer<typeof deleteWorkspaceParamsSchema>;
