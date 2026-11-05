// STORY-180 r7 - the job id an HTTP request reserves a tier-cap unit under.
//
// `usage_reservations` is keyed (workspace, metric, job_id). A bare Idempotency-Key is chosen by the CLIENT, so two users of one workspace
// presenting the same key would share a reservation (the second request waved through as a "replay" of the first user's), and a client
// could present `scheduled-report:<id>` and collide with a scheduled run. Namespacing by transport and actor closes both: `http:` can never
// equal `scheduled-report:`, and the actor id keeps one user's keys apart from another's.
export function httpReservationJobId(actorId: string, idempotencyKey: string): string {
  return `http:${actorId}:${idempotencyKey}`;
}
