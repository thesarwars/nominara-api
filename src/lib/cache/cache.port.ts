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
   * Returns false when `onlyIfAbsent` was requested and the key already
   * existed — which is how a caller learns it LOST the race, rather than
   * discovering it by reading back a value someone else wrote.
   */
  set(key: string, value: string, options: CacheSetOptions): Promise<boolean>;

  delete(key: string): Promise<void>;

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
