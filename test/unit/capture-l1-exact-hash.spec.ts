import { describe, expect, it } from "vitest";

import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { captureL1Key } from "../../src/lib/capture/l1-cache-key.js";
import {
  adapterMajorOf,
  parseL1Envelope,
  probeExactHash,
  type L1Candidate,
} from "../../src/lib/capture/l1-exact-hash.js";
import { cellKey } from "../../src/lib/capture/l2-semantic-reuse.js";

const CONTEXT = {
  env: "test",
  locale: "en-US",
  personaHint: null,
  nowMs: 1_700_000_000_000,
  sharedCacheEnabled: true,
} as const;

function candidate(overrides: Partial<L1Candidate> = {}): L1Candidate {
  return {
    promptId: "11111111-1111-4111-8111-111111111111",
    promptText: "best crm for small business",
    engineKey: "perplexity",
    sampleIndex: 0,
    ttlSeconds: 86_400,
    adapterVersion: "3.1.0",
    ...overrides,
  };
}

/** Records HOW the cache was reached, which is the half AC4 is about. */
function countingCache(): { cache: Cache; gets: string[]; batches: readonly string[][] } {
  const inner = new InMemoryCacheAdapter();
  const gets: string[] = [];
  const batches: string[][] = [];
  const cache: Cache = {
    get: (key) => {
      gets.push(key);
      return inner.get(key);
    },
    getMany: (keys) => {
      batches.push([...keys]);
      return inner.getMany(keys);
    },
    set: (key, value, options) => inner.set(key, value, options),
    delete: (key) => inner.delete(key),
    deleteIf: (key, expected) => inner.deleteIf(key, expected),
    increment: (key, ttlMs) => inner.increment(key, ttlMs),
    timeToLiveMs: (key) => inner.timeToLiveMs(key),
    consume: (key, bucket) => inner.consume(key, bucket),
  };
  return { cache, gets, batches };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** One shared entry: the engine's public answer, exactly as §6 describes it. */
function envelope(hash: string, answer = "the shared answer"): string {
  return JSON.stringify({ v: 1, contentHash: hash, payload: { answer }, excerpt: answer });
}

async function seed(cache: Cache, c: L1Candidate, hash: string, answer?: string): Promise<void> {
  await cache.set(
    captureL1Key({
      env: CONTEXT.env,
      engineKey: c.engineKey,
      adapterMajor: adapterMajorOf(c.adapterVersion),
      promptText: c.promptText,
      locale: CONTEXT.locale,
      personaHint: CONTEXT.personaHint,
      ttlSeconds: c.ttlSeconds,
      nowMs: CONTEXT.nowMs,
    }),
    envelope(hash, answer),
    { ttlMs: 60_000 },
  );
}

describe("STORY-032 AC4 · the L1 exact-hash probe", () => {
  // THE ACCEPTANCE CRITERION ITSELF. A per-cell `await cache.get(...)` loop
  // returns identical hits and would pass every other test in this file; the
  // only thing that separates it from a batch is the call pattern, so the
  // call pattern is what is asserted. This is the assertion a loop fails.
  it("reads the whole run in ONE batch operation, never a loop of single reads", async () => {
    const { cache, gets, batches } = countingCache();
    const candidates = Array.from({ length: 25 }, (_unused, index) =>
      candidate({ promptId: `1111111${String(index).padStart(2, "0")}-1111-4111-8111-111111111111`, promptText: `question ${String(index)}` }),
    );

    await probeExactHash(cache, CONTEXT, candidates);

    expect(gets, "a per-cell get() loop is exactly what AC4 forbids").toEqual([]);
    expect(batches, "25 cells must cost one round trip, not 25").toHaveLength(1);
    expect(batches[0]).toHaveLength(25);
  });

  it("sends one key per QUESTION, not one per sample — the key has no sample index", async () => {
    const { cache, batches } = countingCache();
    const samples = [0, 1, 2].map((sampleIndex) => candidate({ sampleIndex }));

    await probeExactHash(cache, CONTEXT, samples);

    expect(batches[0], "three samples of one prompt are one question").toHaveLength(1);
  });

  it("still returns a hit for EVERY cell that shared the deduped key", async () => {
    const { cache } = countingCache();
    const samples = [0, 1, 2].map((sampleIndex) => candidate({ sampleIndex }));
    await seed(cache, samples[0]!, HASH_A);

    const hits = await probeExactHash(cache, CONTEXT, samples);

    expect(hits.size, "deduping the READ must not drop cells from the RESULT").toBe(3);
    for (const sample of samples) {
      expect(hits.get(cellKey(sample))?.contentHash.toString("hex")).toBe(HASH_A);
    }
  });

  it("returns the hash stored for each distinct question, not one for all of them", async () => {
    const { cache } = countingCache();
    const first = candidate({ promptText: "best crm" });
    const second = candidate({ promptText: "best erp", promptId: "22222222-2222-4222-8222-222222222222" });
    const missing = candidate({ promptText: "best hrm", promptId: "33333333-3333-4333-8333-333333333333" });
    await seed(cache, first, HASH_A);
    await seed(cache, second, HASH_B);

    const hits = await probeExactHash(cache, CONTEXT, [first, second, missing]);

    expect(hits.get(cellKey(first))?.contentHash.toString("hex")).toBe(HASH_A);
    expect(hits.get(cellKey(second))?.contentHash.toString("hex")).toBe(HASH_B);
    expect(hits.has(cellKey(missing)), "a miss is not a hit").toBe(false);
  });

  // THE BYPASS, not a salt. A workspace on `no_shared_cache` must not read
  // the shared namespace at all — not read it and ignore the answer.
  it("touches the cache not at all for a workspace with no_shared_cache", async () => {
    const { cache, gets, batches } = countingCache();
    const only = candidate();
    await seed(cache, only, HASH_A);

    const hits = await probeExactHash(cache, { ...CONTEXT, sharedCacheEnabled: false }, [only]);

    expect(hits.size, "a seeded entry must not be served to a bypassing workspace").toBe(0);
    expect([...gets, ...batches.flat()], "and the shared namespace must not even be read").toEqual([]);
  });

  // The bypass must not be a place where a broken adapter version hides.
  it("still rejects a malformed adapter version for a bypassing workspace", async () => {
    const { cache } = countingCache();

    await expect(
      probeExactHash(cache, { ...CONTEXT, sharedCacheEnabled: false }, [candidate({ adapterVersion: "v3" })]),
    ).rejects.toThrow(/not semantic/u);
  });

  it("costs nothing when the run planned nothing", async () => {
    const { cache, gets, batches } = countingCache();
    expect((await probeExactHash(cache, CONTEXT, [])).size).toBe(0);
    expect([...gets, ...batches]).toEqual([]);
  });

  // THE ANSWER, NOT JUST ITS HASH.
  //
  // §6: "L1 entries store only an engine's public answer to a public
  // question... storage happens per tenant AFTER the cache read." This
  // module first shipped storing the hash alone, and the row it produced
  // carried no answer at all — nothing for the parser to read, and nothing
  // any tenant could recover unless it had already captured that same answer
  // itself. A hit must arrive with the content.
  it("returns the ANSWER, so the suppressed row is one the parser can read", async () => {
    const { cache } = countingCache();
    const only = candidate();
    await seed(cache, only, HASH_A, "Acme is widely recommended.");

    const hit = (await probeExactHash(cache, CONTEXT, [only])).get(cellKey(only));

    expect(hit?.payload, "an empty payload is an unscoreable row").toEqual({ answer: "Acme is widely recommended." });
    expect(hit?.excerpt).toBe("Acme is widely recommended.");
    expect(hit?.contentHash.toString("hex")).toBe(HASH_A);
  });

  it.each([
    ["not JSON at all", "not-a-digest"],
    ["a bare hash, which is the shape this module shipped with", "a".repeat(64)],
    ["an envelope from a future build", JSON.stringify({ v: 2, contentHash: "a".repeat(64), payload: {} })],
    ["an envelope whose hash is not a digest", JSON.stringify({ v: 1, contentHash: "nope", payload: {} })],
    ["an envelope with no payload", JSON.stringify({ v: 1, contentHash: "a".repeat(64) })],
    ["an envelope whose payload is an array", JSON.stringify({ v: 1, contentHash: "a".repeat(64), payload: [] })],
  ])("treats %s as a MISS rather than a hit", async (_label, stored) => {
    const { cache } = countingCache();
    const only = candidate();
    await cache.set(
      captureL1Key({
        env: CONTEXT.env,
        engineKey: only.engineKey,
        adapterMajor: adapterMajorOf(only.adapterVersion),
        promptText: only.promptText,
        locale: CONTEXT.locale,
        personaHint: CONTEXT.personaHint,
        ttlSeconds: only.ttlSeconds,
        nowMs: CONTEXT.nowMs,
      }),
      stored,
      { ttlMs: 60_000 },
    );

    // A miss costs a vendor call. A hit against an entry we could not read
    // costs a row that can never be scored — so unreadable must mean miss.
    expect((await probeExactHash(cache, CONTEXT, [only])).size).toBe(0);
  });

  it("round-trips an envelope it wrote itself", () => {
    const parsed = parseL1Envelope(envelope(HASH_A));
    expect(parsed?.contentHash).toBe(HASH_A);
    expect(parsed?.payload).toEqual({ answer: "the shared answer" });
  });

  describe("adapterMajorOf", () => {
    it("reads the major and ignores the rest", () => {
      expect(adapterMajorOf("3.1.0")).toBe(3);
      expect(adapterMajorOf("10.0.2-beta.1")).toBe(10);
    });

    // NaN IS A SHARED BUCKET. String(NaN) is "NaN", so every unparseable
    // version would hash alike and two incompatible adapters would serve each
    // other's answers — the cache-invalidation rule failing precisely where
    // the version is malformed.
    it("throws rather than yielding NaN, which would be one bucket for all bad versions", () => {
      expect(() => adapterMajorOf("v3")).toThrow(/not semantic/u);
      expect(() => adapterMajorOf("")).toThrow(/not semantic/u);
    });

    it("keeps majors apart, so an upgrade invalidates", async () => {
      const { cache } = countingCache();
      const before = candidate({ adapterVersion: "3.1.0" });
      await seed(cache, before, HASH_A);

      const after = await probeExactHash(cache, CONTEXT, [candidate({ adapterVersion: "4.0.0" })]);

      expect(after.size, "a major upgrade may not answer with the old adapter's capture").toBe(0);
    });
  });
});
