// STORY-031 Phase E — EC-06: "engine_health 5-minute buckets tracking
// attempts, successes, blocks, timeouts, and rate limits with p50/p95
// latency." 5 minutes is the exact reference constant. Pure functions only
// — no I/O, no clock (callers supply `atMs`) — the Postgres upsert lives in
// src/modules/health/engine-health.service.ts.

/** EC-06 — the exact bucket width. */
export const HEALTH_BUCKET_MS = 5 * 60 * 1000;

/** Floor-based, half-open bucketing [start, start+HEALTH_BUCKET_MS): a timestamp exactly ON a boundary belongs to the bucket STARTING there, never the one that just ended. */
export function healthBucketStart(atMs: number): Date {
  return new Date(Math.floor(atMs / HEALTH_BUCKET_MS) * HEALTH_BUCKET_MS);
}

/**
 * Hand-rolled nearest-rank percentile (no library, per this story's hard
 * constraints). `sortedAscending` MUST already be sorted — this function
 * trusts its input and never sorts internally. An empty reservoir returns
 * `null`, never `0` — 0ms and "no samples yet" must stay distinguishable
 * everywhere a metric can be absent.
 */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index]!;
}
