import { z } from "zod";

// The body of initiate / accept / decline / cancel (STORY-021 core slice).
// The wire form of the `workspaces.ownership_transfer` jsonb document
// (ownership-transfer.schema.ts), snake_case like every other response.
//
// `state` is the state the request LEFT the transfer in:
//   initiate -> awaiting_acceptance   accept -> completed
//   decline  -> declined              cancel -> cancelled
// (`expired` is never returned as a success; an expired transfer is refused
// with 409 `conflict` / `reason: transfer_expired`.)
export const transferOwnershipResponseSchema = z
  .object({
    workspace_id: z.uuid(),
    state: z.enum(["awaiting_acceptance", "completed", "declined", "cancelled"]),
    initiated_by: z.uuid(),
    recipient_id: z.uuid(),
    initiated_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    resolved_at: z.iso.datetime().nullable(),
  })
  .strict();

export type TransferOwnershipResponse = z.infer<typeof transferOwnershipResponseSchema>;
