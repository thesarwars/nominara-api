import { describe, expect, it } from "vitest";
import { activeLinkLimit, generateShareSecret, hashShareSecret } from "./share-tokens.service.js";

describe("STORY-098 · share-token secret helpers", () => {
  it("STORY-098 scenario 1 · a secret is 32 CSPRNG bytes as 43 base64url characters, never repeated", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const s = generateShareSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
  });

  it("STORY-098 scenario 1 · the stored hash is the 32-byte SHA-256 of the secret, and differs per secret", () => {
    const a = hashShareSecret("a".repeat(43));
    expect(a).toHaveLength(32);
    expect(a.equals(hashShareSecret("a".repeat(43)))).toBe(true);
    expect(a.equals(hashShareSecret("b".repeat(43)))).toBe(false);
  });

  it("STORY-098 · share_links.enabled resolves to an active-link ceiling; unrecognised values fail closed at 0", () => {
    expect(activeLinkLimit("10_active")).toBe(10);
    expect(activeLinkLimit("50_active")).toBe(50);
    expect(activeLinkLimit("unlimited")).toBeNull();
    expect(activeLinkLimit(true)).toBeNull();
    expect(activeLinkLimit(false)).toBe(0);
    expect(activeLinkLimit(null)).toBe(0);
    expect(activeLinkLimit(0)).toBe(0);
    expect(activeLinkLimit("surprise")).toBe(0);
    expect(activeLinkLimit(7)).toBe(7);
  });
});
