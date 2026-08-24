import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signAccessToken, importEd25519PrivateKeyFromDer } from "../../lib/auth/access-token.js";
import { computeCsrfToken } from "../../lib/auth/csrf.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../lib/auth/cookies.js";
import { Public } from "../decorators/public.decorator.js";
import { AuthGuard, type AuthenticatedRequest } from "./auth.guard.js";

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
const KID = "test-kid-1";
const CSRF_SECRET = "test-csrf-secret";
const SID = "0192f1a0-0000-7000-8000-000000000099";

class PrivateController {
  handler(): void {}
}

class PublicController {
  @Public()
  handler(): void {}
}

function makeContext(ctor: new () => object, req: AuthenticatedRequest): ExecutionContext {
  const proto = ctor.prototype as { handler: () => void };
  return {
    getHandler: () => proto.handler,
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function fakePool(rows: Array<{ revoked_at: Date | null }>): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

async function mintToken(overrides: { now?: Date; kid?: string; privateKeyDer?: string } = {}): Promise<string> {
  const privateKey = importEd25519PrivateKeyFromDer(overrides.privateKeyDer ?? PRIVATE_KEY_DER);
  const { token } = await signAccessToken(
    { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
    privateKey,
    overrides.kid ?? KID,
    overrides.now,
  );
  return token;
}

// STORY-017 — AuthGuard becomes cookie-only + session-load/deny-check: the
// highest-stakes lines in this diff alongside session.service.ts's rotation
// SQL. No Authorization: Bearer fallback exists at all — a session is
// authenticated by a cookie or it isn't authenticated.
describe("STORY-017 · AuthGuard", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = PUBLIC_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_KID = KID;
    process.env.CSRF_SECRET = CSRF_SECRET;
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    delete process.env.AUTH_TOKEN_ED25519_PREVIOUS_PUBLIC_KEY;
    delete process.env.AUTH_TOKEN_ED25519_PREVIOUS_KID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("bypasses verification entirely on a @Public() route with no cookies at all", async () => {
    const guard = new AuthGuard(new Reflector(), fakePool([]));
    const context = makeContext(PublicController, {});

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("rejects a private route with no session cookie", async () => {
    const guard = new AuthGuard(new Reflector(), fakePool([]));
    const context = makeContext(PrivateController, { cookies: {} });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("STORY-017 · scenario 1 — accepts a validly signed, unexpired token, loads the live session, and attaches claims to the request", async () => {
    const token = await mintToken();
    const pool = fakePool([{ revoked_at: null }]);
    const guard = new AuthGuard(new Reflector(), pool);
    const req: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "GET" };
    const context = makeContext(PrivateController, req);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.auth?.sid).toBe(SID);
    expect(req.authMethod).toBe("session");
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("FROM sessions"), [SID]);
  });

  it("STORY-017 · scenario 2 — rejects an expired token with a distinguishable expiry message", async () => {
    const token = await mintToken({ now: new Date("2020-01-01T00:00:00.000Z") });
    const guard = new AuthGuard(new Reflector(), fakePool([{ revoked_at: null }]));
    const context = makeContext(PrivateController, { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "GET" });

    await expect(guard.canActivate(context)).rejects.toThrow("access token expired");
  });

  it("rejects a token signed by a foreign keypair", async () => {
    const { privateKey: foreignPrivateKey } = generateKeyPairSync("ed25519");
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      foreignPrivateKey,
      KID,
    );
    const guard = new AuthGuard(new Reflector(), fakePool([{ revoked_at: null }]));
    const context = makeContext(PrivateController, { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "GET" });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("STORY-017 · scenario 5 — refuses via the deny list once the session is revoked, even with a structurally valid, unexpired token", async () => {
    const token = await mintToken();
    const guard = new AuthGuard(new Reflector(), fakePool([{ revoked_at: new Date() }]));
    const context = makeContext(PrivateController, { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "GET" });

    await expect(guard.canActivate(context)).rejects.toThrow("session revoked");
  });

  it("STORY-017 · refuses via the deny list when the session row no longer exists at all", async () => {
    const token = await mintToken();
    const guard = new AuthGuard(new Reflector(), fakePool([]));
    const context = makeContext(PrivateController, { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "GET" });

    await expect(guard.canActivate(context)).rejects.toThrow("session revoked");
  });

  it("STORY-017 · scenario 6 — a mutating request with the session cookie but no double-submit token is refused", async () => {
    const token = await mintToken();
    const guard = new AuthGuard(new Reflector(), fakePool([{ revoked_at: null }]));
    const req: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "POST", headers: {} };
    const context = makeContext(PrivateController, req);

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it("STORY-017 · a mutating request carrying a matching double-submit cookie and header is permitted", async () => {
    const token = await mintToken();
    const csrfToken = computeCsrfToken(SID, CSRF_SECRET);
    const guard = new AuthGuard(new Reflector(), fakePool([{ revoked_at: null }]));
    const req: AuthenticatedRequest = {
      cookies: { [ACCESS_COOKIE_NAME]: token, [CSRF_COOKIE_NAME]: csrfToken },
      headers: { [CSRF_HEADER_NAME]: csrfToken },
      method: "POST",
    };
    const context = makeContext(PrivateController, req);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("STORY-017 · scenario 9 — a token signed by the previous key still verifies through the guard during a rotation's overlap window", async () => {
    process.env.AUTH_TOKEN_ED25519_PREVIOUS_KID = "previous-kid";
    process.env.AUTH_TOKEN_ED25519_PREVIOUS_PUBLIC_KEY = PUBLIC_KEY_DER;
    const token = await mintToken({ kid: "previous-kid" });
    const guard = new AuthGuard(new Reflector(), fakePool([{ revoked_at: null }]));
    const context = makeContext(PrivateController, { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "GET" });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("rejects a token whose kid the guard's key map does not recognize", async () => {
    const token = await mintToken({ kid: "unknown-kid" });
    const guard = new AuthGuard(new Reflector(), fakePool([{ revoked_at: null }]));
    const context = makeContext(PrivateController, { cookies: { [ACCESS_COOKIE_NAME]: token }, method: "GET" });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});
