import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-096 AC4/AC7 (owner decision 100(d)) — GET /me/sessions: the caller's OWN live sessions, across every workspace.
// Exhaustive by construction (`.strict()`): the raw User-Agent, any IP address, the refresh-token state and the strong-auth stamp are deliberately absent
// and must never be added (no IP is stored; the User-Agent is a fingerprint and is only ever shown parsed).
//
// `browser`, `os` and `device_type` are parsed from the stored User-Agent and are null where it was absent or not recognised — never a guess.
// `last_active_at` is the session's last sign-in or refresh, not the last request. `current` marks the session making the call.
export const sessionListItemSchema = z
  .object({
    id: z.uuid(),
    browser: z.string().nullable(),
    os: z.string().nullable(),
    device_type: z.enum(["desktop", "mobile", "tablet"]).nullable(),
    created_at: z.iso.datetime(),
    last_active_at: z.iso.datetime(),
    current: z.boolean(),
  })
  .strict();

export const sessionListResponseSchema = z.array(sessionListItemSchema);

export type SessionListItem = z.infer<typeof sessionListItemSchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

// DELETE /me/sessions/{id}. A malformed id is a 400 and never reaches a query.
export const sessionIdParamsSchema = z.object({ id: lowercaseUuidSchema }).strict();
export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
