import { createHmac, timingSafeEqual } from "node:crypto";

// STORY-017 — CSRF applies to every cookie-authenticated (authMethod
// "session") mutating request, full stop — there is no header-auth session
// case to exempt. Key-authenticated requests are header-only and
// cookie-less, so they need no such token (AC). Pure functions: no I/O, no
// clock, no framework types, so AuthGuard's request-shape logic is
// unit-testable separately from the double-submit decision itself.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * The pseudo-method a synthesised WebSocket handshake carries
 * (src/gateway/ws-execution-context.ts).
 */
export const WEBSOCKET_HANDSHAKE_METHOD = "WS";

/**
 * Whether a request must present the double-submit token.
 *
 * A WebSocket handshake is not "mutating" in the HTTP sense and IS
 * CSRF-relevant, which is why this is a separate question from
 * isMutatingMethod(). The handshake is cookie-authenticated and opens a
 * long-lived, readable stream; `SameSite=Lax` blocks cross-SITE only, so a
 * same-site origin could open one with the user's cookies and read
 * everything. Before this existed `verifyDoubleSubmit` short-circuited on
 * "WS" and returned true unconditionally — the one cookie-authenticated
 * transport with no CSRF check at all.
 */
export function requiresCsrfProtection(method: string): boolean {
  return isMutatingMethod(method) || method.toUpperCase() === WEBSOCKET_HANDSHAKE_METHOD;
}

/** The CSRF cookie's own value: HMAC-SHA256(sid, secret), bound to the session so it cannot be forged without the server secret. */
export function computeCsrfToken(sid: string, secret: string): string {
  return createHmac("sha256", secret).update(sid).digest("hex");
}

export interface VerifyDoubleSubmitInput {
  readonly authMethod: "session" | "apiKey";
  readonly method: string;
  readonly sid: string;
  readonly cookieToken: string | undefined;
  readonly headerToken: string | undefined;
  readonly secret: string;
}

/** True if the request is permitted to proceed under the CSRF rule (scenarios 6 and 7). */
export function verifyDoubleSubmit(input: VerifyDoubleSubmitInput): boolean {
  if (input.authMethod !== "session") return true;
  if (!requiresCsrfProtection(input.method)) return true;
  if (!input.cookieToken || !input.headerToken) return false;

  const expected = Buffer.from(computeCsrfToken(input.sid, input.secret), "hex");
  const cookie = Buffer.from(input.cookieToken, "hex");
  const header = Buffer.from(input.headerToken, "hex");
  if (cookie.length !== expected.length || header.length !== expected.length) return false;

  return timingSafeEqual(cookie, expected) && timingSafeEqual(header, expected);
}
