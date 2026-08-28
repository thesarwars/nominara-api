import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureL1Key, l1TimeBucket, type L1KeyInput } from "../../src/lib/capture/l1-cache-key.js";

// STORY-032 — tracking-engine.md §6's L1 key.
//
// *** THIS KEY IS DELIBERATELY CROSS-TENANT, AND THAT IS THE COST LEVER. ***
//
// §6: "all tenants asking the same question in the same window share one
// capture — the single largest cost lever, and the reason the key is built
// from prompt TEXT rather than prompt ID." An L1 entry holds an engine's
// public answer to a public question. Entity matching, scoring and storage
// all happen per tenant AFTER the read, so nothing tenant-derived may enter
// this key.
//
// Two opposite failures, and a test for each, because they are equally bad
// and neither is visible from the other's direction:
//
//   Leak — a tenant identifier in the key would put tenant-derived data in a
//   GLOBAL namespace. ISO-13 excepts `global:capture:` from its tenant-
//   scoping rule precisely because this value carries none.
//
//   Fragmentation — a key that varies per workspace when it should not
//   silently destroys the sharing. Nothing fails; the bill simply grows, and
//   the suppression metric reports a rate nobody can explain.
const BASE: L1KeyInput = {
  engineKey: "perplexity",
  adapterMajor: 3,
  promptText: "best crm for small business",
  locale: "en-US",
  personaHint: null,
  ttlSeconds: 86_400,
  nowMs: 1_700_000_000_000,
};

describe("STORY-032 · the L1 exact-hash key", () => {
  it("is stable for identical inputs", () => {
    expect(captureL1Key(BASE)).toBe(captureL1Key({ ...BASE }));
  });

  // THE COST LEVER, asserted the only way that actually holds.
  //
  // My first attempt here read `Object.keys(BASE)` and asserted none looked
  // tenant-ish. It was vacuous: adding an OPTIONAL `workspaceId` to the input
  // type and hashing it left the fixture untouched, so the test passed while
  // the key had gained a tenant input — both failures at once, undetected.
  // Caught by mutating the source, which is the only thing that would have.
  //
  // So the digest is recomputed here INDEPENDENTLY from §6's formula. Any
  // extra input, tenant-derived or not, changes the hash and fails this. The
  // duplication is deliberate: a test that derives its expectation from the
  // implementation cannot detect a change in the implementation.
  it("hashes exactly §6's six inputs and nothing else — no tenant input can hide in it", () => {
    const bucket = Math.floor(BASE.nowMs / (BASE.ttlSeconds * 1_000));
    const parts = ["perplexity", "3", "best crm for small business", "en-US", "", String(bucket)];
    const material = parts.map((part) => `${String(part.length)}:${part}`).join("|");
    const expected = createHash("sha256").update(material).digest("hex");

    expect(
      captureL1Key(BASE),
      "an input this test does not know about would change the digest — including a workspace id, which would " +
        "both leak tenant-derived data into a global namespace and silently destroy the cross-tenant sharing",
    ).toBe(`global:capture:sim:v3:${expected}`);
  });

  it("carries the documented global prefix, so ISO-13's exception applies to it and nothing else", () => {
    expect(captureL1Key(BASE)).toMatch(/^global:capture:sim:v3:[0-9a-f]{64}$/);
  });

  // Each input that MUST change the key. An adapter upgrade invalidating the
  // cache is §6's own example; the others are the question itself.
  it.each([
    ["engineKey", { engineKey: "chatgpt" }],
    ["adapterMajor", { adapterMajor: 4 }],
    ["promptText", { promptText: "best crm for enterprise" }],
    ["locale", { locale: "en-GB" }],
    ["personaHint", { personaHint: "procurement lead" }],
  ] as const)("changes when %s changes", (_name, patch) => {
    expect(captureL1Key({ ...BASE, ...patch })).not.toBe(captureL1Key(BASE));
  });

  // The time bucket is what makes the sharing window finite. Two calls inside
  // one bucket share; the next bucket does not.
  it("shares within a TTL bucket and not across one", () => {
    const withinBucket = captureL1Key({ ...BASE, nowMs: BASE.nowMs + 1_000 });
    const nextBucket = captureL1Key({ ...BASE, nowMs: BASE.nowMs + BASE.ttlSeconds * 1_000 });

    expect(withinBucket, "a second request in the same window must hit the same entry").toBe(captureL1Key(BASE));
    expect(nextBucket, "and a later window must not").not.toBe(captureL1Key(BASE));
  });

  // Per §6 the bucket is floored by the ENGINE's own TTL, so a volatile
  // engine shares over a shorter window than a stable one. A single shared
  // TTL would either over-cache the volatile engines or under-cache the rest.
  it("floors the bucket by the engine's own TTL", () => {
    expect(l1TimeBucket(1_700_000_500_000, 3_600)).toBe(Math.floor(1_700_000_500_000 / 3_600_000));
    expect(l1TimeBucket(1_700_000_500_000, 86_400)).not.toBe(l1TimeBucket(1_700_000_500_000, 3_600));
  });

  // Prompt TEXT, not prompt ID — two tenants who independently wrote the same
  // question share, which is exactly what §6 asks for. Normalised so trivial
  // differences do not fragment the cache.
  it("shares across trivial differences in how the same question was typed", () => {
    expect(captureL1Key({ ...BASE, promptText: "  Best CRM For Small Business  " })).toBe(captureL1Key(BASE));
  });

  it("refuses a non-positive TTL rather than dividing by zero into one eternal bucket", () => {
    expect(() => captureL1Key({ ...BASE, ttlSeconds: 0 })).toThrow(/ttl/i);
  });
});
