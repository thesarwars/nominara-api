import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type ClientBase } from "pg";
import { CanActivate, Controller, ExecutionContext, Injectable, Param, Patch } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbModule } from "../../src/db/db.module.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { Audit } from "../../src/api/decorators/audit.decorator.js";
import { AuditInterceptor } from "../../src/api/interceptors/audit.interceptor.js";
import { TenantContextInterceptor } from "../../src/api/interceptors/tenant-context.interceptor.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { currentTenantStore } from "../../src/tenancy/tenant-context.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";

// STORY-020 fix pass (qa-reviewer blocking finding 2) — no route in this
// repo carries @Audit() yet, so nothing exercised AuditInterceptor through a
// real Nest pipeline against real Postgres. This spec adds a minimal
// controller for exactly that: guard sets req.tenant (mirroring
// WorkspaceGuard's contract, without pulling in the full auth/entitlement
// chain those routes don't need for this proof) -> TenantContextInterceptor
// opens the real transaction -> AuditInterceptor resolves resource_id and
// appends -> the controller's own mutation runs on the SAME transaction's
// client. No mocked pg client anywhere in this file.

@Injectable()
class TestTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      tenant?: { workspaceId: string; actorId: string };
      authMethod?: string;
    }>();
    const workspaceId = req.headers["x-test-workspace-id"];
    const actorId = req.headers["x-test-actor-id"];
    req.tenant = {
      workspaceId: typeof workspaceId === "string" ? workspaceId : "",
      actorId: typeof actorId === "string" ? actorId : "",
    };
    req.authMethod = "session";
    return true;
  }
}

// The mutation every route below performs — a real INSERT on the SAME
// context-carrying transaction AuditInterceptor writes into. Deliberately
// keyed on a server-generated id, never on the route's own :id/:otherName
// param, so a malformed audit resource_id source can never accidentally
// "succeed" by virtue of the mutation itself failing (or succeeding) first.
async function insertProjectFixtureRow(client: ClientBase, workspaceId: string): Promise<void> {
  await client.query(
    "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,$3,$4,$5,$6)",
    [randomUUID(), workspaceId, "test-project", `test-project-${randomUUID()}`, "https://example.com", "example.com"],
  );
}

@Controller("test-audit")
class TestAuditController {
  @Patch("projects/:id")
  @Audit({ action: "test.project.mutation", resourceType: "project" })
  async mutate(@Param("id") _id: string): Promise<{ ok: true }> {
    const store = currentTenantStore()!;
    await insertProjectFixtureRow(store.client, store.context.workspaceId);
    return { ok: true };
  }

  // Deliberately declares no paramName override while its own route param
  // is named "otherName", not "id" — reproduces the exact misconfiguration
  // qa-reviewer's finding 2 flagged (a decorator/route param name mismatch).
  @Patch("mismatched/:otherName")
  @Audit({ action: "test.project.mutation_mismatched", resourceType: "project" })
  async mutateMismatched(@Param("otherName") _otherName: string): Promise<{ ok: true }> {
    const store = currentTenantStore()!;
    await insertProjectFixtureRow(store.client, store.context.workspaceId);
    return { ok: true };
  }
}

describe("STORY-020 fix pass · AuditInterceptor through a real Nest HTTP pipeline against real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  let workspaceId: string;
  const originalEnv = { ...process.env };

  async function projectCount(): Promise<number> {
    const result = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM projects WHERE workspace_id = $1", [
      workspaceId,
    ]);
    return Number(result.rows[0]!.count);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    // STORY-021 — DbModule's PG_POOL factory now calls loadEnv(), which
    // requires this even though this file never touches workspace DEKs.
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);

    const workspace = await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id",
      ["Audit Pipeline Test WS", `audit-pipeline-${randomUUID()}`],
    );
    workspaceId = workspace.rows[0]!.id;

    const moduleRef = await Test.createTestingModule({
      imports: [DbModule],
      controllers: [TestAuditController],
      providers: [
        Reflector,
        AuditChainService,
        { provide: APP_GUARD, useClass: TestTenantGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await container.stop();
    process.env = { ...originalEnv };
  });

  it("(a) a real mutating request writes an audit row inside the same transaction, with actor and request id", async () => {
    const actorId = "10000000-0000-0000-0000-000000000001";
    const resourceId = "20000000-0000-0000-0000-000000000002";
    const beforeCount = await projectCount();

    const res = await app.inject({
      method: "PATCH",
      url: apiUrl(`/test-audit/projects/${resourceId}`),
      headers: { "x-test-workspace-id": workspaceId, "x-test-actor-id": actorId },
    });

    expect(res.statusCode).toBe(200);
    expect(await projectCount()).toBe(beforeCount + 1);

    const row = await db.query<{ actor_id: string; resource_id: string; request_id: string }>(
      "SELECT actor_id, resource_id, request_id FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY seq DESC LIMIT 1",
      [workspaceId, "test.project.mutation"],
    );
    expect(row.rows[0]!.actor_id).toBe(actorId);
    expect(row.rows[0]!.resource_id).toBe(resourceId);
    expect(row.rows[0]!.request_id.length).toBeGreaterThan(0);
  });

  it("(b) forcing the audit append itself to fail (malformed actor_id, a real 22P02 from Postgres) rolls back the mutation too — no row left behind", async () => {
    const beforeCount = await projectCount();
    const beforeAuditCount = (
      await db.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_log WHERE workspace_id = $1", [workspaceId])
    ).rows[0]!.count;

    const res = await app.inject({
      method: "PATCH",
      url: apiUrl(`/test-audit/projects/${randomUUID()}`),
      headers: { "x-test-workspace-id": workspaceId, "x-test-actor-id": "not-a-uuid" },
    });

    expect(res.statusCode).toBe(500);
    expect(await projectCount()).toBe(beforeCount);
    const afterAuditCount = (
      await db.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_log WHERE workspace_id = $1", [workspaceId])
    ).rows[0]!.count;
    expect(afterAuditCount).toBe(beforeAuditCount);
  });

  it("(c1) a non-UUID resource_id param is rejected by the new fail-closed check, not silently written or forwarded to Postgres as-is — mutation rolls back", async () => {
    const actorId = "10000000-0000-0000-0000-000000000003";
    const beforeCount = await projectCount();

    const res = await app.inject({
      method: "PATCH",
      url: apiUrl("/test-audit/projects/not-a-uuid"),
      headers: { "x-test-workspace-id": workspaceId, "x-test-actor-id": actorId },
    });

    expect(res.statusCode).toBe(500);
    expect(await projectCount()).toBe(beforeCount);
  });

  it("(c2) a route whose @Audit() paramName doesn't match its own path param is rejected by the fail-closed check, not silently recorded as null — mutation rolls back", async () => {
    const actorId = "10000000-0000-0000-0000-000000000004";
    const beforeCount = await projectCount();

    const res = await app.inject({
      method: "PATCH",
      url: apiUrl("/test-audit/mismatched/some-value"),
      headers: { "x-test-workspace-id": workspaceId, "x-test-actor-id": actorId },
    });

    expect(res.statusCode).toBe(500);
    expect(await projectCount()).toBe(beforeCount);
  });
});
