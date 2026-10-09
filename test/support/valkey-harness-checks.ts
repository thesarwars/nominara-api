import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { testCacheRedisUrl, testQueueRedisUrl } from "./test-valkey.js";

// STORY-174 AC1/AC4 — shared body of the two harness specs
// (valkey-harness-a.spec.ts, valkey-harness-b.spec.ts). Both write a marker
// key and both assert it is ABSENT when the file starts. Vitest picks the file
// order, so whichever runs second sees the first's marker unless the setup
// file really flushed the shared containers between files — the check holds in
// either order and is vacuous in neither.

const MARKER = "story-174:harness-marker";

async function withClient<T>(url: string, fn: (client: Redis) => Promise<T>): Promise<T> {
  const client = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

export function defineHarnessChecks(label: string): void {
  describe(`STORY-174 · the Valkey harness (${label})`, () => {
    it("AC4 · the queue URL is a live throwaway Valkey with BullMQ's eviction policy (noeviction)", async () => {
      await withClient(testQueueRedisUrl(), async (client) => {
        expect(await client.ping()).toBe("PONG");
        expect(await client.config("GET", "maxmemory-policy")).toEqual(["maxmemory-policy", "noeviction"]);
      });
    });

    it("AC4 · the cache URL is a live, DIFFERENT throwaway Valkey with the cache policy (allkeys-lru)", async () => {
      expect(testCacheRedisUrl()).not.toBe(testQueueRedisUrl());
      await withClient(testCacheRedisUrl(), async (client) => {
        expect(await client.ping()).toBe("PONG");
        expect(await client.config("GET", "maxmemory-policy")).toEqual(["maxmemory-policy", "allkeys-lru"]);
      });
    });

    it("AC4 · both instances start every spec file EMPTY, and a marker written here is gone for the next file", async () => {
      for (const url of [testQueueRedisUrl(), testCacheRedisUrl()]) {
        await withClient(url, async (client) => {
          expect(await client.get(MARKER), "the previous file's marker survived: the between-files flush is broken").toBeNull();
          expect(await client.dbsize()).toBe(0);
          await client.set(MARKER, label);
        });
      }
    });
  });
}
