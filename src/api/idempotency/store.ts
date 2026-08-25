import { Inject, Injectable } from "@nestjs/common";
import {
  IDEMPOTENCY_CLAIM_TTL_MS,
  IDEMPOTENCY_WINDOW_MS,
  idempotencyStoredSchema,
  type IdempotencyStored,
} from "../../../contracts/common/idempotency.schema.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";

// STORY-025 T16 — the idempotency record store.
//
// api-specification.md §1: "24-hour replay window. Identical key + identical
// body returns the cached response; identical key + different body is `409
// idempotency_conflict`."
//
// Everything here hangs off ONE primitive: a set-if-absent. That is what makes
// the claim atomic, and atomicity is the whole requirement — two concurrent
// requests bearing the same key must produce exactly one execution. A
// read-then-write would let both read "absent" and both proceed, which is the
// double-charge NFR-API-07 exists to prevent, made rarer but not impossible.

export interface CompletedRecord {
  readonly requestHash: string;
  readonly statusCode: number;
  readonly responseBody: unknown;
  readonly recordedAt: string;
}

@Injectable()
export class IdempotencyStore {
  /**
   * What this process wrote when it claimed, so `release` can prove the record
   * is still its own. Process-local by design: another process's claim is not
   * this one's to release.
   */
  private readonly claims = new Map<string, string>();

  constructor(@Inject(CACHE) private readonly cache: Cache) {}

  /**
   * Attempts to claim the key for this request.
   *
   * Returns true if this caller won and must execute; false if a record
   * already exists, in which case the caller reads it and decides between
   * replay, conflict, and in-flight.
   */
  async claim(key: string, requestHash: string, startedAt: string): Promise<boolean> {
    const inFlight: IdempotencyStored = { state: "in_flight", request_hash: requestHash, started_at: startedAt };
    // A BOUNDED lifetime, not the replay window. A claim carrying 24 hours
    // poisons the key for a day if the process dies before completing: every
    // retry reads `in_flight`, gets a 409, and the effect never happens.
    const claimed = await this.cache.set(key, JSON.stringify(inFlight), {
      ttlMs: IDEMPOTENCY_CLAIM_TTL_MS,
      onlyIfAbsent: true,
    });
    if (claimed) this.claims.set(key, JSON.stringify(inFlight));
    return claimed;
  }

  /**
   * Reads whatever is stored under the key.
   *
   * A value that fails the contract is treated as ABSENT rather than thrown
   * on. The cache runs `allkeys-lru` and is shared with other mechanisms; a
   * malformed or truncated value should degrade to "execute again", which is
   * the same outcome as an evicted record, rather than wedging a route into
   * permanent 500s that no deploy can clear.
   */
  async read(key: string): Promise<IdempotencyStored | undefined> {
    const raw = await this.cache.get(key);
    if (raw === undefined) return undefined;
    try {
      const parsed = idempotencyStoredSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Records the finished response, replacing the in-flight claim.
   *
   * The TTL is the FULL window measured from completion, not the remainder of
   * the claim's. §1 dates the window from the request, and the difference is
   * at most the handler's own duration — but writing it as a fresh window
   * makes the record outlive its claim rather than expiring mid-replay.
   */
  async complete(key: string, record: CompletedRecord): Promise<void> {
    const completed: IdempotencyStored = {
      state: "completed",
      request_hash: record.requestHash,
      status_code: record.statusCode,
      response_body: record.responseBody,
      recorded_at: record.recordedAt,
    };
    // The RECORD carries the 24-hour replay window — it is written once the
    // effect has actually happened, which is what §1 dates the window from.
    this.claims.delete(key);
    await this.cache.set(key, JSON.stringify(completed), { ttlMs: IDEMPOTENCY_WINDOW_MS });
  }

  /**
   * Drops the claim after a FAILED execution.
   *
   * A request that errored has no response worth replaying, and leaving the
   * claim in place would lock the key for 24 hours — so a client that retried
   * after a transient failure would be refused for a day. Only the failure
   * path calls this; a successful request's claim is replaced by complete().
   */
  async release(key: string): Promise<boolean> {
    const mine = this.claims.get(key);
    this.claims.delete(key);
    if (mine === undefined) return false;
    // COMPARE-AND-DELETE, never an unconditional one. Under `allkeys-lru` the
    // claim can be evicted, a second request can claim the free key, run the
    // effect and write its record — and an unconditional delete here would
    // remove THAT record, so the second client's retry would execute the
    // billable effect again.
    return this.cache.deleteIf(key, mine);
  }
}
