import { randomUUID } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import {
  JOIN_PROJECT_MESSAGE,
  JOIN_WORKSPACE_MESSAGE,
  RealtimeGateway,
} from "../../src/gateway/realtime.gateway.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import {
  NoopRealtimePublisher,
  ValkeyRealtimePublisher,
  realtimeFanoutChannel,
} from "../../src/lib/cache/realtime-publisher.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { startValkey, type StartedValkey } from "../support/valkey-fixture.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-026 AC1 — project-scoped DELIVERY, over real sockets, real guards, a
// real Postgres and a real Valkey. "A scoped manager's socket never receives
// an out-of-scope project's event" is a promise about what arrives at a
// client, so it is asserted there — the unit spec covers the same rule with
// stub sockets.
//
// Every "did not receive" assertion RACES a deadline against an in-scope
// recipient's arrival: asserting silence without proving a frame could have
// been parsed is the vacuity this epic keeps producing.
const WRAPPING_KEY = Buffer.alloc(32, 9);

describe("STORY-026 AC1 · project_scope constrains what a socket RECEIVES", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let app: NestFastifyApplication;
  let workspaces: WorkspacesService;
  let sessions: SessionService;
  let port: number;
  let valkey: StartedValkey;
  let publisher: ValkeyRealtimePublisher;
  const originalEnv = { ...process.env };
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    valkey = await startValkey();
  }, 240_000);

  afterAll(async () => {
    await container.stop();
    await valkey.stop();
  });

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
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      membership,
      sessions,
      new NoopRealtimePublisher(),
    );

    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as { port: number }).port;
    app.get(RealtimeGateway).attachFanoutChannel(valkey.url, realtimeFanoutChannel(cacheKeyNamespace()));
    publisher = new ValkeyRealtimePublisher(valkey.url);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, 180_000);

  afterEach(async () => {
    await publisher.onModuleDestroy();
    for (const client of clients.splice(0)) client.close();
    await app.close();
    await pool.end();
    await db.end();
    process.env = { ...originalEnv };
  });

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function createUser(): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `rt-${randomUUID()}@example.com`,
    ]);
    return result.rows[0]!.id;
  }

  async function asWorkspace<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const result = await work();
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  async function createProject(workspaceId: string, name: string): Promise<string> {
    return asWorkspace(workspaceId, async () => {
      const result = await db.query<{ id: string }>(
        `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [workspaceId, name, `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`, "https://example.test", "example.test"],
      );
      return result.rows[0]!.id;
    });
  }

  async function addMember(
    workspaceId: string,
    userId: string,
    role: string,
    projectScope: readonly string[] | null,
  ): Promise<void> {
    await asWorkspace(workspaceId, async () => {
      await db.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role, project_scope, status) VALUES ($1, $2, $3, $4, 'active')",
        [workspaceId, userId, role, projectScope],
      );
    });
  }

  function connect(accessToken: string, csrfToken: string): ClientSocket {
    const client = io(`http://127.0.0.1:${String(port)}/rt`, {
      transports: ["websocket"],
      extraHeaders: { cookie: `${ACCESS_COOKIE_NAME}=${accessToken}; ${CSRF_COOKIE_NAME}=${csrfToken}` },
      auth: { csrf: csrfToken },
      reconnection: false,
    });
    clients.push(client);
    return client;
  }

  function ack<T>(client: ClientSocket, message: string, body: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${message} within 5s`)), 5_000);
      client.emit(message, body, (reply: T) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  /** A connected member at `role` scoped to `scope`, joined to the workspace room and to `projects`. */
  async function member(
    workspaceId: string,
    role: string,
    scope: readonly string[] | null,
    joinProjects: readonly string[],
  ): Promise<ClientSocket> {
    const userId = await createUser();
    await addMember(workspaceId, userId, role, scope);
    const session = await sessions.createSession(userId);
    const pinned = await sessions.switchWorkspace(session.sid, userId, workspaceId, role, scope ?? null, 1);
    const client = connect(pinned.accessToken, pinned.csrfToken);
    await ack(client, JOIN_WORKSPACE_MESSAGE, { workspace_id: workspaceId });
    for (const projectId of joinProjects) {
      await expect(ack<{ joined: boolean }>(client, JOIN_PROJECT_MESSAGE, { project_id: projectId })).resolves.toMatchObject({
        joined: true,
      });
    }
    return client;
  }

  /** Resolves "arrived" on the first frame of `event`, else "quiet" at the deadline. */
  function verdict(client: ClientSocket, event: string, deadlineMs: number): Promise<"arrived" | "quiet"> {
    return new Promise((resolve) => {
      client.on(event, () => resolve("arrived"));
      setTimeout(() => resolve("quiet"), deadlineMs);
    });
  }

  async function workspaceWithTwoProjects() {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `RT ${randomUUID()}` }, meta);
    const a = await createProject(workspace.id, "Alpha");
    const b = await createProject(workspace.id, "Beta");
    return { workspaceId: workspace.id, a, b };
  }

  it("a manager scoped to project A receives A's event and never B's, published with toProject", async () => {
    const { workspaceId, a, b } = await workspaceWithTwoProjects();
    const scoped = await member(workspaceId, "manager", [a], [a]);

    const sawB = verdict(scoped, "task.created", 1_500);
    const sawA = new Promise<"arrived">((resolve) => {
      scoped.on("task.moved", () => resolve("arrived"));
    });

    publisher.toProject(workspaceId, b, "task.created", { task_id: randomUUID(), project_id: b });
    publisher.toProject(workspaceId, a, "task.moved", { task_id: randomUUID(), project_id: a });

    await expect(sawA, "the in-scope event must arrive, or the silence below proves nothing").resolves.toBe("arrived");
    await expect(sawB, "an out-of-scope project's event must never reach a scoped manager").resolves.toBe("quiet");
  }, 30_000);

  it("a producer that used toWorkspace for a project event cannot leak it to a scoped manager", async () => {
    const { workspaceId, a, b } = await workspaceWithTwoProjects();
    const scoped = await member(workspaceId, "manager", [a], [a]);
    const unrestricted = await member(workspaceId, "admin", null, [b]);

    const scopedSaw = verdict(scoped, "task.created", 1_500);
    const adminSaw = verdict(unrestricted, "task.created", 3_000);

    publisher.toWorkspace(workspaceId, "task.created", { task_id: randomUUID(), project_id: b });

    await expect(adminSaw, "a socket that holds B's room receives it").resolves.toBe("arrived");
    await expect(scopedSaw).resolves.toBe("quiet");
  }, 30_000);

  it("workspace-level events still reach a scoped manager", async () => {
    const { workspaceId, a } = await workspaceWithTwoProjects();
    const scoped = await member(workspaceId, "manager", [a], [a]);
    const saw = verdict(scoped, "credits.depleted", 5_000);
    publisher.toWorkspace(workspaceId, "credits.depleted", {
      cycle_end: "2026-11-01T00:00:00.000Z",
      scheduled_scans_unaffected: true,
      packs: [],
    } as never);
    await expect(saw).resolves.toBe("arrived");
  }, 30_000);

  it("another workspace's socket never receives a project event, even one that holds a project room of its own", async () => {
    const mine = await workspaceWithTwoProjects();
    const theirs = await workspaceWithTwoProjects();
    const intended = await member(mine.workspaceId, "admin", null, [mine.a]);
    const stranger = await member(theirs.workspaceId, "admin", null, [theirs.a]);

    const strangerSaw = verdict(stranger, "task.created", 1_500);
    const intendedSaw = verdict(intended, "task.created", 3_000);

    publisher.toProject(mine.workspaceId, mine.a, "task.created", { task_id: randomUUID(), project_id: mine.a });

    await expect(intendedSaw).resolves.toBe("arrived");
    await expect(strangerSaw).resolves.toBe("quiet");
  }, 30_000);
});
