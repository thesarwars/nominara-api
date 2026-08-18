import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importEd25519PrivateKeyFromDer, signAccessToken } from "../../lib/auth/access-token.js";
import { ACCESS_COOKIE_NAME } from "../../lib/auth/cookies.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { ApiModule } from "../api.module.js";
import { Public } from "../decorators/public.decorator.js";
import { registerCookiePlugin } from "../register-cookies.js";

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const KID = "test-kid-1";
const SID = "0192f1a0-0000-7000-8000-000000000098";

// A route that always throws, added only to this test's root module — not
// part of ApiModule/production. Global guards/interceptors/ProblemFilter
// (registered inside the imported ApiModule via APP_GUARD/APP_INTERCEPTOR/
// APP_FILTER) still apply to it, the same as any real controller.
@Controller("test-only")
class ThrowingController {
  @Get("public-throws")
  @Public()
  publicThrows(): never {
    throw new Error("raw internal detail that must never reach the client");
  }

  @Get("private-no-tenant")
  privateNoTenant(): { ok: true } {
    return { ok: true };
  }
}

// STORY-022 — ProblemFilter is registered once, globally, in api.module.ts.
// This proves it actually intercepts real HTTP requests through the full
// composition root (guards + interceptors + filter), not just a unit-level
// call to .catch() — the current spec.ts before this fix never provoked it.
describe("STORY-022 · ProblemFilter over real HTTP", () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
      controllers: [ThrowingController],
    })
      // STORY-017 — AuthGuard now loads the live session row through
      // PG_POOL; DATABASE_URL above is a fake connection string, so this
      // stub is what lets a validly signed token actually reach the
      // TenantContextInterceptor behavior this suite exercises, rather than
      // failing for an unrelated connection-refused reason that would
      // coincidentally produce the same 500 body.
      .overrideProvider(PG_POOL)
      .useValue({ query: async () => ({ rows: [{ revoked_at: null }] }), end: async () => {} })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await registerCookiePlugin(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it("maps an unmatched route (framework 404) to a problem+json body", async () => {
    const response = await app.inject({ method: "GET", url: "/route-that-does-not-exist" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toMatchObject({ type: "about:blank", status: 404, title: "NOT_FOUND" });
  });

  it("maps a generic Error thrown by a handler to a 500 problem+json without leaking its message", async () => {
    const response = await app.inject({ method: "GET", url: "/test-only/public-throws" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 500,
      title: "INTERNAL_SERVER_ERROR",
      detail: "internal server error",
    });
  });

  it("maps TenantContextMissingError (a private route with no tenant set) to a well-formed 500 problem+json", async () => {
    // AuthGuard is real as of STORY-014 — this route is private, so it needs
    // a validly signed token to get past AuthGuard at all before reaching
    // the TenantContextInterceptor behavior this test actually exercises.
    const privateKey = importEd25519PrivateKeyFromDer(PRIVATE_KEY_DER);
    const { token } = await signAccessToken(
      { sub: "0192f1a0-0000-7000-8000-000000000001", sid: SID, ws: null, role: null, scope: null, entV: null },
      privateKey,
      KID,
    );
    const response = await app.inject({
      method: "GET",
      url: "/test-only/private-no-tenant",
      cookies: { [ACCESS_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 500,
      title: "INTERNAL_SERVER_ERROR",
      detail: "internal server error",
    });
  });
});
