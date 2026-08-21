import type { FastifyReply } from "fastify";
import { ACCESS_TOKEN_TTL_SECONDS } from "./access-token.js";
import { REFRESH_TOKEN_TTL_MS } from "./refresh-token.js";

// STORY-017 — cookie names/flags, verbatim from this story's Implementation
// Decisions: `__Host-` prefix closes subdomain-injection paths (requires
// Secure, Path=/, no Domain attribute — enforced by the prefix itself).
export const ACCESS_COOKIE_NAME = "__Host-nominara-access";
export const REFRESH_COOKIE_NAME = "__Host-nominara-refresh";
export const CSRF_COOKIE_NAME = "__Host-nominara-csrf";
export const CSRF_HEADER_NAME = "x-nominara-csrf-token";

// STORY-015 — the session-binding cookie set at /auth/oauth/:provider/start
// and read back at /callback (security-and-tenancy.md §5: "state ... bound
// to the initiating session" — this cookie IS that binding, hashed with
// oauth-state.ts's hashBinding() and compared against
// oauth_authorization_requests.binding_hash).
export const OAUTH_BINDING_COOKIE_NAME = "__Host-nominara-oauth-binding";

const HARDENED_HTTP_ONLY = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;

const HARDENED_READABLE = {
  httpOnly: false,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;

export interface AuthCookieTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
}

export function setAuthCookies(reply: FastifyReply, tokens: AuthCookieTokens): void {
  reply.setCookie(ACCESS_COOKIE_NAME, tokens.accessToken, { ...HARDENED_HTTP_ONLY, maxAge: ACCESS_TOKEN_TTL_SECONDS });
  reply.setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    ...HARDENED_HTTP_ONLY,
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  });
  reply.setCookie(CSRF_COOKIE_NAME, tokens.csrfToken, { ...HARDENED_READABLE, maxAge: REFRESH_TOKEN_TTL_MS / 1000 });
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE_NAME, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/" });
  reply.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
}

// STORY-015 — SameSite=Lax (via HARDENED_HTTP_ONLY) is required here, not
// incidental: the browser's return from the provider's authorization
// endpoint is a top-level, cross-site GET navigation, and SameSite=Strict
// would drop this cookie before the callback ever saw it. A future
// cookie-hardening pass must not tighten this one to Strict.
export function setOauthBindingCookie(reply: FastifyReply, value: string, maxAgeSeconds: number): void {
  reply.setCookie(OAUTH_BINDING_COOKIE_NAME, value, { ...HARDENED_HTTP_ONLY, maxAge: maxAgeSeconds });
}

export function clearOauthBindingCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_BINDING_COOKIE_NAME, { path: "/" });
}
