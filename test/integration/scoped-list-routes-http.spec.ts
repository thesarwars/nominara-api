import { randomUUID, createHash } from "node:crypto";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { ACCESS_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import type { ProjectListItem } from "../../contracts/projects/index.js";
import type { ActionItem } from "../../contracts/tasks/index.js";

// STORY-169 re-audit (api:re-audit finding [blocker] 1) — `ef7e554` let a
// project-scoped manager/viewer reach `GET /v1/projects` and
// `GET /v1/workspaces/{id}/action-items` for the first time by adding
// `@ScopedByQuery()`. For `nominara_app`, RLS narrows only by workspace
// (`portal_scope_*` binds `nominara_portal` only — security-and-tenancy.md
// §8), so `ProjectsService.list`/`TasksService.listActionItems`'s own
// `cardinality(app.current_scope_projects()) = 0 OR id = ANY(...)`
// predicate is now the ONLY thing hiding an out-of-scope project from a
// scoped member. Nothing before this file drove that predicate through the
// REAL guard → interceptor → controller → service chain for an actual
// scoped `workspace_members` row: `action-items.spec.ts`'s scope test calls
// `TasksService` directly with a hand-built `TenantContext`, and no test at
// all covered `ProjectsService.list`'s extended SELECT this way.
//
// Mutation-tested (STORY-169 finding evidence): changing the predicate to
// `... OR id = ANY(app.current_scope_projects()) OR true)` — fail-open,
// every existing SQL-substring assertion still matches — survived
// test:unit, test:isolation and the full test:integration suite. The tests
// below are written to prove that mutant fails: a scoped manager must see
// ONLY their in-scope project, over the real HTTP path.
describe("STORY-169 re-audit · a project-scoped manager on GET /v1/projects and GET /v1/workspaces/{id}/action-items", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaces: WorkspacesService;
  let sessions: SessionService;
  let app: NestFastifyApplication;

  const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
  const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
  const KID = "test-kid-1";
  const WRAPPING_KEY = Buffer.alloc(32, 11);
  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = PUBLIC_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_KID = KID;
    process.env.CSRF_SECRET = "test-csrf-secret";
    process.env.WORKSPACE_DEK_WRAPPING_KEY = WRAPPING_KEY.toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
    process.env.QUEUE_REDIS_URL = "redis://localhost:6380";
    process.env.ENGINE_TOKEN_BUCKETS =
      '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    pool = new Pool({ connectionString: container.getConnectionUri() });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      membership,
      sessions,
      new NoopRealtimePublisher(),
    );

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await pool.end();
    await db.end();
  });

  async function createUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
    return result.rows[0]!.id;
  }

  async function createProject(workspaceId: string, name: string): Promise<string> {
    const slug = `${name.toLowerCase().replace(/\s+/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const result = await db.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      [workspaceId, name, slug, `https://${slug}.example`, `${slug}.example`],
    );
    return result.rows[0]!.id;
  }

  /** A `manager` member with the given project scope, wired end-to-end to a ws-scoped access token — never a hand-built `TenantContext`. */
  async function accessTokenForScopedManager(
    workspaceId: string,
    projectScope: readonly string[] | null,
  ): Promise<string> {
    const managerId = await createUser();
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, project_scope, status)
       VALUES ($1,$2,'manager',$3,'active')`,
      [workspaceId, managerId, projectScope],
    );
    const tokens = await sessions.createSession(managerId);
    const switched = await workspaces.switchTo(managerId, tokens.sid, workspaceId, meta);
    return switched.accessToken;
  }

  it("a manager scoped to ONE project sees only that project on GET /v1/projects, over the real guard/interceptor/handler chain", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const inScope = await createProject(workspace.id, "In Scope Co");
    const outOfScope = await createProject(workspace.id, "Out Of Scope Co");

    const accessToken = await accessTokenForScopedManager(workspace.id, [inScope]);

    const res = await app.inject({
      method: "GET",
      url: apiUrl("/projects"),
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
    });

    expect(res.statusCode).toBe(200);
    const items = dataOf<ProjectListItem[]>(res);
    const ids = items.map((item) => item.id);
    expect(ids).toContain(inScope);
    expect(ids).not.toContain(outOfScope);
  });

  it("a manager scoped to ZERO projects is refused GET /v1/projects with 403 project_out_of_scope, not an empty 'all projects' page", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    await createProject(workspace.id, "Any Project Co");

    const accessToken = await accessTokenForScopedManager(workspace.id, []);

    const res = await app.inject({
      method: "GET",
      url: apiUrl("/projects"),
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "project_out_of_scope" } });
  });

  it("a manager scoped to ONE project sees only that project's tasks on GET /v1/workspaces/{id}/action-items, over the real guard/interceptor/handler chain", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const inScope = await createProject(workspace.id, "In Scope Co");
    const outOfScope = await createProject(workspace.id, "Out Of Scope Co");

    const visibleTask = await db.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, impact_score, effort_band)
       VALUES ($1,$2,'VIS-1','content',$3,'visible','d','todo',50,'m') RETURNING id`,
      [workspace.id, inScope, createHash("sha256").update(`visible-${randomUUID()}`).digest()],
    );
    const hiddenTask = await db.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, impact_score, effort_band)
       VALUES ($1,$2,'HID-1','content',$3,'hidden','d','todo',50,'m') RETURNING id`,
      [workspace.id, outOfScope, createHash("sha256").update(`hidden-${randomUUID()}`).digest()],
    );

    const accessToken = await accessTokenForScopedManager(workspace.id, [inScope]);

    const res = await app.inject({
      method: "GET",
      url: apiUrl(`/workspaces/${workspace.id}/action-items`),
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
    });

    expect(res.statusCode).toBe(200);
    const items = dataOf<ActionItem[]>(res);
    const ids = items.map((item) => item.id);
    expect(ids).toContain(visibleTask.rows[0]!.id);
    expect(ids).not.toContain(hiddenTask.rows[0]!.id);
  });

  it("a manager scoped to ZERO projects is refused GET /v1/workspaces/{id}/action-items with 403 project_out_of_scope", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    await createProject(workspace.id, "Any Project Co");

    const accessToken = await accessTokenForScopedManager(workspace.id, []);

    const res = await app.inject({
      method: "GET",
      url: apiUrl(`/workspaces/${workspace.id}/action-items`),
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "project_out_of_scope" } });
  });
});
