import { z } from "zod";

// STORY-025 T13 — `NFR-API-07`: "`Idempotency-Key` is ENFORCED, not merely
// accepted, on every endpoint that spends credits, calls an external system,
// or mints a secret. A replayed credit-spending request returns the original
// result and debits NOTHING additional."
//
// api-specification.md §1 gives the header's contract: "`Idempotency-Key:
// <=255 chars>`, on every billable or external-effect POST. 24-hour replay
// window. Identical key + identical body returns the cached response;
// identical key + different body is `409 idempotency_conflict`."
//
// NOT the same mechanism as STORY-030's "idempotency keys", despite the
// shared name. Those are per-queue JOB keys (`cap:{prompt}:{engine}:{run}`,
// `NFR-SIM-03`) that make a worker's effect exactly-once. These are HTTP
// REQUEST keys, supplied by the caller, that make a network retry safe. The
// two must never be merged or share a namespace.

/**
 * The `Idempotency-Key` request header.
 *
 * The cap is the reference's, and it is a real bound rather than decoration:
 * the key is hashed into a Valkey key, so an unbounded one is an unbounded
 * write from an unauthenticated-shaped input.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export const idempotencyKeySchema = z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH);

/** §1: "24-hour replay window." Expressed in milliseconds per `NFR-API-05`. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Decision D6 — a replay carries `Idempotency-Replayed: true`.
 *
 * The BODY is byte-identical to the original, which is what STORY-025 AC2
 * requires and what makes a retry safe. That is also what makes the header
 * necessary: without it a client cannot tell "my retry was absorbed" from "my
 * request ran again and happened to produce the same answer", and those call
 * for different behaviour in a UI that reports what it did.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = "idempotency-replayed";

export const idempotencyReplayedValueSchema = z.literal("true");

/**
 * `409 idempotency_conflict` — same key, different body.
 *
 * Carries the hash of the FIRST body seen under this key, never the body
 * itself: the original request may have belonged to a different session, and
 * echoing its content back to whoever presents the same key would turn a
 * conflict response into an oracle.
 */
export const idempotencyConflictDetailsSchema = z
  .object({
    key_hash: z.string().length(64),
    original_request_hash: z.string().length(64),
    original_recorded_at: z.iso.datetime(),
  })
  .strict();

export type IdempotencyConflictDetails = z.infer<typeof idempotencyConflictDetailsSchema>;

/**
 * What the store holds for a completed request.
 *
 * `response_body` is the ENVELOPE, not the handler's return value —
 * STORY-025 AC2 requires a replay to return a byte-identical body, and the
 * envelope is what the client received. This is why IdempotencyInterceptor
 * is registered OUTERMOST of the interceptor chain: its "after" logic runs
 * last and therefore sees the finished envelope (see
 * response-envelope.interceptor.ts's registration note).
 */
export const idempotencyRecordSchema = z
  .object({
    state: z.literal("completed"),
    request_hash: z.string().length(64),
    status_code: z.number().int().min(100).max(599),
    response_body: z.unknown(),
    recorded_at: z.iso.datetime(),
  })
  .strict();

export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;

/**
 * What the store holds while the FIRST request is still running.
 *
 * A separate state rather than an absent record, because "no record" and
 * "someone else is doing this right now" call for different answers: the
 * first is a new request, the second must not be executed a second time.
 * Test row 4 (a concurrent replay while the first is in flight) is the whole
 * reason this member exists.
 */
export const idempotencyInFlightSchema = z
  .object({
    state: z.literal("in_flight"),
    request_hash: z.string().length(64),
    started_at: z.iso.datetime(),
  })
  .strict();

export type IdempotencyInFlight = z.infer<typeof idempotencyInFlightSchema>;

export const idempotencyStoredSchema = z.discriminatedUnion("state", [
  idempotencyRecordSchema,
  idempotencyInFlightSchema,
]);

export type IdempotencyStored = z.infer<typeof idempotencyStoredSchema>;
