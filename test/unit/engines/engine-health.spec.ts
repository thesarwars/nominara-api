import { describe, expect, it } from "vitest";
import { HEALTH_BUCKET_MS, healthBucketStart, percentile } from "../../../src/lib/engines/engine-health.js";

// STORY-031 Phase E — EC-06 "engine_health 5-minute buckets tracking
// attempts, successes, blocks, timeouts, and rate limits with p50/p95
// latency". 5 minutes is the exact reference constant (not an
// interpolation). Bucketing is floor-based, half-open [start, start+5min):
// a timestamp exactly ON a boundary belongs to the bucket STARTING there,
// never the one that just ended.

describe("STORY-031 · healthBucketStart — 5-minute UTC floor bucketing", () => {
  it("the bucket width is exactly 5 minutes", () => {
    expect(HEALTH_BUCKET_MS).toBe(5 * 60 * 1000);
  });

  it("a timestamp mid-bucket floors down to that bucket's start", () => {
    const start = Date.UTC(2026, 0, 1, 10, 5, 0, 0);
    const midBucket = start + 90_000; // 10:06:30
    expect(healthBucketStart(midBucket).getTime()).toBe(start);
  });

  it("a timestamp EXACTLY on a 5-minute boundary lands in the bucket starting AT that instant — never the previous one", () => {
    const boundary = Date.UTC(2026, 0, 1, 10, 5, 0, 0);
    expect(healthBucketStart(boundary).getTime()).toBe(boundary);
  });

  it("one millisecond before a boundary still belongs to the PREVIOUS bucket", () => {
    const boundary = Date.UTC(2026, 0, 1, 10, 5, 0, 0);
    const previousStart = boundary - HEALTH_BUCKET_MS;
    expect(healthBucketStart(boundary - 1).getTime()).toBe(previousStart);
  });

  it("one millisecond after a boundary still belongs to the SAME (new) bucket, not a third one", () => {
    const boundary = Date.UTC(2026, 0, 1, 10, 5, 0, 0);
    expect(healthBucketStart(boundary + 1).getTime()).toBe(boundary);
  });
});

describe("STORY-031 · percentile — hand-rolled, no library", () => {
  it("an empty reservoir returns null for both p50 and p95 — never 0 (0 and absent must be distinguishable)", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it("a single-sample reservoir returns that sample for any percentile", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("p50 of [1,2,3,4,5,6,7,8,9,10] (sorted) is 5 under the nearest-rank method", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
  });

  it("p95 of 100 sorted samples [1..100] is 95 under the nearest-rank method", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 95)).toBe(95);
  });

  it("requires the input to already be sorted ascending — it does not sort internally", () => {
    // Documents the contract via an intentionally-unsorted input: the
    // caller (engine-health.service.ts) is responsible for sorting before
    // calling this — this pure function trusts its input.
    const unsorted = [10, 1, 5];
    expect(percentile(unsorted, 50)).toBe(1); // NOT the true median (5) — proves no internal sort
  });
});
