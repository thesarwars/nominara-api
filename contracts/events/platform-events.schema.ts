import { z } from "zod";

// STORY-026 T19 — api-specification.md §11's two platform events. Both are
// emitted by THIS repository rather than by a worker that does not exist yet,
// which makes them the two whose shapes are load-bearing today.

/**
 * `member.changed` — §11's own note: "forces socket re-auth".
 *
 * That parenthetical is the entire point of the event. A membership change is
 * the one thing that can make an already-authorised socket unauthorised, and
 * without this the only thing closing that window is the 60-second
 * re-validation timer. security-and-tenancy.md §7 and EPIC-02's risk table
 * both name that window; this event is what shortens it to immediate.
 *
 * So the payload is deliberately the SUBJECT of the change and nothing else —
 * no role labels for display, no actor. A client receiving it does not render
 * it; the gateway acts on it.
 */
export const memberChangedEventSchema = z
  .object({
    workspace_id: z.uuid(),
    user_id: z.uuid(),
    role: z.enum(["owner", "admin", "manager", "analyst", "viewer"]),
    status: z.enum(["active", "suspended", "removed"]),
  })
  .strict();

/**
 * `server.draining` — the gateway telling clients it is going away.
 *
 * `reconnect_after_ms` is per-socket and JITTERED by the emitter, not a
 * constant: every client reconnecting at the same instant after a deploy is a
 * thundering herd against a gateway that has just lost capacity. The schema
 * carries the shape; the jitter is asserted where it is produced.
 */
export const serverDrainingEventSchema = z
  .object({
    reconnect_after_ms: z.number().int().positive(),
  })
  .strict();

export type MemberChangedEvent = z.infer<typeof memberChangedEventSchema>;
export type ServerDrainingEvent = z.infer<typeof serverDrainingEventSchema>;
