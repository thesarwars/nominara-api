import { z } from "zod";

// POST /workspaces/{id}/transfer-ownership — initiate (STORY-021 core slice,
// NEW-B-5; EC-15 in edge-cases-and-slos.md). The recipient is a USER id, and
// must already be an active `admin` of this workspace — the schema cannot know
// that, so the service checks it (and answers a stranger exactly as it answers
// a non-admin member). `.strict()`: an unknown key is a 400, never a silent
// drop, which matters here because the EC-15 decision payloads (credential
// retain/revoke, domains, export) are a follow-up and must not be half-accepted.
export const transferOwnershipRequestSchema = z
  .object({
    recipient_id: z.uuid(),
  })
  .strict();

export type TransferOwnershipRequest = z.infer<typeof transferOwnershipRequestSchema>;
