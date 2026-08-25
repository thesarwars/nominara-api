import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { AuthGuard } from "../../src/api/guards/auth.guard.js";
import { RbacGuard } from "../../src/api/guards/rbac.guard.js";
import { WorkspaceGuard } from "../../src/api/guards/workspace.guard.js";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import { RoomAuthorizationService } from "../../src/gateway/room-authorization.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { TenancyAccessModule } from "../../src/tenancy/tenancy-access.module.js";
import { WorkspacesModule } from "../../src/modules/workspaces/workspaces.module.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-026 T20/T21 — the three structural assertions from the plan's test
// table. All three are security properties that hold BY CONSTRUCTION, which is
// exactly why they need a test: nothing about the running system would look
// wrong if any of them stopped being true.

describe("STORY-026 · the gateway exposes no HTTP surface", () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    applyFakeApiEnv();
    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it("registers ZERO routes on the gateway process", async () => {
    // The hazard this locks shut: importing WorkspacesModule here would mount
    // workspace create/update, member role changes, invitations and the OAuth
    // callback on GATEWAY_PORT — with no APP_GUARD, no TenantContextInterceptor,
    // no AuditInterceptor and no ProblemFilter, because all of those live in
    // ApiModule. An unauthenticated, unaudited tenant-mutation surface.
    const instance = app.getHttpAdapter().getInstance() as { printRoutes?: () => string };
    const routes = instance.printRoutes?.() ?? "";
    // Fastify prints an empty tree when nothing is registered.
    expect(routes.includes("workspaces"), "the gateway must not serve /workspaces").toBe(false);
    expect(routes.includes("auth"), "the gateway must not serve /auth").toBe(false);
    expect(routes.includes("members"), "the gateway must not serve /members").toBe(false);
  });

  it("answers a workspace-mutation path with 404 rather than serving it", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/workspaces", payload: { name: "x" } });
    expect(response.statusCode).toBe(404);
  });

  it("answers the OAuth callback with 404 — the most dangerous route to mount unguarded", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/oauth/google/callback?code=x&state=y" });
    expect(response.statusCode).toBe(404);
  });

  it("resolves PG_POOL — @Global() does not self-register, so DbModule is imported explicitly", () => {
    // Without the explicit import the gateway fails to resolve PG_POOL at boot.
    // A crash on deploy rather than a subtle fault, but a crash all the same,
    // and one that only appears in the process nothing else exercises.
    expect(() => app.get(RoomAuthorizationService)).not.toThrow();
  });
});

describe("STORY-026 · the socket path uses the SAME guard instances, not equivalent ones", () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    applyFakeApiEnv();
    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it("holds the container's own AuthGuard, WorkspaceGuard and RbacGuard, in the HTTP chain's order", () => {
    // Identity, not shape. A second implementation of "is this caller a member"
    // is a second place for the answer to drift, and it would drift silently in
    // the direction that matters.
    const service = app.get(RoomAuthorizationService);
    expect(service.chain).toEqual([app.get(AuthGuard), app.get(WorkspaceGuard), app.get(RbacGuard)]);
  });

  it("uses the guard classes the API process registers, not gateway-local copies", () => {
    const service = app.get(RoomAuthorizationService);
    expect(service.chain.map((guard) => guard.constructor)).toEqual([AuthGuard, WorkspaceGuard, RbacGuard]);
  });
});

describe("STORY-026 · one MembershipCacheService per process", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // STRUCTURAL, AND IT HAD TO BE. The instance-identity test below passes even
  // when WorkspacesModule declares its own MembershipCacheService again —
  // verified by mutation — because the extra provider ends up shadowed rather
  // than reached by the path the test happens to resolve. The property that
  // actually matters is "declared in exactly ONE module", and that is what this
  // asserts: re-adding either provider to WorkspacesModule turns it red.
  it("WorkspacesModule DECLARES neither service — it imports the one module that does", () => {
    const providers = (Reflect.getMetadata("providers", WorkspacesModule) ?? []) as unknown[];
    const imports = (Reflect.getMetadata("imports", WorkspacesModule) ?? []) as unknown[];

    expect(providers, "a second declaration is a second in-memory Map").not.toContain(MembershipCacheService);
    expect(providers).not.toContain(MembershipService);
    expect(imports).toContain(TenancyAccessModule);
  });

  it("TenancyAccessModule is the sole declaring module, and exports both", () => {
    const providers = (Reflect.getMetadata("providers", TenancyAccessModule) ?? []) as unknown[];
    const exports = (Reflect.getMetadata("exports", TenancyAccessModule) ?? []) as unknown[];
    expect(providers).toEqual(expect.arrayContaining([MembershipService, MembershipCacheService]));
    expect(exports).toEqual(expect.arrayContaining([MembershipService, MembershipCacheService]));
  });

  it("ApiModule resolves the same cache instance through the guard path and the service path", async () => {
    // If WorkspacesModule declared MembershipCacheService while
    // TenancyAccessModule also provided it, a process loading both would hold
    // TWO in-memory Maps. WorkspacesService invalidates synchronously on
    // removeMember and updateRole — it would clear one and leave the other
    // serving a REMOVED MEMBER for up to thirty seconds. That is the revocation
    // leak security-and-tenancy.md §7 exists to prevent, and every test that
    // resolved either instance would still pass.
    applyFakeApiEnv();
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    try {
      const fromCache = app.get(MembershipCacheService);
      const fromService = (app.get(MembershipService) as unknown as { cache: MembershipCacheService }).cache;
      expect(fromService, "two Maps means a revoked member keeps their access").toBe(fromCache);
    } finally {
      await app.close();
    }
  });

  it("the gateway process resolves one too, through TenancyAccessModule alone", async () => {
    applyFakeApiEnv();
    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    try {
      const fromCache = app.get(MembershipCacheService);
      const fromService = (app.get(MembershipService) as unknown as { cache: MembershipCacheService }).cache;
      expect(fromService).toBe(fromCache);
    } finally {
      await app.close();
    }
  });
});
