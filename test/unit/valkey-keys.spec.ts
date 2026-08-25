import { describe, expect, it } from "vitest";
import {
  globalKey,
  hashIdempotencyKey,
  idempotencyFingerprint,
  idempotencyRecordKey,
  rateLimitConfigKey,
  rateLimitCounterKey,
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
    const fingerprint = idempotencyFingerprint({
      key: "retry-1",
      userId: "user-1",
      route: "POST /v1/things",
      body: '{"a":1}',
    });
    expect(idempotencyRecordKey("test", WS_A, fingerprint)).not.toBe(idempotencyRecordKey("test", WS_B, fingerprint));
  });

  it("separates two workspaces' rate-limit counters, including IP-scoped ones", () => {
    // A shared egress address — an office, a VPN, a CI runner — must not let
    // one tenant exhaust another's capacity. That is a denial of service
    // between tenants, not an abuse control.
    expect(rateLimitCounterKey("test", WS_A, "writes", "ip", "203.0.113.7")).not.toBe(
      rateLimitCounterKey("test", WS_B, "writes", "ip", "203.0.113.7"),
    );
  });

  it("puts the workspace immediately after the environment, before anything else", () => {
    expect(rateLimitCounterKey("test", WS_A, "writes", "user", "u1")).toBe(
      `test:${WS_A}:ratelimit:writes:user:u1`,
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
    ["a part carrying a separator", () => rateLimitCounterKey("test", WS_A, "writes", "user", "u:1")],
  ])("refuses %s — it would shift every segment after it", (_label, build) => {
    expect(build).toThrow(/must not contain/);
  });
});

describe("STORY-025 · the idempotency fingerprint", () => {
  const base = { key: "retry-1", userId: "user-1", route: "POST /v1/things", body: '{"a":1}' };

  it("is a full sha256", () => {
    expect(idempotencyFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for an identical request — that is what makes a replay a replay", () => {
    expect(idempotencyFingerprint(base)).toBe(idempotencyFingerprint({ ...base }));
  });

  it.each([
    ["a different key", { key: "retry-2" }],
    ["a different user", { userId: "user-2" }],
    ["a different route", { route: "POST /v1/others" }],
    ["a different body", { body: '{"a":2}' }],
  ])("changes with %s", (_label, patch) => {
    expect(idempotencyFingerprint({ ...base, ...patch })).not.toBe(idempotencyFingerprint(base));
  });

  // Concatenation without a delimiter would make ("ab","c") and ("a","bc")
  // hash identically, so two different requests would share a record.
  it("cannot be collided by shifting a character between fields", () => {
    expect(idempotencyFingerprint({ ...base, key: "retry", userId: "-1user-1" })).not.toBe(
      idempotencyFingerprint({ ...base, key: "retry-1", userId: "user-1" }),
    );
  });

  it("hashes the raw key for the conflict detail, so a 409 never echoes it", () => {
    expect(hashIdempotencyKey("retry-1")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIdempotencyKey("retry-1")).not.toContain("retry");
  });
});
