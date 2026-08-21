import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// STORY-015 — dangerous area: state-signing/session-binding for an
// authentication flow (second-engineer review required alongside
// oauth.service.ts). Pure crypto, no DB/framework dependency, so the
// signing/verification logic is unit-testable in isolation from the
// callback orchestration that consumes it (test/unit/oauth-state.spec.ts).
//
// signState/verifyState carry the oauth_authorization_requests row's id
// through the provider redirect as the `state` parameter — signed so a
// tampered or foreign-secret token is refused before any DB round-trip
// (security-and-tenancy.md §5: "state is signed, single-use, short-lived").
// The single-use and short-lived parts are enforced by the DB row itself
// (atomic UPDATE ... RETURNING claim, expires_at), not by this file.

const STATE_SEPARATOR = ".";

/** `${requestId}.${base64url(HMAC-SHA256(requestId, secret))}` — opaque, tamper-evident. */
export function signState(requestId: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(requestId).digest("base64url");
  return `${requestId}${STATE_SEPARATOR}${signature}`;
}

/**
 * Returns the requestId a token was signed for, or null on ANY failure
 * (malformed, tampered, wrong secret) — never throws. A callback presenting
 * a bad state must fail the exact same neutral way as any other refusal.
 */
export function verifyState(token: string, secret: string): string | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  const separatorIndex = token.indexOf(STATE_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return null;
  }

  const requestId = token.slice(0, separatorIndex);
  const providedSignature = token.slice(separatorIndex + 1);
  const expectedSignature = createHmac("sha256", secret).update(requestId).digest("base64url");

  const expected = Buffer.from(expectedSignature, "base64url");
  const provided = Buffer.from(providedSignature, "base64url");
  if (expected.length !== provided.length) {
    return null;
  }
  // Timing-safe comparison of the signature bytes, never the raw strings —
  // a length- or string-equality check here would reopen the timing side
  // channel signing was meant to close.
  if (!timingSafeEqual(provided, expected)) {
    return null;
  }
  return requestId;
}

/** CSPRNG session-binding value, >= 32 bytes decoded — the raw value a hardened cookie carries. */
export function newBindingValue(): string {
  return randomBytes(32).toString("base64url");
}

/** Deterministic digest of a binding value — what oauth_authorization_requests.binding_hash actually stores. */
export function hashBinding(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
