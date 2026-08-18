import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenError,
  importEd25519PrivateKeyFromDer,
  importEd25519PublicKeyFromDer,
  signAccessToken,
  verifyAccessToken,
} from "../../src/lib/auth/access-token.js";

// STORY-014 (fixed post-review, KAD-11) — `jose`'s SignJWT/jwtVerify own the
// actual EdDSA signing/verification; this module only owns encode/decode of
// the AccessTokenClaims contract shape and the accept/reject decision. Both
// are Promise-returning (jose is WebCrypto-based, inherently async).

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";

describe("STORY-014 · access token sign/verify", () => {
  const privateKey = importEd25519PrivateKeyFromDer(PRIVATE_KEY_DER);
  const publicKey = importEd25519PublicKeyFromDer(PUBLIC_KEY_DER);

  it("round-trips sub/ws/role/scope/ent_v exactly, all null on a fresh passkey token", async () => {
    const { token, claims } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null },
      privateKey,
    );

    const verified = await verifyAccessToken(token, publicKey);
    expect(verified).toEqual(claims);
    expect(verified.ws).toBeNull();
    expect(verified.role).toBeNull();
    expect(verified.scope).toBeNull();
    expect(verified.ent_v).toBeNull();
  });

  it("mints a fresh, distinct sid and jti on every call", async () => {
    const first = await signAccessToken({ sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null }, privateKey);
    const second = await signAccessToken({ sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null }, privateKey);

    expect(first.claims.sid).not.toBe(second.claims.sid);
    expect(first.claims.jti).not.toBe(second.claims.jti);
    expect(first.claims.sid).not.toBe(first.claims.jti);
  });

  it("TTL is exactly 15 minutes (900 seconds), not a plausible neighbour", async () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { claims } = await signAccessToken({ sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null }, privateKey, now);
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const { token } = await signAccessToken({ sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null }, privateKey);
    const [header, payload, signature] = token.split(".");
    const tamperedClaims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    tamperedClaims.sub = "0192f1a0-0000-7000-8000-000000000099";
    const tamperedPayload = Buffer.from(JSON.stringify(tamperedClaims)).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;

    await expect(verifyAccessToken(tampered, publicKey)).rejects.toThrow(AccessTokenError);
  });

  it("rejects an expired token", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    const { token } = await signAccessToken({ sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null }, privateKey, past);

    await expect(verifyAccessToken(token, publicKey, new Date("2026-01-01T00:00:00.000Z"))).rejects.toThrow(/expired/);
  });

  it("rejects a malformed token (wrong segment count)", async () => {
    await expect(verifyAccessToken("not-a-jwt", publicKey)).rejects.toThrow(AccessTokenError);
  });

  it("rejects a token signed by an unrelated keypair", async () => {
    const other = generateKeyPairSync("ed25519");
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null },
      other.privateKey,
    );

    await expect(verifyAccessToken(token, publicKey)).rejects.toThrow(AccessTokenError);
  });
});
