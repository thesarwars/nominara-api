import { Controller, Get } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiModule } from "../api.module.js";
import { Public } from "../decorators/public.decorator.js";

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
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalDatabaseUrlPooled = process.env.DATABASE_URL_POOLED;

  beforeEach(async () => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";

    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
      controllers: [ThrowingController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    process.env.DATABASE_URL = originalDatabaseUrl;
    process.env.DATABASE_URL_POOLED = originalDatabaseUrlPooled;
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
    const response = await app.inject({ method: "GET", url: "/test-only/private-no-tenant" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "about:blank",
      status: 500,
      title: "INTERNAL_SERVER_ERROR",
      detail: "internal server error",
    });
  });
});
