import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { accessTokenClaimsSchema, type AccessTokenClaims } from "../../../contracts/identity/access-token-claims.schema.js";
import { uuidV7 } from "../ids/uuidv7.js";

// STORY-014 (fixed post-review, KAD-11) — JOSE signature verification is one
// of the four things this repo never hand-writes (Nominara-Dev-Docs-main's
// README, EPIC-02). `jose`'s SignJWT/jwtVerify own the actual EdDSA JWS
// encoding, signing, and verification; this module only owns the
// AccessTokenClaims contract shape and the key material's DER encoding.
// `algorithms: ["EdDSA"]` is passed explicitly on every verify call so the
// token's own header can never select the verification algorithm — no
// alg-confusion surface.

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const JWS_PROTECTED_HEADER = { alg: "EdDSA", typ: "JWT" } as const;

export function importEd25519PrivateKeyFromDer(base64Der: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(base64Der, "base64"), format: "der", type: "pkcs8" });
}

export function importEd25519PublicKeyFromDer(base64Der: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64Der, "base64"), format: "der", type: "spki" });
}

export class AccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenError";
  }
}

export interface MintAccessTokenInput {
  readonly sub: string;
  /** STORY-017 — caller-supplied, not auto-generated: stays stable across a workspace switch's re-mint. */
  readonly sid: string;
  readonly ws: string | null;
  readonly role: string | null;
  readonly scope: readonly string[] | null;
  readonly entV: number | null;
}

/**
 * STORY-017 — resolves a JWS `kid` header to the public key that verifies it.
 * Thrown/rejected for an unrecognized kid; the caller (AuthGuard) never sees
 * the distinction between "unknown kid" and any other signature failure —
 * both fail closed as an invalid token.
 */
export type KeyResolver = (kid: string | undefined) => KeyObject;

/** Mints a fresh access token: caller-supplied sid, fresh UUIDv7 jti, 15-minute TTL from `now`. */
export async function signAccessToken(
  input: MintAccessTokenInput,
  privateKey: KeyObject,
  kid: string,
  now: Date = new Date(),
): Promise<{ token: string; claims: AccessTokenClaims }> {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: AccessTokenClaims = {
    sub: input.sub,
    sid: input.sid,
    ws: input.ws,
    role: input.role,
    scope: input.scope === null ? null : [...input.scope],
    ent_v: input.entV,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    jti: uuidV7(),
  };

  const token = await new SignJWT(claims)
    .setProtectedHeader({ ...JWS_PROTECTED_HEADER, kid })
    .sign(privateKey);

  return { token, claims };
}

/** Verifies signature + expiry ONLY (no session load, no jti deny-list — see AuthGuard's Technical Notes). */
export async function verifyAccessToken(
  token: string,
  resolveKey: KeyResolver,
  now: Date = new Date(),
): Promise<AccessTokenClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, (header) => resolveKey(header.kid), {
      algorithms: ["EdDSA"],
      currentDate: now,
    }));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_JWT_EXPIRED") {
      throw new AccessTokenError("token expired");
    }
    throw new AccessTokenError("invalid or malformed token");
  }

  const result = accessTokenClaimsSchema.safeParse(payload);
  if (!result.success) {
    throw new AccessTokenError("malformed claims: does not match AccessTokenClaims contract");
  }

  return result.data;
}
