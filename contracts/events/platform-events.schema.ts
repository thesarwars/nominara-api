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

/**
 * `resync` — "you have missed things; refetch."
 *
 * The gateway sends this instead of a backlog. Buffering a client that cannot
 * keep up moves its problem into the gateway's memory, where it becomes every
 * client's, and eventually delivers a flood of stale state that must be
 * applied in order. One directive costs the client one query and the gateway
 * nothing.
 *
 * `scope` says what to refetch, and it matters: a socket that blew §9's
 * per-socket cap has missed events across the whole workspace, while a project
 * that blew §11's "≤ 5 / s" has missed only its own rows. Refetching
 * everything for the second case is wasteful; refetching one project for the
 * first would leave real gaps.
 *
 * `project_id` is NULLABLE rather than optional — always on the wire, null
 * when the scope is the socket. A field that is sometimes absent is a field
 * every client must remember to check for.
 */
export const resyncEventSchema = z
  .object({
    reason: z.literal("rate_limited"),
    scope: z.enum(["socket", "project"]),
    project_id: z.uuid().nullable(),
  })
  .strict();

/**
 * The `4403` frame — system-architecture.md §9's refusal.
 *
 * socket.io's `disconnect()` carries no application close code, so the code
 * travels as a terminal frame before the socket is closed. A client reading it
 * gets the signal §9 specifies; one that ignores it is disconnected anyway.
 *
 * `reason` is deliberately coarse and nullable. Distinguishing "not a member"
 * from "workspace suspended" over a channel that has just failed
 * authorisation would answer a question the caller has not earned.
 */
export const socketErrorEventSchema = z
  .object({
    close_code: z.literal(4403),
    reason: z.string().min(1).nullable(),
  })
  .strict();

export type MemberChangedEvent = z.infer<typeof memberChangedEventSchema>;
export type ResyncEvent = z.infer<typeof resyncEventSchema>;
export type SocketErrorEvent = z.infer<typeof socketErrorEventSchema>;
export type ServerDrainingEvent = z.infer<typeof serverDrainingEventSchema>;
