import { describe, expect, it } from "vitest";
import { REDACTED, redactState } from "./redact.js";

// STORY-020 scenario 7 + security-and-tenancy.md NFR-SEC-11: "Secrets never
// appear in ... audit state fields. Enforced by a redaction transport with a
// deny-list plus a high-entropy-string detector." Pure, no I/O.

describe("STORY-020 · redactState", () => {
  it("scenario 7 — redacts a field whose KEY name is secret-shaped, regardless of value", () => {
    const result = redactState({ username: "alice", password: "hunter2" });
    expect(result).toEqual({ username: "alice", password: REDACTED });
  });

  it("redacts common secret-shaped key variants (token, api_key, authorization, secret, credential)", () => {
    const input = {
      access_token: "abc",
      apiKey: "abc",
      Authorization: "Bearer abc",
      client_secret: "abc",
      credential: "abc",
    };
    const result = redactState(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(result[key]).toBe(REDACTED);
    }
  });

  it("redacts nested objects and arrays, not just the top level", () => {
    const result = redactState({
      user: { profile: { password: "hunter2" } },
      items: [{ token: "abc" }, { name: "ok" }],
    });
    expect(result).toEqual({
      user: { profile: { password: REDACTED } },
      items: [{ token: REDACTED }, { name: "ok" }],
    });
  });

  it("redacts a high-entropy string value even under an innocuous key name", () => {
    const highEntropy = "aZ9!kL2mQw7Tn1Xy8Rp3Bf6Hj0Cs4Vd5";
    const result = redactState({ sessionId: highEntropy }) as Record<string, unknown>;
    expect(result.sessionId).toBe(REDACTED);
  });

  // Decision 111(a): a canonical UUID is an identifier, not a secret.
  const UUID_A = "0192f3c4-7b1e-7c3a-9d2e-5f8a1b6c4d70";
  it("decision 111(a): a canonical UUID under an innocuous key is kept (nested and in arrays)", () => {
    expect(redactState({ request_id: UUID_A, nested: { ids: [UUID_A] } })).toEqual({ request_id: UUID_A, nested: { ids: [UUID_A] } });
  });

  it("decision 111(a): a UUID under a secret-named key is still masked", () => {
    expect(redactState({ refresh_token: UUID_A, password: UUID_A })).toEqual({ refresh_token: REDACTED, password: REDACTED });
  });

  it("decision 111(a): a 36-char random non-UUID is still masked", () => {
    const random = "aZ9kL2mQw7Tn1Xy8Rp3Bf6Hj0Cs4Vd5Gh7Jk";
    expect(random).toHaveLength(36);
    expect((redactState({ note: random }) as Record<string, unknown>).note).toBe(REDACTED);
    // right shape of dashes but non-hex characters is not a UUID
    const fake = "zZ9kL2mQ-w7Tn-1Xy8-Rp3B-f6Hj0Cs4Vd5G";
    expect((redactState({ note: fake }) as Record<string, unknown>).note).toBe(REDACTED);
  });

  it("decision 111(a): uppercase canonical UUIDs are kept; braced or urn-prefixed forms are not canonical and stay masked", () => {
    const upper = UUID_A.toUpperCase();
    expect((redactState({ id: upper }) as Record<string, unknown>).id).toBe(upper);
    expect((redactState({ id: `{${UUID_A}}` }) as Record<string, unknown>).id).toBe(REDACTED);
    expect((redactState({ id: `urn:uuid:${UUID_A}` }) as Record<string, unknown>).id).toBe(REDACTED);
  });

  it("leaves ordinary short/low-entropy string values under innocuous keys untouched", () => {
    const result = redactState({ status: "active", city: "Dhaka", note: "please review this project" });
    expect(result).toEqual({ status: "active", city: "Dhaka", note: "please review this project" });
  });

  it("passes null, undefined, numbers and booleans through unchanged", () => {
    expect(redactState(null)).toBeNull();
    expect(redactState(undefined)).toBeUndefined();
    expect(redactState(42)).toBe(42);
    expect(redactState(true)).toBe(true);
  });

  it("does not mutate the input value", () => {
    const input = { password: "hunter2" };
    redactState(input);
    expect(input.password).toBe("hunter2");
  });
});
