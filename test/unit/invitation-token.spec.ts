import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INVITATION_TOKEN_BYTES,
  INVITATION_TTL_MS,
  generateInvitationToken,
  hashInvitationToken,
} from "../../src/lib/auth/invitation-token.js";

describe("STORY-021-E-6 · invitation token", () => {
  it("generates a 256-bit (32-byte) random token, distinct on every call", () => {
    expect(INVITATION_TOKEN_BYTES).toBe(32);
    const first = generateInvitationToken();
    const second = generateInvitationToken();
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url").length).toBe(32);
  });

  it("the expiry constant is exactly 7 days", () => {
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("hashInvitationToken returns a raw sha256 digest Buffer, not a hex/base64 string", () => {
    const raw = generateInvitationToken();
    const hash = hashInvitationToken(raw);
    expect(Buffer.isBuffer(hash)).toBe(true);
    expect(hash.length).toBe(32);
    expect(hash.equals(createHash("sha256").update(raw).digest())).toBe(true);
  });

  it("hashing is deterministic and different tokens hash to different digests", () => {
    const raw = generateInvitationToken();
    expect(hashInvitationToken(raw).equals(hashInvitationToken(raw))).toBe(true);
    expect(hashInvitationToken(raw).equals(hashInvitationToken(generateInvitationToken()))).toBe(false);
  });
});
