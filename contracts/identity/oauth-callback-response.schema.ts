import { z } from "zod";

// STORY-015 — the callback endpoint responds with JSON, not a redirect
// (nominara-app has no SPA yet to redirect to; a frontend story owns the
// eventual redirect behaviour). `outcome` distinguishes a brand-new account
// from a link onto an already-authenticated one; `user_status` surfaces
// AC4's unverified-email path (no workspace-create right) without the
// caller needing a second round-trip to find out.
export const oauthCallbackResponseSchema = z
  .object({
    outcome: z.enum(["signed_in", "linked"]),
    user_status: z.enum(["active", "unverified"]),
  })
  .strict();

export type OauthCallbackResponse = z.infer<typeof oauthCallbackResponseSchema>;
