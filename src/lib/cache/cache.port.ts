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
}
