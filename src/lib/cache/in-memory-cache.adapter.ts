import { Injectable } from "@nestjs/common";
import type { Cache, CacheSetOptions } from "./cache.port.js";

// STORY-025 T14 — the in-process adapter.
//
// NOT a simulation of Valkey. It implements the five operations of
// src/lib/cache/cache.port.ts and nothing else, which is why the port is that
// small: a fake that is more capable, or more forgiving, than the thing it
// stands in for is how a suite goes green while production fails. That exact
// failure happened in this repository at STORY-024 T12, where a fake
// FastifyReply lacked `removeHeader` and the real one did.
//
// Expiry is evaluated on READ rather than by a timer. A timer would keep the
// process alive and would make every test that advances a clock racy; reading
// through a deadline check gives the same observable behaviour with no
// background work. Nothing here needs to reclaim memory: the process is a
// test process, and the real adapter is Valkey with `allkeys-lru`.

interface Entry {
  readonly value: string;
  readonly expiresAtMs: number;
}

@Injectable()
export class InMemoryCacheAdapter implements Cache {
  private readonly entries = new Map<string, Entry>();

  /** Injectable so a test can advance time without sleeping. Defaults to the real clock. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.live(key)?.value);
  }

  set(key: string, value: string, options: CacheSetOptions): Promise<boolean> {
    if (options.onlyIfAbsent === true && this.live(key) !== undefined) {
      return Promise.resolve(false);
    }
    this.entries.set(key, { value, expiresAtMs: this.now() + options.ttlMs });
    return Promise.resolve(true);
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  increment(key: string, ttlMs: number): Promise<number> {
    const existing = this.live(key);
    if (existing === undefined) {
      this.entries.set(key, { value: "1", expiresAtMs: this.now() + ttlMs });
      return Promise.resolve(1);
    }
    const next = Number(existing.value) + 1;
    // The deadline is NOT extended. A window that slid forward on every
    // request would never close while traffic continued, which turns a rate
    // limit into a no-op precisely when it is needed.
    this.entries.set(key, { value: String(next), expiresAtMs: existing.expiresAtMs });
    return Promise.resolve(next);
  }

  timeToLiveMs(key: string): Promise<number | undefined> {
    const entry = this.live(key);
    return Promise.resolve(entry === undefined ? undefined : entry.expiresAtMs - this.now());
  }

  /** Test affordance only — never part of the port, so no production path can reach it. */
  clear(): void {
    this.entries.clear();
  }
}
