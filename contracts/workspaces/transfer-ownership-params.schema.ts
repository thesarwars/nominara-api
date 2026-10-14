import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// The :id of every /workspaces/{id}/transfer-ownership[/...] route. Validated
// at the boundary so a non-UUID is a 400 rather than a uuid-cast 500 deeper in.
export const transferOwnershipParamsSchema = z
  .object({
    id: lowercaseUuidSchema,
  })
  .strict();

export type TransferOwnershipParams = z.infer<typeof transferOwnershipParamsSchema>;
