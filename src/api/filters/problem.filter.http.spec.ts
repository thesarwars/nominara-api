import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importEd25519PrivateKeyFromDer, signAccessToken } from "../../lib/auth/access-token.js";
import { ACCESS_COOKIE_NAME } from "../../lib/auth/cookies.js";
import { PG_POOL } from "../../db/pg-pool.js";
import {
  PermissionDeniedException,
  ProjectOutOfScopeException,
  StepUpRequiredException,
  WorkspaceSuspendedException,
} from "../../tenancy/errors.js";
import { ApiModule } from "../api.module.js";
import { configureApp } from "../configure-app.js";
import { Public } from "../decorators/public.decorator.js";
import { apiUrl } from "../../../test/support/api-url.js";

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

  // Code-review finding (STORY-019) — these routes prove ProblemFilter
  // serializes `code`/`details` from getResponse() over real HTTP, not just
  // at the exception-object level the unit spec already covered.
  @Get("throws-permission-denied")
  @Public()
  throwsPermissionDenied(): never {
    throw new PermissionDeniedException("workspace:delete");
  }

  @Get("throws-project-out-of-scope")
  @Public()
  throwsProjectOutOfScope(): never {
    throw new ProjectOutOfScopeException();
  }

  @Get("throws-step-up-required")
  @Public()
  throwsStepUpRequired(): never {
    throw new StepUpRequiredException(["webauthn"]);
  }

  @Get("throws-workspace-suspended")
  @Public()
  throwsWorkspaceSuspended(): never {
    throw new WorkspaceSuspendedException();
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
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";

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
    await configureApp(app);
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
    // STORY-024 T9 — a framework-raised 404 predates the taxonomy but still
    // lands on §2's vocabulary, because §2 is the only vocabulary the wire
    // has. Title is the code in title case, per §2's own example.
    expect(body).toMatchObject({ type: "about:blank", status: 404, title: "Not Found" });
    expect(body.error).toMatchObject({ code: "not_found", request_id: expect.any(String) });
  });

  it("maps a generic Error thrown by a handler to a 500 problem+json without leaking its message", async () => {
    const response = await app.inject({ method: "GET", url: apiUrl("/test-only/public-throws") });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 500,
      title: "INTERNAL_SERVER_ERROR",
      detail: "internal server error",
      request_id: expect.any(String),
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
      url: apiUrl("/test-only/private-no-tenant"),
      cookies: { [ACCESS_COOKIE_NAME]: token },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 500,
      title: "INTERNAL_SERVER_ERROR",
      detail: "internal server error",
      request_id: expect.any(String),
    });
  });

  it("REQ-019-4 · serializes PermissionDeniedException's code/details over the wire", async () => {
    const response = await app.inject({ method: "GET", url: apiUrl("/test-only/throws-permission-denied") });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 403,
      title: "Forbidden",
      detail: "missing required permission: workspace:delete",
      error: {
        code: "forbidden",
        message: "missing required permission: workspace:delete",
        details: { required_permission: "workspace:delete" },
        request_id: expect.any(String),
      },
    });
  });

  it("REQ-019-3 · serializes ProjectOutOfScopeException's distinct code over the wire", async () => {
    const response = await app.inject({ method: "GET", url: apiUrl("/test-only/throws-project-out-of-scope") });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 403,
      title: "Project Out Of Scope",
      detail: "this project is outside your assigned scope",
      error: {
        code: "project_out_of_scope",
        message: "this project is outside your assigned scope",
        request_id: expect.any(String),
      },
    });
  });

  it("REQ-019-5 · serializes StepUpRequiredException's acceptable methods over the wire", async () => {
    const response = await app.inject({ method: "GET", url: apiUrl("/test-only/throws-step-up-required") });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 401,
      title: "Step Up Required",
      detail: "step-up re-authentication required",
      error: {
        code: "step_up_required",
        message: "step-up re-authentication required",
        details: { methods: ["webauthn"] },
        request_id: expect.any(String),
      },
    });
  });

  // STORY-024 decision D12 — `workspace_suspended` is NOT one of §2's 27
  // codes, so it cannot go on the wire as itself. It is mapped to `forbidden`
  // and keeps its identity in `details.reason`; the exception class is
  // unchanged and still throws `workspace_suspended` internally.
  it("STORY-018 regression · WorkspaceSuspendedException reaches the wire as a mapped taxonomy code", async () => {
    const response = await app.inject({ method: "GET", url: apiUrl("/test-only/throws-workspace-suspended") });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 403,
      title: "Forbidden",
      detail: "this workspace is suspended",
      error: {
        code: "forbidden",
        message: "this workspace is suspended",
        details: { reason: "workspace_suspended" },
        request_id: expect.any(String),
      },
    });
  });
});
