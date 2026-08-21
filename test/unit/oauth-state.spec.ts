import { describe, expect, it, vi } from "vitest";

// STORY-015 — this test SPECIFIES src/lib/auth/oauth-state.ts (it does not
// exist yet; Task 4). Contract:
//   signState(requestId, secret)   -> opaque, tamper-evident state string
//   verifyState(token, secret)     -> requestId | null (null on any failure,
//                                      never throws — a callback with a bad
//                                      state must fail the same neutral way
//                                      as any other refusal)
//   newBindingValue()              -> CSPRNG string, >= 32 bytes decoded
//   hashBinding(value)             -> deterministic digest of the binding
//                                      value, stored server-side as
//                                      oauth_authorization_requests.binding_hash
//
// Dangerous area: this file is state-signing/session-binding for an
// authentication flow — second-engineer review required alongside
// oauth.service.ts once that lands.

const SECRET_A = "test-oauth-state-secret-a";
const SECRET_B = "test-oauth-state-secret-b";
const REQUEST_ID = "0192f1a0-0000-7000-8000-000000000042";

describe("STORY-015 · oauth state signing and session binding", () => {
  it("signState/verifyState round-trip: a token signed for a request id verifies back to that same id", async () => {
    const { signState, verifyState } = await import("../../src/lib/auth/oauth-state.js");
    const token = signState(REQUEST_ID, SECRET_A);
    expect(verifyState(token, SECRET_A)).toBe(REQUEST_ID);
  });

  it("a tampered state token fails verification", async () => {
    const { signState, verifyState } = await import("../../src/lib/auth/oauth-state.js");
    const token = signState(REQUEST_ID, SECRET_A);
    // Flip one character in the middle of the token without changing its
    // length, so a length-based fast-reject can never be the reason this
    // fails — the signature check itself must be what catches it.
    const midpoint = Math.floor(token.length / 2);
    const flipped = token[midpoint] === "a" ? "b" : "a";
    const tampered = token.slice(0, midpoint) + flipped + token.slice(midpoint + 1);
    expect(verifyState(tampered, SECRET_A)).toBeNull();
  });

  it("a state signed with a different secret fails verification", async () => {
    const { signState, verifyState } = await import("../../src/lib/auth/oauth-state.js");
    const token = signState(REQUEST_ID, SECRET_A);
    expect(verifyState(token, SECRET_B)).toBeNull();
  });

  it("a structurally malformed token is refused, not thrown", async () => {
    const { verifyState } = await import("../../src/lib/auth/oauth-state.js");
    expect(verifyState("not-a-real-state-token", SECRET_A)).toBeNull();
    expect(verifyState("", SECRET_A)).toBeNull();
  });

  it("verification uses a timing-safe comparison, not string/buffer equality", async () => {
    vi.resetModules();
    const actualCrypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    const timingSafeEqualSpy = vi.fn(actualCrypto.timingSafeEqual);
    vi.doMock("node:crypto", () => ({ ...actualCrypto, timingSafeEqual: timingSafeEqualSpy }));

    const { signState, verifyState } = await import("../../src/lib/auth/oauth-state.js");
    const token = signState(REQUEST_ID, SECRET_A);

    timingSafeEqualSpy.mockClear();
    const result = verifyState(token, SECRET_A);

    expect(result).toBe(REQUEST_ID);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
    const [a, b] = timingSafeEqualSpy.mock.calls[0]!;
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(Buffer.isBuffer(b)).toBe(true);

    vi.doUnmock("node:crypto");
    vi.resetModules();
  });

  it("newBindingValue produces CSPRNG output of at least 32 bytes, different on every call", async () => {
    const { newBindingValue } = await import("../../src/lib/auth/oauth-state.js");
    const first = newBindingValue();
    const second = newBindingValue();
    expect(typeof first).toBe("string");
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(second, "base64url").length).toBeGreaterThanOrEqual(32);
  });

  it("hashBinding is deterministic and distinguishes distinct inputs", async () => {
    const { newBindingValue, hashBinding } = await import("../../src/lib/auth/oauth-state.js");
    const value = newBindingValue();
    const first = hashBinding(value);
    const second = hashBinding(value);
    expect(Buffer.isBuffer(first)).toBe(true);
    expect(first.equals(second)).toBe(true);
    expect(hashBinding(newBindingValue()).equals(first)).toBe(false);
  });
});
