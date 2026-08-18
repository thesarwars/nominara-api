import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenError,
  importEd25519PrivateKeyFromDer,
  importEd25519PublicKeyFromDer,
  signAccessToken,
  verifyAccessToken,
  type KeyResolver,
} from "../../src/lib/auth/access-token.js";

// STORY-014 (fixed post-review, KAD-11) — `jose`'s SignJWT/jwtVerify own the
// actual EdDSA signing/verification; this module only owns encode/decode of
// the AccessTokenClaims contract shape and the accept/reject decision. Both
// are Promise-returning (jose is WebCrypto-based, inherently async).
// STORY-017 — sid is now caller-supplied (stays stable across a workspace
// switch's re-mint) and verification is kid-aware, via a resolver, so a
// previous key stays valid through a rotation's overlap window.

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
const KID = "test-kid-1";
const SID = "0192f1a0-0000-7000-8000-0000000000aa";

describe("STORY-014 · access token sign/verify", () => {
  const privateKey = importEd25519PrivateKeyFromDer(PRIVATE_KEY_DER);
  const publicKey = importEd25519PublicKeyFromDer(PUBLIC_KEY_DER);
  const resolveKey: KeyResolver = (kid) => {
    if (kid !== KID) throw new Error(`unknown kid: ${String(kid)}`);
    return publicKey;
  };

  it("round-trips sub/sid/ws/role/scope/ent_v exactly, all null (except sid) on a fresh passkey token", async () => {
    const { token, claims } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      privateKey,
      KID,
    );

    const verified = await verifyAccessToken(token, resolveKey);
    expect(verified).toEqual(claims);
    expect(verified.sid).toBe(SID);
    expect(verified.ws).toBeNull();
    expect(verified.role).toBeNull();
    expect(verified.scope).toBeNull();
    expect(verified.ent_v).toBeNull();
  });

  it("carries the caller-supplied sid through unchanged, but mints a fresh, distinct jti on every call", async () => {
    const input = { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null };
    const first = await signAccessToken(input, privateKey, KID);
    const second = await signAccessToken(input, privateKey, KID);

    expect(first.claims.sid).toBe(SID);
    expect(second.claims.sid).toBe(SID);
    expect(first.claims.jti).not.toBe(second.claims.jti);
    expect(first.claims.sid).not.toBe(first.claims.jti);
  });

  it("TTL is exactly 15 minutes (900 seconds), not a plausible neighbour", async () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { claims } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      privateKey,
      KID,
      now,
    );
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      privateKey,
      KID,
    );
    const [header, payload, signature] = token.split(".");
    const tamperedClaims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    tamperedClaims.sub = "0192f1a0-0000-7000-8000-000000000099";
    const tamperedPayload = Buffer.from(JSON.stringify(tamperedClaims)).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;

    await expect(verifyAccessToken(tampered, resolveKey)).rejects.toThrow(AccessTokenError);
  });

  it("rejects an expired token", async () => {
    const past = new Date("2020-01-01T00:00:00.000Z");
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      privateKey,
      KID,
      past,
    );

    await expect(verifyAccessToken(token, resolveKey, new Date("2026-01-01T00:00:00.000Z"))).rejects.toThrow(/expired/);
  });

  it("rejects a malformed token (wrong segment count)", async () => {
    await expect(verifyAccessToken("not-a-jwt", resolveKey)).rejects.toThrow(AccessTokenError);
  });

  it("rejects a token signed by an unrelated keypair", async () => {
    const other = generateKeyPairSync("ed25519");
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      other.privateKey,
      KID,
    );

    await expect(verifyAccessToken(token, resolveKey)).rejects.toThrow(AccessTokenError);
  });
});

describe("STORY-017 · scenario 9 — signing key rotation with overlap", () => {
  it("a token signed by the previous key remains valid for its lifetime, resolved by its own kid", async () => {
    const previousPrivateKey = importEd25519PrivateKeyFromDer(PRIVATE_KEY_DER);
    const previousPublicKey = importEd25519PublicKeyFromDer(PUBLIC_KEY_DER);
    const currentKeyPair = generateKeyPairSync("ed25519");
    const previousKid = "old-kid";
    const currentKid = "new-kid";

    const resolveKey: KeyResolver = (kid) => {
      if (kid === currentKid) return currentKeyPair.publicKey;
      if (kid === previousKid) return previousPublicKey;
      throw new Error(`unknown kid: ${String(kid)}`);
    };

    const { token: oldToken } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      previousPrivateKey,
      previousKid,
    );
    const { token: newToken } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      currentKeyPair.privateKey,
      currentKid,
    );

    await expect(verifyAccessToken(oldToken, resolveKey)).resolves.toMatchObject({ sid: SID });
    await expect(verifyAccessToken(newToken, resolveKey)).resolves.toMatchObject({ sid: SID });
  });

  it("rejects a token whose kid is unrecognized by the resolver", async () => {
    const privateKey = importEd25519PrivateKeyFromDer(PRIVATE_KEY_DER);
    const resolveKey: KeyResolver = () => {
      throw new Error("unknown kid");
    };

    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      privateKey,
      "some-kid",
    );

    await expect(verifyAccessToken(token, resolveKey)).rejects.toThrow(AccessTokenError);
  });
});
