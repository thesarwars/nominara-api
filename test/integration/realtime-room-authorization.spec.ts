import { randomUUID } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import { JOIN_PROJECT_MESSAGE, JOIN_WORKSPACE_MESSAGE } from "../../src/gateway/realtime.gateway.js";
import { ROOM_FORBIDDEN_CLOSE_CODE } from "../../src/gateway/room-authorization.service.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-026 T20 rows 1 and 2 — system-architecture.md §9: "Room join is
// authorised by the same WorkspaceGuard + RbacGuard chain as REST; a socket
// that cannot prove membership is disconnected with code 4403."
//
// Driven over a REAL socket against a REAL Postgres, because the property is
// end-to-end: a synthesised ExecutionContext feeding real guards, reading a
// real membership row. The unit tests assert the wiring is the same objects;
// only this asserts the wiring works.

const WRAPPING_KEY = Buffer.alloc(32, 9);

describe("STORY-026 · room authorisation over a real socket", () => {
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
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  /**
   * STORY-118 — the pooled connection the GATEWAY checks out of, as
   * deployed: nominara_app, never the migration owner.
   *
   * This file used to point DATABASE_URL_POOLED at the container superuser,
   * which bypasses RLS entirely — so `SELECT 1 FROM projects` with no tenant
   * context returned the row here and zero rows in every real deployment,
   * and RoomAuthorizationService refused every project-room join in
   * production while this suite stayed green. Same defect shape STORY-120
   * found in readiness. The subject of the test is now the thing that runs.
   */
  function runtimeRoleUri(): string {
    const password = encodeURIComponent(resolvePassword("nominara_app", {}));
    return `postgres://nominara_app:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;
  }

  beforeEach(async () => {
    applyFakeApiEnv();
    // DATABASE_URL stays the OWNER — migrations are DDL and never run as a
    // runtime role. Only the pooled connection becomes nominara_app.
    process.env.DATABASE_URL = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);
    // Migration 0005 deliberately sets no passwords (see its header).
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);

    process.env.DATABASE_URL_POOLED = runtimeRoleUri();

    // The FIXTURE pool stays the owner: seeding workspaces and sessions is
    // setup, not the behaviour under test.
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
    const address = app.getHttpServer().address() as { port: number };
    port = address.port;
  }, 120_000);

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

  /** A socket carrying the same access cookie the HTTP path would send. */
  function connect(accessToken: string, csrfToken = ""): ClientSocket {
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

  function joined(client: ClientSocket, workspaceId: string): Promise<{ joined: boolean; room?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("no reply to the join message within 5s"));
      }, 5_000);
      client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspaceId }, (reply: { joined: boolean; room?: string }) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  function disconnected(client: ClientSocket): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the socket was not disconnected within 5s"));
      }, 5_000);
      client.on("error", (payload: unknown) => {
        // The gateway sends the close code as a terminal frame first, because
        // socket.io's disconnect() carries no application close code.
        clearTimeout(timer);
        resolve(payload);
      });
      client.on("disconnect", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  // ---- row 1 -------------------------------------------------------------

  it("row 1 — a member joins its workspace room and the join is authorised end to end", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `RT ${randomUUID()}` }, meta);

    // A token PINNED to this workspace, which is what a real client carries
    // after switching into it. Room authorisation checks the pin against the
    // requested room and then re-reads membership live.
    const session = await sessions.createSession(ownerId);
    const pinned = await sessions.switchWorkspace(session.sid, ownerId, workspace.id, "owner", null, 1);

    const client = connect(pinned.accessToken, pinned.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const reply = await joined(client, workspace.id);

    expect(reply.joined, "an active member must be able to join its own room").toBe(true);
    expect(reply.room).toBe(`ws:${workspace.id}`);
    expect(client.connected).toBe(true);
  });

  it("row 1 — a token pinned to ANOTHER workspace cannot join this one", async () => {
    // "A token is never valid for two tenants." The caller is a genuine member
    // of the workspace they are pinned to; the room they asked for is not it.
    const ownerId = await createUser();
    const mine = await workspaces.create(ownerId, { name: `Mine ${randomUUID()}` }, meta);
    const otherOwner = await createUser();
    const theirs = await workspaces.create(otherOwner, { name: `Theirs ${randomUUID()}` }, meta);

    const session = await sessions.createSession(ownerId);
    const pinned = await sessions.switchWorkspace(session.sid, ownerId, mine.id, "owner", null, 1);

    const client = connect(pinned.accessToken, pinned.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const closure = disconnected(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: theirs.id });

    await closure;
    expect(client.connected).toBe(false);
  });

  // ---- row 2 -------------------------------------------------------------

  it("row 2 — a socket that cannot prove membership is DISCONNECTED, not merely refused", async () => {
    // The security property. An error reply that left the connection open
    // would let a client retry against every workspace id it liked, turning a
    // refused join into an enumeration oracle.
    const outsiderId = await createUser();
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Closed ${randomUUID()}` }, meta);

    const tokens = await sessions.createSession(outsiderId);
    const client = connect(tokens.accessToken, tokens.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const closure = disconnected(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id });

    await expect(closure).resolves.toBeDefined();
    expect(client.connected, "an unauthorised socket must not stay connected").toBe(false);
  });

  it("row 2 — an unauthenticated socket cannot join anything", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `NoAuth ${randomUUID()}` }, meta);

    const client = io(`http://127.0.0.1:${String(port)}/rt`, { transports: ["websocket"], reconnection: false });
    clients.push(client);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const closure = disconnected(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id });

    await expect(closure).resolves.toBeDefined();
    expect(client.connected).toBe(false);
  });

  it("row 2 — a join with no workspace id is refused rather than defaulting to one", async () => {
    const userId = await createUser();
    const tokens = await sessions.createSession(userId);
    const client = connect(tokens.accessToken, tokens.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const closure = disconnected(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, {});

    await closure;
    expect(client.connected, "a join with no workspace must not default to one").toBe(false);
  });

  it("uses §9's close code", () => {
    expect(ROOM_FORBIDDEN_CLOSE_CODE).toBe(4403);
  });

  // ---- each check, isolated ---------------------------------------------
  //
  // The two cases above are caught by SEVERAL things at once — WorkspaceGuard,
  // the token-pin check and the live-membership re-read all refuse an
  // outsider. That is defence in depth working, and it also means neither
  // check was independently tested: removing either one left the suite green.
  // Verified by mutation, which is why these two exist.

  it("refuses a room the token is not pinned to, even when the caller IS a member of it", async () => {
    // ONLY the pin check can refuse this: the caller is a genuine active
    // member of both workspaces, so membership passes. "A token is never valid
    // for two tenants" is exactly this case, and nothing else enforces it.
    const userId = await createUser();
    const mine = await workspaces.create(userId, { name: `Mine ${randomUUID()}` }, meta);

    const otherOwner = await createUser();
    const alsoMine = await workspaces.create(otherOwner, { name: `Joined ${randomUUID()}` }, meta);
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'admin','active')",
      [randomUUID(), alsoMine.id, userId],
    );

    const session = await sessions.createSession(userId);
    const pinned = await sessions.switchWorkspace(session.sid, userId, mine.id, "owner", null, 1);

    const client = connect(pinned.accessToken, pinned.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const closure = disconnected(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: alsoMine.id });

    await closure;
    expect(client.connected, "a token pinned to one tenant must not reach another").toBe(false);
  });

  it("refuses a member whose membership was revoked AFTER the token was minted", async () => {
    // ONLY the live-membership re-read can refuse this: the token is validly
    // pinned to this very workspace and is not expired. A token lives fifteen
    // minutes; security-and-tenancy.md §7 is explicit that revocation must not
    // wait for one. This is what makes the join read membership rather than
    // trust the claim.
    const ownerId = await createUser();
    const memberId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Revoked ${randomUUID()}` }, meta);
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'analyst','active')",
      [randomUUID(), workspace.id, memberId],
    );

    const session = await sessions.createSession(memberId);
    const pinned = await sessions.switchWorkspace(session.sid, memberId, workspace.id, "analyst", null, 1);

    // Revoked after the token exists, exactly as a removal mid-session would.
    await db.query("UPDATE workspace_members SET status = 'removed' WHERE workspace_id = $1 AND user_id = $2", [
      workspace.id,
      memberId,
    ]);

    const client = connect(pinned.accessToken, pinned.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const closure = disconnected(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id });

    await closure;
    expect(client.connected, "a valid token must not outlive the membership it describes").toBe(false);
  });
  // ---- STORY-118 · the project room, which nothing here reached ----------
  //
  // Every test above joins a WORKSPACE room. The project-room path had no
  // coverage at all, which is how RoomAuthorizationService.projectBelongsTo
  // shipped running on the pool with no tenant context — refusing every
  // project-room join as nominara_app while this file, on the superuser,
  // never asked. Both halves are asserted now: the join that must succeed,
  // and the one that must not.

  async function createProject(workspaceId: string): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [workspaceId, `Project ${randomUUID()}`, `p-${randomUUID()}`, "https://example.com", "example.com"],
    );
    return result.rows[0]!.id;
  }

  function joinedProject(client: ClientSocket, projectId: string): Promise<{ joined: boolean; room?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("no reply to the project join message within 5s"));
      }, 5_000);
      client.emit(JOIN_PROJECT_MESSAGE, { project_id: projectId }, (reply: { joined: boolean; room?: string }) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  it("STORY-118 — a member joins a project room in its own workspace", async () => {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `Proj ${randomUUID()}` }, meta);
    const projectId = await createProject(workspace.id);

    const session = await sessions.createSession(ownerId);
    const pinned = await sessions.switchWorkspace(session.sid, ownerId, workspace.id, "owner", null, 1);

    const client = connect(pinned.accessToken, pinned.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const reply = await joinedProject(client, projectId);

    // Before STORY-118 this was `false` in every deployment: the pairing
    // check ran with no tenant context, RLS matched nothing, and zero rows
    // read as "that project is not in your workspace".
    expect(reply.joined, "a member must be able to join a project room in its own workspace").toBe(true);
    expect(reply.room).toBe(`proj:${projectId}`);
    expect(client.connected).toBe(true);
  });

  it("STORY-118 — a project in ANOTHER workspace is still refused", async () => {
    // The context the fix adds is the caller's own, never the project's, so
    // a project outside it stays invisible. Without this the fix could have
    // been "widen until it passes", which is the resolution the story bans.
    const ownerId = await createUser();
    const mine = await workspaces.create(ownerId, { name: `Mine ${randomUUID()}` }, meta);
    const otherOwner = await createUser();
    const theirs = await workspaces.create(otherOwner, { name: `Theirs ${randomUUID()}` }, meta);
    const theirProject = await createProject(theirs.id);

    const session = await sessions.createSession(ownerId);
    const pinned = await sessions.switchWorkspace(session.sid, ownerId, mine.id, "owner", null, 1);

    const client = connect(pinned.accessToken, pinned.csrfToken);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const closure = disconnected(client);
    client.emit(JOIN_PROJECT_MESSAGE, { project_id: theirProject });

    await closure;
    expect(client.connected, "a project outside the pinned workspace must not be joinable").toBe(false);
  });
});
