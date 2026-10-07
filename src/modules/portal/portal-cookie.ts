import { hkdfSync } from "node:crypto";
import { compactDecrypt, CompactEncrypt, jwtVerify, SignJWT } from "jose";
import { portalCookiePayloadSchema, type PortalCookiePayload } from "../../../contracts/portal/index.js";

// STORY-098 part B — the portal session cookie (integrations-and-sharing.md §3 session flow step 4):
// `__Host-` prefixed, HttpOnly, Secure, SameSite=Lax, 4-hour TTL, carrying { token_id, workspace_id,
// scope_project_ids, scope_tabs, theme_id }, "signed and encrypted — the cookie is not a bearer of privilege beyond
// its scope".
//
// NESTED, SIGN THEN ENCRYPT: an HS256 JWT (integrity: only we can mint one) wrapped in a dir/A256GCM compact JWE
// (confidentiality: the scope is not readable by the holder, and the GCM tag is a second integrity check). The two
// keys are derived from the ONE configured secret with HKDF and distinct `info` labels, so the signing key and the
// encryption key are never the same bytes. Both expire with the session: `exp` is inside the signed claims.

/** `__Host-` requires Secure, Path=/ and no Domain: a sibling subdomain cannot set or overwrite it. */
export const PORTAL_COOKIE_NAME = "__Host-nominara-portal";
export const PORTAL_SESSION_TTL_SECONDS = 4 * 60 * 60;

const KEY_BYTES = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface PortalCookieKey {
  readonly enc: Uint8Array;
  readonly sig: Uint8Array;
}

/** Fails at load, not at first use, so a short or mistyped key is a configuration error and never a weak cookie. */
export function loadPortalCookieKey(base64url: string): PortalCookieKey {
  const root = Buffer.from(base64url, "base64url");
  if (root.length !== KEY_BYTES) throw new Error(`PORTAL_COOKIE_KEY must be ${String(KEY_BYTES)} bytes of base64url`);
  const derive = (info: string): Uint8Array => new Uint8Array(hkdfSync("sha256", root, Buffer.alloc(0), `nominara-portal-cookie:${info}`, KEY_BYTES));
  return { enc: derive("enc"), sig: derive("sig") };
}

export interface SealedPortalCookie {
  readonly value: string;
  readonly expiresAt: Date;
}

export async function sealPortalCookie(payload: PortalCookiePayload, key: PortalCookieKey, now: Date = new Date()): Promise<SealedPortalCookie> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAt + PORTAL_SESSION_TTL_SECONDS;
  const jws = await new SignJWT({ ...payload }).setProtectedHeader({ alg: "HS256" }).setIssuedAt(issuedAt).setExpirationTime(expiresAtSeconds).sign(key.sig);
  const value = await new CompactEncrypt(encoder.encode(jws)).setProtectedHeader({ alg: "dir", enc: "A256GCM", cty: "JWT" }).encrypt(key.enc);
  return { value, expiresAt: new Date(expiresAtSeconds * 1000) };
}

/**
 * The scope the cookie carries, or null. Null for EVERYTHING that is not a current, untampered, correctly-shaped
 * cookie of ours — the caller cannot tell why, and neither can an attacker. The payload is re-parsed `.strict()`, so a
 * cookie carrying any field beyond the five (a role, a permission) is refused rather than trusted.
 */
export async function openPortalCookie(value: string, key: PortalCookieKey, now: Date = new Date()): Promise<PortalCookiePayload | null> {
  if (value === "") return null;
  try {
    const { plaintext } = await compactDecrypt(value, key.enc, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
    const { payload } = await jwtVerify(decoder.decode(plaintext), key.sig, { algorithms: ["HS256"], currentDate: now });
    const { iat: _iat, exp: _exp, ...claims } = payload;
    const parsed = portalCookiePayloadSchema.safeParse(claims);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
