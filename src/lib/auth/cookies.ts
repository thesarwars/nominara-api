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
