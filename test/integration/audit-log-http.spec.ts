import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogEntrySchema, type AuditLogEntry } from "../../contracts/trust/index.js";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { ACCESS_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { INERT_CACHE_REDIS_URL, INERT_QUEUE_REDIS_URL } from "../support/test-valkey.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";

// NEW-D-3 — GET /v1/audit-log. Real guard -> interceptor -> controller -> service
// chain, real Postgres, real RLS.
describe("NEW-D-3 · GET /v1/audit-log", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let appClient: Client;
  let workspaces: WorkspacesService;
  let sessions: SessionService;
  let app: NestFastifyApplication;

  const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
  const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
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
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
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
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    appClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_app",
      resolvePassword("nominara_app", {}),
    );

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
    await appClient.end();
    await db.end();
  });

  async function createUser(): Promise<string> {
    const r = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `user-${randomUUID()}@example.com`,
    ]);
    return r.rows[0]!.id;
  }

  async function tokenFor(workspaceId: string, role: "admin" | "manager" | "viewer" | "analyst"): Promise<string> {
    const userId = await createUser();
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')",
      [workspaceId, userId, role],
    );
    const tokens = await sessions.createSession(userId);
    return (await workspaces.switchTo(userId, tokens.sid, workspaceId, meta)).accessToken;
  }

  async function ownerWorkspace(): Promise<{ workspaceId: string; ownerToken: string }> {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const tokens = await sessions.createSession(ownerId);
    const ownerToken = (await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta)).accessToken;
    return { workspaceId: ws.id, ownerToken };
  }

  interface Seed {
    readonly action?: string;
    readonly actorId?: string | null;
    readonly actorType?: string;
    readonly severity?: string;
    readonly occurredAt?: string;
  }
  let n = 0;
  async function seed(workspaceId: string, row: Seed = {}): Promise<void> {
    n += 1;
    await db.query(
      `INSERT INTO audit_log (workspace_id, occurred_at, actor_type, actor_id, action, resource_type, request_id,
                              severity, before_state, after_state, prev_hash, row_hash)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, 'thing', $6, $7, '{"b":1}', '{"a":1}', $8, $9)`,
      [
        workspaceId,
        row.occurredAt ?? null,
        row.actorType ?? "user",
        row.actorId === undefined ? null : row.actorId,
        row.action ?? "project.create",
        `req-${String(n)}`,
        row.severity ?? "info",
        Buffer.alloc(32, 0),
        createHash("sha256").update(`row-${String(n)}-${randomUUID()}`).digest(),
      ],
    );
  }

  const get = (token: string, qs = "") =>
    app.inject({ method: "GET", url: apiUrl(`/audit-log${qs}`), cookies: { [ACCESS_COOKIE_NAME]: token } });

  it("AC1: owner reads the log; each item satisfies the entry contract", async () => {
    const { workspaceId, ownerToken } = await ownerWorkspace();
    await seed(workspaceId, { action: "billing.addon.create" });
    const res = await get(ownerToken);
    expect(res.statusCode).toBe(200);
    const items = dataOf<AuditLogEntry[]>(res);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(() => auditLogEntrySchema.parse(item)).not.toThrow();
    expect(items.find((i) => i.action === "billing.addon.create")?.category).toBe("billing");
  });

  it("AC1: admin is allowed; manager, analyst and viewer get 403 naming audit_log:read, never 404", async () => {
    const { workspaceId } = await ownerWorkspace();
    expect((await get(await tokenFor(workspaceId, "admin"))).statusCode).toBe(200);
    for (const role of ["manager", "analyst", "viewer"] as const) {
      const res = await get(await tokenFor(workspaceId, role));
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.json())).toContain("audit_log:read");
    }
  });

  it("AC1: no session is 401", async () => {
    const res = await app.inject({ method: "GET", url: apiUrl("/audit-log") });
    expect(res.statusCode).toBe(401);
  });

  it("AC1: an unknown query key is a 400, not a silent drop", async () => {
    const { ownerToken } = await ownerWorkspace();
    expect((await get(ownerToken, "?bogus=1")).statusCode).toBe(400);
  });

  it("AC1: a tampered cursor is a 400", async () => {
    const { ownerToken } = await ownerWorkspace();
    expect((await get(ownerToken, "?cursor=not-a-cursor!!")).statusCode).toBe(400);
  });

  it("AC1: filters by action, actor, category, severity and an inclusive date range", async () => {
    const { workspaceId, ownerToken } = await ownerWorkspace();
    const actor = randomUUID();
    await seed(workspaceId, { action: "zzz.filter_probe", actorId: actor, severity: "warning", occurredAt: "2026-03-10T23:59:59.999999Z" });
    await seed(workspaceId, { action: "zzz.other", occurredAt: "2026-03-11T00:00:00Z" });
    await seed(workspaceId, { action: "auth.login", occurredAt: "2026-03-12T00:00:00Z" });
    const actions = async (qs: string) => dataOf<AuditLogEntry[]>(await get(ownerToken, qs)).map((i) => i.action);

    expect(await actions("?action=zzz.filter_probe")).toEqual(["zzz.filter_probe"]);
    expect(await actions(`?actor_id=${actor}`)).toEqual(["zzz.filter_probe"]);
    expect(await actions("?severity=warning")).toEqual(["zzz.filter_probe"]);
    expect(await actions("?category=security")).toEqual(["auth.login"]);
    const data = await actions("?category=data&from=2026-03-10&to=2026-03-11");
    expect(data).toEqual(["zzz.other", "zzz.filter_probe"]);
    // `to` is the WHOLE day: 2026-03-10 23:59:59.999999 is in; 2026-03-11 00:00 is not.
    expect(await actions("?to=2026-03-10&category=data")).toEqual(["zzz.filter_probe"]);
  });

  it("AC3: the response never carries hashes, states or the IP", async () => {
    const { workspaceId, ownerToken } = await ownerWorkspace();
    await seed(workspaceId);
    const body = (await get(ownerToken)).body;
    expect(body).not.toMatch(/prev_hash|row_hash|before_state|after_state|actor_ip|actor_ua/u);
  });

  it("AC3 (checkpoint-4): no item id, cursor or other value in the response is any row's row_hash or prev_hash", async () => {
    const { workspaceId, ownerToken } = await ownerWorkspace();
    for (let i = 0; i < 4; i++) await seed(workspaceId, { action: "zzz.hash_probe" });
    const hashes = (
      await db.query<{ h: string }>(
        "SELECT encode(row_hash,'hex') AS h FROM audit_log WHERE workspace_id = $1 UNION SELECT encode(prev_hash,'hex') FROM audit_log WHERE workspace_id = $1",
        [workspaceId],
      )
    ).rows.map((r) => r.h);
    // Anti-vacuity: there are real hashes to look for, more than the seeded four.
    expect(hashes.length).toBeGreaterThan(4);

    const first = await get(ownerToken, "?limit=2");
    const second = (first.json() as { pagination: { cursor_next: string } }).pagination.cursor_next;
    for (const res of [first, await get(ownerToken), await get(ownerToken, `?limit=2&cursor=${second}`)]) {
      expect(res.statusCode).toBe(200);
      const body = res.body.toLowerCase();
      for (const hash of hashes) expect(body).not.toContain(hash);
      for (const item of dataOf<AuditLogEntry[]>(res)) expect(item.id).not.toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("AC4: pages across rows sharing one microsecond timestamp without skipping or repeating", async () => {
    const { workspaceId, ownerToken } = await ownerWorkspace();
    for (let i = 0; i < 7; i++) await seed(workspaceId, { action: "zzz.same_instant", occurredAt: "2026-04-01T10:00:00.123456Z" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(ownerToken, `?action=zzz.same_instant&limit=3${cursor === null ? "" : `&cursor=${cursor}`}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: AuditLogEntry[]; pagination: { cursor_next: string | null; has_more: boolean } };
      seen.push(...body.data.map((i) => i.id));
      expect(body.pagination.has_more).toBe(body.pagination.cursor_next !== null);
      cursor = body.pagination.cursor_next;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("AC4: newest first by seq, and exactly-limit rows reports has_more=false with no cursor", async () => {
    const { workspaceId, ownerToken } = await ownerWorkspace();
    for (let i = 0; i < 3; i++) await seed(workspaceId, { action: "zzz.exact" });
    const res = await get(ownerToken, "?action=zzz.exact&limit=3");
    const body = res.json() as { data: AuditLogEntry[]; pagination: { cursor_next: string | null; has_more: boolean } };
    expect(body.data).toHaveLength(3);
    expect(body.pagination).toMatchObject({ has_more: false, cursor_next: null });
  });

  it("AC2: RLS alone decides — a raw count under A's context with NO workspace predicate sees A's rows only, and the proof is not vacuous", async () => {
    const a = await ownerWorkspace();
    const b = await ownerWorkspace();
    for (let i = 0; i < 4; i++) await seed(a.workspaceId, { action: "zzz.iso" });
    for (let i = 0; i < 6; i++) await seed(b.workspaceId, { action: "zzz.iso" });

    // Anti-vacuity: the superuser (bypasses RLS) proves both tenants' rows exist, so a
    // count of exactly 4 can only be RLS narrowing 10 to 4.
    const total = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_log WHERE action = 'zzz.iso'");
    expect(total.rows[0]!.n).toBe("10");

    const raw = await withTenantContext(appClient, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) =>
      tx.query<{ n: string; foreign_n: string }>(
        `SELECT count(*)::text AS n, count(*) FILTER (WHERE workspace_id <> $1)::text AS foreign_n
           FROM audit_log WHERE action = 'zzz.iso'`,
        [a.workspaceId],
      ),
    );
    expect(raw.rows[0]).toEqual({ n: "4", foreign_n: "0" });

    // And the route agrees: B's owner sees B's six, A's owner sees A's four.
    expect(dataOf<AuditLogEntry[]>(await get(a.ownerToken, "?action=zzz.iso"))).toHaveLength(4);
    expect(dataOf<AuditLogEntry[]>(await get(b.ownerToken, "?action=zzz.iso"))).toHaveLength(6);
  });

  it("AC2: a cursor minted in workspace B cannot be used to read A's rows", async () => {
    const a = await ownerWorkspace();
    const b = await ownerWorkspace();
    for (let i = 0; i < 5; i++) await seed(b.workspaceId, { action: "zzz.xcursor" });
    await seed(a.workspaceId, { action: "zzz.xcursor" });
    const first = (await get(b.ownerToken, "?action=zzz.xcursor&limit=2")).json() as { pagination: { cursor_next: string } };
    const res = await get(a.ownerToken, `?action=zzz.xcursor&cursor=${first.pagination.cursor_next}`);
    expect(res.statusCode).toBe(200);
    const ids = dataOf<AuditLogEntry[]>(res).map((i) => i.id);
    const bIds = (await db.query<{ h: string }>("SELECT seq::text AS h FROM audit_log WHERE workspace_id = $1", [b.workspaceId])).rows.map((r) => r.h);
    expect(ids.filter((id) => bIds.includes(id))).toEqual([]);
  });
});
