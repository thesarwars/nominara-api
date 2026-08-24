import { describe, expect, it } from "vitest";
import { hash, verify, verifyDecoy } from "../../src/lib/crypto/argon2id.js";

describe("STORY-016 · argon2id hash/verify", () => {
  it("hash() produces a string starting with $argon2id$", async () => {
    const encoded = await hash("12345678");
    expect(encoded.startsWith("$argon2id$")).toBe(true);
  });

  it("verify() accepts the correct plaintext", async () => {
    const encoded = await hash("12345678");
    expect(await verify("12345678", encoded)).toBe(true);
  });

  it("verify() rejects a wrong plaintext", async () => {
    const encoded = await hash("12345678");
    expect(await verify("87654321", encoded)).toBe(false);
  });

  it("two hashes of the same plaintext differ (per-call random salt)", async () => {
    const a = await hash("12345678");
    const b = await hash("12345678");
    expect(a).not.toBe(b);
  });
});

describe("STORY-016 · verifyDecoy", () => {
  it("always returns false regardless of input", async () => {
    expect(await verifyDecoy("00000000")).toBe(false);
    expect(await verifyDecoy("anything-at-all")).toBe(false);
    expect(await verifyDecoy("")).toBe(false);
  });

  it("costs the same order of magnitude as a real verify() call, not a no-op", async () => {
    // ESM module namespaces are non-configurable (vitest cannot vi.spyOn an
    // export of @node-rs/argon2 directly — "Module namespace is not
    // configurable in ESM"), so the structural check this scenario calls
    // for is done by cost comparison instead: a real verify() against a
    // real hash, and verifyDecoy(), must both cost real Argon2id work
    // (m=64MiB, t=3) and neither may be an order of magnitude cheaper than
    // the other — a no-op decoy would be sub-millisecond next to a ~tens-
    // of-milliseconds real verify.
    const encoded = await hash("12345678");

    const realStart = performance.now();
    await verify("12345678", encoded);
    const realElapsedMs = performance.now() - realStart;

    const decoyStart = performance.now();
    await verifyDecoy("does-not-matter");
    const decoyElapsedMs = performance.now() - decoyStart;

    expect(realElapsedMs).toBeGreaterThan(5);
    expect(decoyElapsedMs).toBeGreaterThan(5);
    expect(decoyElapsedMs).toBeGreaterThan(realElapsedMs / 10);
  });
});
