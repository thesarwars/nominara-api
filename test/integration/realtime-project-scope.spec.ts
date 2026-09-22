import { randomUUID } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import { JOIN_PROJECT_MESSAGE, JOIN_WORKSPACE_MESSAGE } from "../../src/gateway/realtime.gateway.js";
import { ROOM_FORBIDDEN_CLOSE_CODE, projectRoom } from "../../src/gateway/room-authorization.service.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-026 AC1 + the RbacGuard hole the review found — and they are ONE
// defect, not two.
//
// `RbacGuard` ran on the socket path but could never refuse: the synthesised
// ExecutionContext carried no `@RequirePermission` metadata, so the guard
// returned true before it ever read the request, `assertInScope` never ran,
// and `workspace_members.project_scope` had NO EFFECT ON REALTIME. A manager
// scoped to one project received every project's events.
//
// It could not be fixed where it was found. §6 makes `project:read` SCOPED
// for manager and viewer, so enforcing scope needs a room that names a
// project — and `projectRoom()` was exported and called by nothing, with no
// `join:project` message anywhere. AC1's project rooms are the mechanism the
// scope check needs to exist at all.
//
// Driven over a real socket against real Postgres and real guards, because
// that is the only place the property is true or false.
const WRAPPING_KEY = Buffer.alloc(32, 9);

describe("STORY-026 · project rooms enforce workspace_members.project_scope", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let app: NestFastifyApplication;
  let workspaces: WorkspacesService;
  let sessions: SessionService;
  let port: number;
  const originalEnv = { ...process.env };
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
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
    sessions = new SessionService(pool);
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      new MembershipService(new MembershipCacheService()),
      sessions,
      new NoopRealtimePublisher(),
    );

    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.getHttpServer().address() as { port: number }).port;
  }, 180_000);

  afterEach(async () => {
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

  /**
   * These tables FORCE row-level security, so a direct write needs the tenant
   * GUC set — and it must be SET LOCAL (`set_config(..., true)`), inside a
   * transaction. Session scope leaks across pooled connections under pgBouncer
   * transaction pooling, which this repository lints against for exactly that
   * reason; a test that set it session-wide would be modelling a connection
   * the application never has.
   */
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

  /** A member with an explicit role and project scope — `null` means unrestricted. */
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
      extraHeaders: {
        cookie: `${ACCESS_COOKIE_NAME}=${accessToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
      },
      // STORY-026 — the handshake now carries the double-submit token, the
      // same as any other cookie-authenticated request. socket.io puts it in
      // `auth` because a browser cannot set a header on a WebSocket
      // handshake; the server copies it into the header slot AuthGuard
      // already reads.
      auth: { csrf: csrfToken },
      reconnection: false,
    });
    clients.push(client);
    return client;
  }

  function joinProject(client: ClientSocket, projectId: string): Promise<{ joined: boolean; room?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply to join:project within 5s")), 5_000);
      client.emit(JOIN_PROJECT_MESSAGE, { project_id: projectId }, (reply: { joined: boolean; room?: string }) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  function refused(client: ClientSocket): Promise<{ close_code?: number } | undefined> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the socket was not refused within 5s")), 5_000);
      client.on("error", (payload: { close_code?: number }) => {
        clearTimeout(timer);
        resolve(payload);
      });
      client.on("disconnect", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  /** Owner + workspace + two projects + a member at `role` scoped to `scope`. */
  async function scenario(role: string, scopeToFirst: readonly string[] | null | "first") {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `RT ${randomUUID()}` }, meta);
    const mine = await createProject(workspace.id, "Mine");
    const theirs = await createProject(workspace.id, "Theirs");

    const memberId = await createUser();
    const scope = scopeToFirst === "first" ? [mine] : scopeToFirst;
    await addMember(workspace.id, memberId, role, scope);

    const session = await sessions.createSession(memberId);
    const pinned = await sessions.switchWorkspace(session.sid, memberId, workspace.id, role, scope ?? null, 1);
    return { workspace, mine, theirs, client: connect(pinned.accessToken, pinned.csrfToken) };
  }

  // The setup guard. If project_scope is not actually persisted, every
  // "refused" below would pass for the wrong reason.
  it("the fixture really does persist a narrowed project_scope", async () => {
    const { workspace, mine } = await scenario("manager", "first");
    const row = await asWorkspace(workspace.id, async () =>
      db.query<{ project_scope: string[] | null }>(
        "SELECT project_scope FROM workspace_members WHERE workspace_id = $1 AND role = 'manager'",
        [workspace.id],
      ),
    );
    expect(row.rows[0]!.project_scope).toEqual([mine]);
  });

  it("a manager scoped to one project joins that project's room", async () => {
    const { mine, client } = await scenario("manager", "first");
    const reply = await joinProject(client, mine);
    expect(reply.joined).toBe(true);
    expect(reply.room).toBe(projectRoom(mine));
  });

  // THE DEFECT. Before project rooms and the permission metadata existed,
  // there was no join to refuse and no scope check to run — this member
  // received every project's events through the workspace room.
  // ⚠ STORY-150 review — THE ONLY PRODUCTION PATH WHERE `assertInScope` READS
  // A PARAM, AND THE ONE STORY-150 ORIGINALLY EXCLUDED.
  //
  // `@ProjectParam` appears on ZERO controllers, so the HTTP guard added by
  // that story never reaches this check in production; this join does. The
  // client sends `project_id` verbatim, and it is used TWICE — as the param
  // `RbacGuard` compares against a scope list read from Postgres (lowercase),
  // and as the room name a publisher will later address.
  //
  // So an uppercase id refused a scoped manager THEIR OWN project's room with
  // a 4403. And for an unrestricted member it did something quieter and worse:
  // `assertInScope` returns early, the ownership read casts to `uuid` and
  // passes, and the socket joins `proj:A0EE…` — a room no publisher will ever
  // match. Latent only while nothing publishes to project rooms.
  it("STORY-150 — an UPPERCASE project id joins the same room a lowercase one does", async () => {
    const { mine, client } = await scenario("manager", "first");
    const reply = await joinProject(client, mine.toUpperCase());

    expect(reply.joined, "a scoped manager must not be refused their own project for typing it in capitals").toBe(true);
    // The room name is the sharp half: a room named from the uppercase id is
    // one no publisher addresses.
    expect(reply.room).toBe(projectRoom(mine));
  });

  it("a manager scoped to one project is REFUSED another project's room, and disconnected", async () => {
    const { theirs, client } = await scenario("manager", "first");
    const closed = refused(client);
    client.emit(JOIN_PROJECT_MESSAGE, { project_id: theirs });
    await expect(closed).resolves.toMatchObject({ close_code: ROOM_FORBIDDEN_CLOSE_CODE });
  });

  // `project_scope IS NULL` is unrestricted — a distinct state from an empty
  // array, and RbacGuard.assertInScope draws exactly that line.
  it("an unrestricted member joins any project room in its workspace", async () => {
    const { mine, theirs, client } = await scenario("admin", null);
    await expect(joinProject(client, mine)).resolves.toMatchObject({ joined: true });
    await expect(joinProject(client, theirs)).resolves.toMatchObject({ joined: true });
  });

  // The other half of that line: scoped to ZERO projects refuses everything.
  // A guard that collapsed empty and null would silently widen this member to
  // full access.
  it("a member scoped to zero projects joins no project room at all", async () => {
    const { mine, client } = await scenario("manager", []);
    const closed = refused(client);
    client.emit(JOIN_PROJECT_MESSAGE, { project_id: mine });
    await expect(closed).resolves.toMatchObject({ close_code: ROOM_FORBIDDEN_CLOSE_CODE });
  });

  it("a project in ANOTHER workspace is refused even to an unrestricted member", async () => {
    const { client } = await scenario("admin", null);
    const strangerOwner = await createUser();
    const strangerWorkspace = await workspaces.create(strangerOwner, { name: `Other ${randomUUID()}` }, meta);
    const strangerProject = await createProject(strangerWorkspace.id, "Stranger");

    const closed = refused(client);
    client.emit(JOIN_PROJECT_MESSAGE, { project_id: strangerProject });
    await expect(closed).resolves.toMatchObject({ close_code: ROOM_FORBIDDEN_CLOSE_CODE });
  });

  // The workspace join must keep working — the permission metadata added for
  // project rooms is attached per join type, not globally.
  it("join:workspace still succeeds for the same member", async () => {
    const { workspace, client } = await scenario("manager", "first");
    const reply = await new Promise<{ joined: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply to join:workspace within 5s")), 5_000);
      client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id }, (r: { joined: boolean }) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    expect(reply.joined).toBe(true);
  });
});
