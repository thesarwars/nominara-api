import type { Cache, CacheSetOptions, TokenBucketOutcome, TokenBucketSpec } from "../../src/lib/cache/cache.port.js";

// STORY-170 — a Cache that can be told to fail, per operation, for the specs
// whose subject is what a caller does when the cache is not there (the
// refresh-token grace slot fails CLOSED: a rotation still succeeds, and a
// replay then revokes).
//
// A wrapper over a real adapter rather than a hand-rolled fake, so that with
// no fault set it behaves exactly like the adapter underneath, and so a test
// can switch a fault on and off between two calls of ONE scenario — "the
// write failed, then the cache came back, then the replay arrived" is the
// case a permanently broken cache cannot express.
//
// The rejection carries a connection URL with credentials on purpose: real
// client errors do (an ioredis connection error can name the URL), so a caller
// that logged `error.message` would leak it, and the test can assert it did not.

export type CacheFault = "reject" | "hang";

export type CacheOperation = "get" | "set" | "delete";

export const FAULT_ERROR_SECRET = "hunter2-cache-password";

export class FaultInjectingCache implements Cache {
  /** Operations that currently fail, and how. An absent key passes straight through. */
  readonly faults = new Map<CacheOperation, CacheFault>();

  /** Milliseconds each operation takes BEFORE it reaches the cache — a slow cache, not a broken one. */
  readonly delays = new Map<CacheOperation, number>();

  /** Called the instant an operation is invoked, before any fault or delay is applied. */
  onEnter: ((operation: CacheOperation) => void) | undefined;

  constructor(private readonly inner: Cache) {}

  private async through<T>(operation: CacheOperation, run: () => Promise<T>): Promise<T> {
    this.onEnter?.(operation);
    const fault = this.faults.get(operation);
    if (fault === "reject") {
      throw new Error(`connect ECONNREFUSED redis://cache:${FAULT_ERROR_SECRET}@valkey.internal:6390`);
    }
    if (fault === "hang") {
      // Accepted the call and never answers — the failure a refused
      // connection is not: nothing rejects, so only a deadline can end it.
      return new Promise<T>(() => {});
    }
    const delayMs = this.delays.get(operation);
    if (delayMs !== undefined) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return run();
  }

  get(key: string): Promise<string | undefined> {
    return this.through("get", () => this.inner.get(key));
  }

  set(key: string, value: string, options: CacheSetOptions): Promise<boolean> {
    return this.through("set", () => this.inner.set(key, value, options));
  }

  delete(key: string): Promise<void> {
    return this.through("delete", () => this.inner.delete(key));
  }

  getMany(keys: readonly string[]): Promise<readonly (string | undefined)[]> {
    return this.inner.getMany(keys);
  }

  deleteIf(key: string, expected: string): Promise<boolean> {
    return this.inner.deleteIf(key, expected);
  }

  increment(key: string, ttlMs: number): Promise<number> {
    return this.inner.increment(key, ttlMs);
  }

  timeToLiveMs(key: string): Promise<number | undefined> {
    return this.inner.timeToLiveMs(key);
  }

  consume(key: string, bucket: TokenBucketSpec): Promise<TokenBucketOutcome> {
    return this.inner.consume(key, bucket);
  }
}
