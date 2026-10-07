import { randomUUID } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import { JOIN_WORKSPACE_MESSAGE, RealtimeGateway } from "../../src/gateway/realtime.gateway.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { NoopRealtimePublisher, ValkeyRealtimePublisher, realtimeFanoutChannel } from "../../src/lib/cache/realtime-publisher.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { createTaskRequestSchema } from "../../contracts/tasks/index.js";
import { startValkey, type StartedValkey } from "../support/valkey-fixture.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-064 (step D) — room scoping of task.moved / task.created over the path
// events actually take: TasksService -> ValkeyRealtimePublisher -> fan-out channel
// -> gateway -> authenticated sockets (the STORY-026 #1/#2 pattern). A second
// workspace's socket must receive NOTHING.
const WRAPPING_KEY = Buffer.alloc(32, 10);

describe("STORY-064-D · task events are delivered to the workspace room only", () => {
  let container: StartedPostgreSqlContainer;
  let valkey: StartedValkey;
  let db: Client;
  let pool: Pool;
  let app: NestFastifyApplication;
  let workspaces: WorkspacesService;
  let sessions: SessionService;
  let publisher: ValkeyRealtimePublisher;
  let tasks: TasksService;
  let port: number;
  const originalEnv = { ...process.env };
  const clients: ClientSocket[] = [];
  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    valkey = await startValkey();
  }, 240_000);
  afterAll(async () => { await container.stop(); await valkey.stop(); });

  beforeEach(async () => {
    applyFakeApiEnv();
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
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(WRAPPING_KEY, "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());

    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as { port: number }).port;
    app.get(RealtimeGateway).attachFanoutChannel(valkey.url, realtimeFanoutChannel(cacheKeyNamespace()));
    publisher = new ValkeyRealtimePublisher(valkey.url);
    tasks = new TasksService(publisher);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, 180_000);

  afterEach(async () => {
    await publisher.onModuleDestroy();
    for (const c of clients.splice(0)) c.close();
    await app.close();
    await pool.end();
    await db.end();
    process.env = { ...originalEnv };
  });

  async function joined(): Promise<{ workspaceId: string; userId: string; projectId: string; client: ClientSocket }> {
    const u = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`rt-${randomUUID()}@example.com`]);
    const userId = u.rows[0]!.id;
    const workspace = await workspaces.create(userId, { name: `RT ${randomUUID()}` }, meta);
    const session = await sessions.createSession(userId);
    const pinned = await sessions.switchWorkspace(session.sid, userId, workspace.id, "owner", null, 1);
    const client = io(`http://127.0.0.1:${String(port)}/rt`, {
      transports: ["websocket"],
      extraHeaders: { cookie: `${ACCESS_COOKIE_NAME}=${pinned.accessToken}; ${CSRF_COOKIE_NAME}=${pinned.csrfToken}` },
      auth: { csrf: pinned.csrfToken },
      reconnection: false,
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply to join:workspace within 5s")), 5_000);
      client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id }, () => { clearTimeout(timer); resolve(); });
    });
    const p = await db.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, 'Rooms', $2, 'https://example.com', $3) RETURNING id`,
      [workspace.id, `rooms-${randomUUID()}`, `${randomUUID()}.example.com`]);
    return { workspaceId: workspace.id, userId, projectId: p.rows[0]!.id, client };
  }

  const inTenant = <T>(workspaceId: string, actorId: string, fn: () => Promise<T>) => withTenantContext(db, { workspaceId, actorId }, fn);
  const collect = (c: ClientSocket, event: string): unknown[] => { const seen: unknown[] = []; c.on(event, (p: unknown) => seen.push(p)); return seen; };
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("[STORY-064-D] task.created and task.moved (complete) reach the owning workspace's socket, and another workspace's socket receives nothing", async () => {
    const mine = await joined();
    const theirs = await joined();
    const myCreated = collect(mine.client, "task.created"); const myMoved = collect(mine.client, "task.moved");
    const theirCreated = collect(theirs.client, "task.created"); const theirMoved = collect(theirs.client, "task.moved");

    const task = await inTenant(mine.workspaceId, mine.userId, () => tasks.createTask(mine.projectId, createTaskRequestSchema.parse({ title: "Room test" })));
    await inTenant(mine.workspaceId, mine.userId, () => tasks.completeTask(task.id));

    await settle(1_500);
    expect(myCreated).toEqual([{ task_id: task.id, project_id: mine.projectId, status: "todo", title: "Room test", priority: String(task.priority), impact_score: task.impact_score, rule_code: null }]);
    expect(myMoved).toEqual([{ task_id: task.id, project_id: mine.projectId, from_status: "todo", to_status: "done", actor_id: mine.userId }]);
    expect(theirCreated, "another workspace's socket must receive nothing").toEqual([]);
    expect(theirMoved, "another workspace's socket must receive nothing").toEqual([]);
  }, 60_000);
});
