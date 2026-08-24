import { describe, expect, it } from "vitest";
import { generateOtpCode, hashEmailKey, normalizeEmail } from "../../src/lib/auth/email-otp.js";

describe("STORY-016 · generateOtpCode", () => {
  it("returns exactly 8 digits every time across many draws", () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{8}$/);
    }
  });

  it("every leading digit 0-9 appears across 10,000 draws (no truncation/padding bug drops leading zeros)", () => {
    const leadingDigitsSeen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      leadingDigitsSeen.add(generateOtpCode()[0] as string);
    }
    for (let digit = 0; digit <= 9; digit++) {
      expect(leadingDigitsSeen).toContain(String(digit));
    }
  });
});

describe("STORY-016 · normalizeEmail", () => {
  it("is idempotent", () => {
    const once = normalizeEmail("  User@Example.COM  ");
    expect(normalizeEmail(once)).toBe(once);
  });

  it("is case-insensitive", () => {
    expect(normalizeEmail("User@Example.com")).toBe(normalizeEmail("user@example.com"));
  });

  it("is whitespace-insensitive", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe(normalizeEmail("user@example.com"));
  });
});

describe("STORY-016 · hashEmailKey", () => {
  it("is stable for the same normalized email and pepper", () => {
    const a = hashEmailKey("user@example.com", "pepper-1");
    const b = hashEmailKey("user@example.com", "pepper-1");
    expect(a.equals(b)).toBe(true);
  });

  it("differs when the pepper differs", () => {
    const a = hashEmailKey("user@example.com", "pepper-1");
    const b = hashEmailKey("user@example.com", "pepper-2");
    expect(a.equals(b)).toBe(false);
  });
});
