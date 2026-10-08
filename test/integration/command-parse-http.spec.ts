import { randomUUID } from "node:crypto";
import { INERT_CACHE_REDIS_URL, INERT_QUEUE_REDIS_URL } from "../support/test-valkey.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { apiUrl } from "../support/api-url.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { RATE_LIMIT_HEADERS } from "../../contracts/common/rate-limit.schema.js";
import { COMMAND_INTENTS } from "../../contracts/command/command-intent.schema.js";
import { RATE_LIMIT_DEFAULTS } from "../../src/api/rate-limit/defaults.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";


// STORY-085-A checkpoint-1 audit [blocker] — POST /v1/command/parse answered
// 500 on every live request: a POST with no @Audit() makes AuditInterceptor
// throw AuditMetadataMissingError. Every earlier test called the service or
// controller directly, so nothing drove the real guard -> interceptor ->
// handler chain. This one does, as each role.
//
// "A parse never mutates and never enqueues external work" (FR-NL-04) is
// asserted here against the database and the queue producer, across every
// canonical intent: the ONLY row a parse may add is its audit row.
describe("STORY-085-A audit · POST /v1/command/parse over the real guard/interceptor/handler chain", () => {
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
    process.env.VALKEY_CACHE_URL = INERT_CACHE_REDIS_URL;
    process.env.QUEUE_REDIS_URL = INERT_QUEUE_REDIS_URL;
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

  type Cookie = { accessToken: string; csrfToken: string };
  const ROLES = ["owner", "admin", "manager", "analyst", "viewer"] as const;

  async function tokenForRole(workspaceId: string, ownerId: string, role: (typeof ROLES)[number]): Promise<Cookie> {
    if (role === "owner") {
      const tokens = await sessions.createSession(ownerId);
      return workspaces.switchTo(ownerId, tokens.sid, workspaceId, meta);
    }
    const userId = await createUser();
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspaceId, userId, role]);
    const tokens = await sessions.createSession(userId);
    return workspaces.switchTo(userId, tokens.sid, workspaceId, meta);
  }

  /**
   * A content fingerprint of every public table, so an UPDATE or a DELETE+INSERT
   * of the same count shows up, not only a row-count change. audit_log is
   * measured separately: it is the one table a parse may append to.
   */
  async function tableState(): Promise<Record<string, { rows: number; digest: string }>> {
    const tables = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    const state: Record<string, { rows: number; digest: string }> = {};
    for (const { tablename } of tables.rows) {
      const result = await db.query<{ n: string; digest: string }>(
        `SELECT count(*)::text AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM "${tablename}" t`,
      );
      state[tablename] = { rows: Number(result.rows[0]!.n), digest: result.rows[0]!.digest };
    }
    return state;
  }

  const commandParse = RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === "command_parse")!;

  const PHRASES = [
    "filter prompts about pricing",
    "compare acme with globex",
    "go to settings",
    "run visibility scan on acme",
    "run prompt research for acme",
    "run competitor finder for acme",
    "run aux audit for acme",
    "run deep scan on acme",
    "create a new project called acme",
    "create a task to fix schema markup",
    "show tasks",
    "build a report for acme",
    "explain visibility score",
    "invite jo@example.com as viewer",
    "order me a pizza",
    "create new",
  ];

  function parse(token: Cookie, query: string) {
    return app.inject({
      method: "POST",
      url: apiUrl("/command/parse"),
      headers: { cookie: `${ACCESS_COOKIE_NAME}=${token.accessToken}; ${CSRF_COOKIE_NAME}=${token.csrfToken}`, [CSRF_HEADER_NAME]: token.csrfToken },
      payload: { query },
    });
  }

  it("STORY-085-A audit #1: every role gets 200 with the envelope, the command_parse bucket (120/min, burst 30) and a 0-credit answer", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    for (const role of ROLES) {
      const res = await parse(await tokenForRole(workspace.id, ownerId, role), "run deep scan on acme");
      expect(res.statusCode, role).toBe(200);
      const body = res.json() as { data: { intent: string; cost: { credits: number } }; meta: { request_id: string } };
      expect(body.meta.request_id, role).toBeTruthy();
      expect(body.data.intent, role).toBe("run_deep_scan");
      expect(body.data.cost, role).toEqual({ credits: 0 });
      // The header advertises the bucket's CAPACITY in tokens (buckets.ts: the
      // burst), alongside `remaining`; the 120/min is its refill rate.
      expect(res.headers[RATE_LIMIT_HEADERS.limit.toLowerCase()], role).toBe(String(commandParse.burst));
    }
  });

  it("STORY-085-A audit #1: across every intent plus unresolved and ambiguous input, no table's CONTENT changes except audit_log's one appended row, and nothing is enqueued", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const token = await tokenForRole(workspace.id, ownerId, "owner");
    expect(PHRASES.length).toBe(COMMAND_INTENTS.length + 2);

    const producer = app.get(QueueProducer, { strict: false });
    const enqueue = vi.spyOn(producer, "enqueueTenantJob");
    const dispatch = vi.spyOn(producer, "dispatchPlannedCells");

    for (const phrase of PHRASES) {
      const before = await tableState();
      const res = await parse(token, phrase);
      expect(res.statusCode, phrase).toBe(200);
      const after = await tableState();
      const changed = Object.keys(after).filter((table) => after[table]!.digest !== before[table]!.digest);
      // Exactly one table changed, it is audit_log, and it only gained one row.
      expect(changed, phrase).toEqual(["audit_log"]);
      expect(after.audit_log!.rows, phrase).toBe(before.audit_log!.rows + 1);
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("STORY-085-A audit #1: the audit row is command.parsed on the caller's workspace", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const res = await parse(await tokenForRole(workspace.id, ownerId, "owner"), "invite secret.person@example.com as viewer");
    expect(res.statusCode).toBe(200);
    const rows = await db.query<{ action: string; resource_type: string; resource_id: string; before_state: unknown }>(
      "SELECT action, resource_type, resource_id, before_state FROM audit_log WHERE workspace_id = $1 AND action = 'command.parsed'",
      [workspace.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ resource_type: "workspace", resource_id: workspace.id, before_state: null });
  });

  // The phrases are deliberately SHORT and low-entropy: redactState only strips
  // long high-entropy strings, so these survive it unless the row never holds
  // them. (The earlier long address passed this test vacuously.)
  it.each([
    ["invite jo@acme.io as viewer", ["jo@acme.io", "acme.io"]],
    ["create a task to fire jane doe for misconduct", ["jane doe", "misconduct"]],
    ["compare acme with globex", ["acme", "globex"]],
    ["order me a pizza", ["pizza"]],
  ] as const)("STORY-085-A CP2 audit: the audit row for %j holds the outcome only, none of the customer's text", async (phrase, secrets) => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const res = await parse(await tokenForRole(workspace.id, ownerId, "owner"), phrase);
    expect(res.statusCode).toBe(200);
    const rows = await db.query<{ before_state: unknown; after_state: Record<string, unknown> }>(
      "SELECT before_state, after_state FROM audit_log WHERE workspace_id = $1 AND action = 'command.parsed'",
      [workspace.id],
    );
    expect(rows.rows).toHaveLength(1);
    const { before_state, after_state } = rows.rows[0]!;
    expect(before_state).toBeNull();
    expect(Object.keys(after_state).sort()).toEqual(["cached", "confidence", "intent", "resolved_by"]);
    const stored = JSON.stringify(rows.rows[0]);
    for (const secret of secrets) expect(stored, secret).not.toContain(secret);
  });
});
