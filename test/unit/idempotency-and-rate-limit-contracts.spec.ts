import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_WINDOW_MS,
  idempotencyConflictDetailsSchema,
  idempotencyKeySchema,
  idempotencyStoredSchema,
} from "../../contracts/common/idempotency.schema.js";
import {
  RATE_LIMIT_ROUTE_CLASS_COUNT,
  rateLimitBucketSchema,
  rateLimitConfigSchema,
  rateLimitRouteClassSchema,
} from "../../contracts/common/rate-limit.schema.js";

// STORY-025 T13 — the contract lands before the mechanism. These assertions
// are transcribed from api-specification.md §1 and §12 and from NFR-API-05
// and NFR-API-07, never from the implementation, which does not exist yet.

const HASH = "a".repeat(64);

describe("STORY-025 · the Idempotency-Key contract (§1, NFR-API-07)", () => {
  it("caps the key at the reference's 255 characters", () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(255);
    expect(idempotencyKeySchema.safeParse("k".repeat(255)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse("k".repeat(256)).success).toBe(false);
  });

  it("rejects an empty key — a present-but-blank header is not a key", () => {
    expect(idempotencyKeySchema.safeParse("").success).toBe(false);
  });

  it("expresses the 24-hour replay window in milliseconds (NFR-API-05)", () => {
    expect(IDEMPOTENCY_WINDOW_MS).toBe(86_400_000);
  });

  it("carries hashes in the conflict detail, never the original body", () => {
    const valid = {
      key_hash: HASH,
      original_request_hash: HASH,
      original_recorded_at: "2026-08-25T09:00:00.000Z",
    };
    expect(idempotencyConflictDetailsSchema.safeParse(valid).success).toBe(true);
    // The original request may belong to another session; echoing it back to
    // whoever presents the same key would make the conflict body an oracle.
    expect(
      idempotencyConflictDetailsSchema.safeParse({ ...valid, original_body: { anything: true } }).success,
    ).toBe(false);
  });

  it("rejects a hash that is not a full sha256", () => {
    expect(idempotencyConflictDetailsSchema.safeParse({ key_hash: "abc", original_request_hash: HASH, original_recorded_at: "2026-08-25T09:00:00.000Z" }).success).toBe(false);
  });

  it("distinguishes an in-flight request from a completed one", () => {
    const inFlight = idempotencyStoredSchema.safeParse({
      state: "in_flight",
      request_hash: HASH,
      started_at: "2026-08-25T09:00:00.000Z",
    });
    const completed = idempotencyStoredSchema.safeParse({
      state: "completed",
      request_hash: HASH,
      status_code: 201,
      response_body: { data: { id: "x" }, meta: {} },
      recorded_at: "2026-08-25T09:00:00.000Z",
    });
    expect(inFlight.success).toBe(true);
    expect(completed.success).toBe(true);
    // "no record" and "someone else is running this right now" are different
    // answers; a union that could not tell them apart would execute twice.
    expect(inFlight.success && inFlight.data.state).toBe("in_flight");
  });
});

describe("STORY-025 · the rate-limit configuration contract (§12)", () => {
  it("names exactly the fifteen route classes §12 defines", () => {
    expect(RATE_LIMIT_ROUTE_CLASS_COUNT).toBe(15);
    expect(rateLimitRouteClassSchema.options).toHaveLength(15);
  });

  it("requires a rolling bucket to carry its window and a utc_day bucket not to", () => {
    expect(
      rateLimitBucketSchema.safeParse({ scope: "user", limit: 10, window: "rolling", window_ms: 60_000 }).success,
    ).toBe(true);
    expect(rateLimitBucketSchema.safeParse({ scope: "user", limit: 10, window: "rolling" }).success).toBe(false);
    expect(rateLimitBucketSchema.safeParse({ scope: "user", limit: 3, window: "utc_day" }).success).toBe(true);
    // A UTC-day bucket's boundary IS the calendar. Carrying a window would
    // invite an implementation to treat it as a rolling 24 hours, and the
    // "come back tomorrow" remediation would then be a lie.
    expect(
      rateLimitBucketSchema.safeParse({ scope: "user", limit: 3, window: "utc_day", window_ms: 86_400_000 }).success,
    ).toBe(false);
  });

  it("defaults hard_cap to false, so a cap is opt-in and deliberate", () => {
    const parsed = rateLimitBucketSchema.parse({ scope: "user", limit: 10, window: "rolling", window_ms: 60_000 });
    expect(parsed.hard_cap).toBe(false);
  });

  it("refuses a configuration missing any route class — a class with no limit is a route with no limit", () => {
    const twelve = rateLimitRouteClassSchema.options.slice(0, 12).map((routeClass) => ({
      route_class: routeClass,
      buckets: [{ scope: "user" as const, limit: 1, window: "rolling" as const, window_ms: 60_000 }],
      burst: 1,
    }));
    expect(rateLimitConfigSchema.safeParse(twelve).success).toBe(false);
  });

  it("refuses a configuration that lists one class twice instead of another", () => {
    const duplicated = rateLimitRouteClassSchema.options.map((routeClass, index) => ({
      route_class: index === 12 ? rateLimitRouteClassSchema.options[0]! : routeClass,
      buckets: [{ scope: "user" as const, limit: 1, window: "rolling" as const, window_ms: 60_000 }],
      burst: 1,
    }));
    expect(rateLimitConfigSchema.safeParse(duplicated).success).toBe(false);
  });

  it("refuses a route class with no bucket at all", () => {
    const empty = rateLimitRouteClassSchema.options.map((routeClass) => ({
      route_class: routeClass,
      buckets: [],
      burst: 1,
    }));
    expect(rateLimitConfigSchema.safeParse(empty).success).toBe(false);
  });
});
