import { describe, expect, it } from "vitest";
import {
  globalKey,
  hashIdempotencyKey,
  idempotencyRecordKey,
  idempotencyScopeFingerprint,
  rateLimitConfigKey,
  rateLimitCounterKey,
  requestBodyHash,
  tenantKey,
} from "../../src/lib/cache/valkey-keys.js";

// STORY-025 T14 — Valkey has no row-level security, so the KEY is the tenant
// boundary. These assertions are about that boundary, not about string
// formatting: every one of them fails if a segment goes missing, and a missing
// segment is a cross-tenant read with nothing behind it.

const WS_A = "0192f1a0-0000-7000-8000-00000000000a";
const WS_B = "0192f1a0-0000-7000-8000-00000000000b";

describe("STORY-025 · the environment segment", () => {
  it("prefixes every key, global and tenant alike", () => {
    expect(globalKey("production", "ratelimit", "config").startsWith("production:")).toBe(true);
    expect(tenantKey("production", WS_A, "idem", "abc").startsWith("production:")).toBe(true);
  });

  it("keeps two environments pointed at one cache from reading each other", () => {
    expect(idempotencyRecordKey("staging", WS_A, "abc")).not.toBe(idempotencyRecordKey("production", WS_A, "abc"));
  });
});

describe("STORY-025 · the workspace segment", () => {
  it("separates two workspaces presenting the identical idempotency fingerprint", () => {
    // NFR-API-06, and test row 11: same key, same body, two tenants. The
    // second must not be able to reach the first's cached envelope.
    const fingerprint = idempotencyScopeFingerprint({
      key: "retry-1",
      userId: "user-1",
      route: "POST /v1/things",
    });
    expect(idempotencyRecordKey("test", WS_A, fingerprint)).not.toBe(idempotencyRecordKey("test", WS_B, fingerprint));
  });

  it("separates two workspaces' rate-limit counters, including IP-scoped ones", () => {
    // A shared egress address — an office, a VPN, a CI runner — must not let
    // one tenant exhaust another's capacity. That is a denial of service
    // between tenants, not an abuse control.
    expect(rateLimitCounterKey("test", WS_A, "writes", "ip", "r60000", "203.0.113.7")).not.toBe(
      rateLimitCounterKey("test", WS_B, "writes", "ip", "r60000", "203.0.113.7"),
    );
  });

  it("puts the workspace immediately after the environment, before anything else", () => {
    expect(rateLimitCounterKey("test", WS_A, "writes", "user", "r60000", "u1")).toBe(
      `test:${WS_A}:ratelimit:writes:user:r60000:u1`,
    );
  });

  it("keeps two buckets of the SAME scope apart by their window", () => {
    // §12 gives capture-backed tools a user bucket at 5/min AND one at 40/day.
    // Keyed on scope alone they collide, share one token state, and the daily
    // allowance stops existing. Found by the dangerous-area audit.
    expect(rateLimitCounterKey("test", WS_A, "capture_backed_tools", "user", "r60000", "u1")).not.toBe(
      rateLimitCounterKey("test", WS_A, "capture_backed_tools", "user", "r86400000", "u1"),
    );
  });

  it("marks platform-wide data `global`, so it is never mistaken for a tenant's", () => {
    expect(rateLimitConfigKey("test")).toBe("test:global:ratelimit:config");
  });
});

describe("STORY-025 · segment integrity", () => {
  it.each([
    ["an empty environment", () => tenantKey("", WS_A, "idem")],
    ["an empty workspace", () => tenantKey("test", "", "idem")],
    ["an empty part", () => tenantKey("test", WS_A, "")],
  ])("refuses %s — an empty segment collapses the boundary", (_label, build) => {
    expect(build).toThrow(/must not be empty/);
  });

  it.each([
    ["a workspace carrying a separator", () => tenantKey("test", "a:global", "idem")],
    ["an environment carrying a separator", () => tenantKey("te:st", WS_A, "idem")],
    ["a part carrying a separator", () => rateLimitCounterKey("test", WS_A, "writes", "user", "r60000", "u:1")],
  ])("refuses %s — it would shift every segment after it", (_label, build) => {
    expect(build).toThrow(/must not contain/);
  });
});

describe("STORY-025 · the idempotency fingerprint", () => {
  const base = { key: "retry-1", userId: "user-1", route: "POST /v1/things" };

  it("is a full sha256", () => {
    expect(idempotencyScopeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for an identical scope — that is what makes a replay find its record", () => {
    expect(idempotencyScopeFingerprint(base)).toBe(idempotencyScopeFingerprint({ ...base }));
  });

  it.each([
    ["a different key", { key: "retry-2" }],
    ["a different user", { userId: "user-2" }],
    ["a different route", { route: "POST /v1/others" }],
  ])("changes with %s", (_label, patch) => {
    expect(idempotencyScopeFingerprint({ ...base, ...patch })).not.toBe(idempotencyScopeFingerprint(base));
  });

  // THE load-bearing property. §1 says identical key + DIFFERENT body is a
  // 409. If the body reached this fingerprint, the two bodies would land on
  // two records, both would be claimed, and both would execute — the conflict
  // would be structurally unreachable and the double effect would be silent.
  it("does NOT vary with the body — the body is compared inside the record, not used to locate it", () => {
    const withOneBody = idempotencyScopeFingerprint(base);
    expect(requestBodyHash('{"a":1}')).not.toBe(requestBodyHash('{"a":2}'));
    expect(idempotencyScopeFingerprint(base)).toBe(withOneBody);
  });

  // Concatenation without a delimiter would make ("ab","c") and ("a","bc")
  // hash identically, so two different requests would share a record.
  it("cannot be collided by shifting a character between fields", () => {
    expect(idempotencyScopeFingerprint({ ...base, key: "retry", userId: "-1user-1" })).not.toBe(
      idempotencyScopeFingerprint({ ...base, key: "retry-1", userId: "user-1" }),
    );
  });

  it("hashes the raw key for the conflict detail, so a 409 never echoes it", () => {
    expect(hashIdempotencyKey("retry-1")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIdempotencyKey("retry-1")).not.toContain("retry");
  });
});
