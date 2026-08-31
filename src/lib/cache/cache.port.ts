// STORY-025 T14 — the cache port.
//
// Same shape as the two ports this repository already defines (DEK_PROVISIONER
// in src/modules/workspaces/ports/, EMAIL_SENDER in src/modules/identity/
// ports/): an interface plus a DI token, one production adapter, one adapter
// for tests. It introduces no pattern; it applies the one already here.
//
// The surface is deliberately tiny — five operations, all of which Valkey and
// an in-memory map implement identically. Anything richer (pipelines, Lua,
// pub/sub) would make the in-memory adapter a simulation of Valkey rather
// than an implementation of this interface, and a simulation is the kind of
// fake that passes while production fails.

export const CACHE = Symbol("CACHE");

export interface CacheSetOptions {
  /** Time to live in milliseconds. Every key this service writes is expiring; none is permanent. */
  readonly ttlMs: number;
  /** Set only if the key does not already exist. This is the whole of the idempotency claim mechanism. */
  readonly onlyIfAbsent?: boolean;
}

export interface Cache {
  get(key: string): Promise<string | undefined>;

  /**
   * Reads many keys in ONE round trip, in the order given, with `undefined`
   * for each miss.
   *
   * The seventh operation, added by STORY-032 for the same reason the sixth
   * was: it cannot be built from the others *at the cost the caller needs*.
   * A capture run plans hundreds of cells and probes L1 for every one of
   * them. Served by a loop of `get`, that is hundreds of sequential round
   * trips on the planning path — the cost the cache exists to avoid, paid to
   * find out whether it can be avoided.
   *
   * Note this is `getMany`, NOT a general `pipeline()`. The comment above
   * rejects pipelines because they would make the in-memory adapter a
   * SIMULATION of Valkey. That argument does not reach here, and the
   * distinction is the whole reason this shape was chosen: an in-memory map
   * implements a multi-key read honestly — the same lookups, returned
   * together — whereas it could only ever fake a pipeline's batching
   * semantics. Both adapters implement this operation; neither pretends to.
   */
  getMany(keys: readonly string[]): Promise<readonly (string | undefined)[]>;

  /**
   * Returns false when `onlyIfAbsent` was requested and the key already
   * existed — which is how a caller learns it LOST the race, rather than
   * discovering it by reading back a value someone else wrote.
   */
  set(key: string, value: string, options: CacheSetOptions): Promise<boolean>;

  delete(key: string): Promise<void>;

  /**
   * Deletes a key ONLY if it still holds `expected`. Returns whether it did.
   *
   * An unconditional delete is unsafe under `allkeys-lru`, and the sequence is
   * not exotic: request A claims a key; the cache evicts it under memory
   * pressure; request B claims the now-absent key, runs the effect, and writes
   * its completed record; request A then fails and deletes B's record. B's
   * client retries and the billable effect happens a SECOND time — which is
   * the one outcome `NFR-API-07` exists to prevent.
   */
  deleteIf(key: string, expected: string): Promise<boolean>;

  /**
   * Increments a counter and returns the new value, setting the TTL only when
   * the key is created.
   *
   * Both halves matter. Incrementing server-side rather than read-modify-write
   * is what makes two concurrent requests count as two; setting the TTL only
   * on creation is what stops a busy caller from pushing the window's end
   * further out with every request, which would turn a 60/minute bucket into
   * a bucket that never resets while traffic continues.
   */
  increment(key: string, ttlMs: number): Promise<number>;

  /** Milliseconds until the key expires, or undefined if it has none or does not exist. */
  timeToLiveMs(key: string): Promise<number | undefined>;

  /**
   * Takes one token from a token bucket, atomically.
   *
   * api-specification.md §12 says "token buckets", and its table carries a
   * Burst column ALONGSIDE each rate — two columns that are only
   * non-redundant in the token-bucket model, where `capacity` is what a
   * client may spend at once and the rate is how fast it comes back. A fixed
   * window counter has nowhere to put the second number, so it would have to
   * be ignored, and ignoring a column of the reference is not implementing
   * it.
   *
   * The sixth operation on a port whose comment argues for a small surface,
   * and the reason is the same one that argues for smallness: this cannot be
   * built from the other five. Refill-check-decrement over `get`/`set` is a
   * read-modify-write, and two concurrent requests would both read the same
   * token count and both spend it.
   */
  consume(key: string, bucket: TokenBucketSpec): Promise<TokenBucketOutcome>;
}

export interface TokenBucketSpec {
  /** What may be spent at once — §12's Burst column. */
  readonly capacity: number;
  /** How many tokens return per `refillWindowMs` — §12's rate column. */
  readonly refillTokens: number;
  readonly refillWindowMs: number;
}

export interface TokenBucketOutcome {
  readonly allowed: boolean;
  /** Whole tokens left after this call. `X-RateLimit-Remaining` is this number. */
  readonly remaining: number;
  /** Milliseconds until the NEXT token is available. `Retry-After` and `X-RateLimit-Reset` come from this. */
  readonly resetAfterMs: number;
}
