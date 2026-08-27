/**
 * STORY-026 — DI tokens for the realtime gateway's configuration.
 *
 * Kept in their own module so `room-authorization.service.ts` does not import
 * `gateway.module.ts`, which imports it back.
 */

/** The origins permitted to open a socket — `REALTIME_ALLOWED_ORIGINS`, split and trimmed. */
export const REALTIME_ALLOWED_ORIGINS = Symbol("REALTIME_ALLOWED_ORIGINS");
