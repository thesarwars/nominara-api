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
  readonly ws: string | null;
  readonly role: string | null;
  readonly scope: readonly string[] | null;
  readonly entV: number | null;
}

/** Mints a fresh access token: fresh UUIDv7 sid/jti, 15-minute TTL from `now`. */
export async function signAccessToken(
  input: MintAccessTokenInput,
  privateKey: KeyObject,
  now: Date = new Date(),
): Promise<{ token: string; claims: AccessTokenClaims }> {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: AccessTokenClaims = {
    sub: input.sub,
    sid: uuidV7(),
    ws: input.ws,
    role: input.role,
    scope: input.scope === null ? null : [...input.scope],
    ent_v: input.entV,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    jti: uuidV7(),
  };

  const token = await new SignJWT(claims).setProtectedHeader(JWS_PROTECTED_HEADER).sign(privateKey);

  return { token, claims };
}

/** Verifies signature + expiry ONLY (no session load, no jti deny-list — see AuthGuard's Technical Notes). */
export async function verifyAccessToken(
  token: string,
  publicKey: KeyObject,
  now: Date = new Date(),
): Promise<AccessTokenClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, publicKey, { algorithms: ["EdDSA"], currentDate: now }));
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
