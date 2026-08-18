import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signAccessToken, importEd25519PrivateKeyFromDer } from "../../lib/auth/access-token.js";
import { Public } from "../decorators/public.decorator.js";
import { AuthGuard, type AuthenticatedRequest } from "./auth.guard.js";

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";

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

// STORY-014 — AuthGuard becomes real: EdDSA signature + expiry verification
// ONLY (no session-load, no jti deny-list — no sessions table exists until
// STORY-017). Must still bypass entirely on @Public() routes, or the
// existing STORY-022 guard-order test (which exercises this class against
// the unauthenticated /health/live route) breaks.
describe("STORY-014 · AuthGuard", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = PUBLIC_KEY_DER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("bypasses verification entirely on a @Public() route with no Authorization header", async () => {
    const guard = new AuthGuard(new Reflector());
    const context = makeContext(PublicController, {});

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("rejects a private route with no Authorization header", async () => {
    const guard = new AuthGuard(new Reflector());
    const context = makeContext(PrivateController, { headers: {} });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a malformed Authorization header (not Bearer)", async () => {
    const guard = new AuthGuard(new Reflector());
    const context = makeContext(PrivateController, { headers: { authorization: "Basic xyz" } });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("accepts a validly signed, unexpired token and attaches claims to the request", async () => {
    const privateKey = importEd25519PrivateKeyFromDer(PRIVATE_KEY_DER);
    const { token, claims } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null },
      privateKey,
    );
    const guard = new AuthGuard(new Reflector());
    const req: AuthenticatedRequest = { headers: { authorization: `Bearer ${token}` } };
    const context = makeContext(PrivateController, req);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.auth).toEqual(claims);
  });

  it("rejects an expired token", async () => {
    const privateKey = importEd25519PrivateKeyFromDer(PRIVATE_KEY_DER);
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null },
      privateKey,
      new Date("2020-01-01T00:00:00.000Z"),
    );
    const guard = new AuthGuard(new Reflector());
    const context = makeContext(PrivateController, { headers: { authorization: `Bearer ${token}` } });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a token signed by a foreign keypair", async () => {
    const { privateKey: foreignPrivateKey } = generateKeyPairSync("ed25519");
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", ws: null, role: null, scope: null, entV: null },
      foreignPrivateKey,
    );
    const guard = new AuthGuard(new Reflector());
    const context = makeContext(PrivateController, { headers: { authorization: `Bearer ${token}` } });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});
