import { randomUUID } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import { JOIN_WORKSPACE_MESSAGE } from "../../src/gateway/realtime.gateway.js";
import { ROOM_FORBIDDEN_CLOSE_CODE } from "../../src/gateway/room-authorization.service.js";
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

// STORY-026 — the handshake is the ONE cookie-authenticated transport with
// neither a CSRF check nor an Origin allow-list.
//
// `verifyDoubleSubmit` short-circuits on non-mutating methods, and the
// synthesised request calls itself `method: "WS"` — so it returned true
// unconditionally and no token was ever checked. `SameSite=Lax` does not
// close the gap: it blocks cross-SITE only, so any same-site origin (a
// white-label or a marketing subdomain) could open a socket with the user's
// cookies and read the entire event stream. No same-origin policy protects a
// WebSocket the way CORS protects a fetch.
//
// Both halves are asserted here, because either alone leaves a way in: a
// token check without an Origin check still admits a same-site page that can
// read the CSRF cookie, and an Origin check without a token check admits
// anything that is not a browser.

const WRAPPING_KEY = Buffer.alloc(32, 9);

describe("STORY-026 · the handshake carries CSRF and is Origin-checked", () => {
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

  /** A member, its session, and the tokens a browser would hold. */
  async function member() {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `RT ${randomUUID()}` }, meta);
    const session = await sessions.createSession(ownerId);
    const pinned = await sessions.switchWorkspace(session.sid, ownerId, workspace.id, "owner", null, 1);
    return { workspace, accessToken: pinned.accessToken, csrfToken: pinned.csrfToken };
  }

  interface ConnectOptions {
    readonly csrfCookie?: string;
    readonly csrfAuth?: string;
    readonly origin?: string | null;
  }

  /** A socket carrying exactly the cookies, handshake auth and Origin a browser would send. */
  function connect(accessToken: string, options: ConnectOptions): ClientSocket {
    const cookies = [`${ACCESS_COOKIE_NAME}=${accessToken}`];
    if (options.csrfCookie !== undefined) cookies.push(`${CSRF_COOKIE_NAME}=${options.csrfCookie}`);

    const headers: Record<string, string> = { cookie: cookies.join("; ") };
    if (options.origin !== null && options.origin !== undefined) headers.origin = options.origin;

    const client = io(`http://127.0.0.1:${String(port)}/rt`, {
      transports: ["websocket"],
      extraHeaders: headers,
      auth: options.csrfAuth === undefined ? {} : { csrf: options.csrfAuth },
      reconnection: false,
    });
    clients.push(client);
    return client;
  }

  function joined(client: ClientSocket, workspaceId: string): Promise<{ joined: boolean }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply to join:workspace within 5s")), 5_000);
      client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspaceId }, (reply: { joined: boolean }) => {
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

  const ALLOWED = "http://localhost:3000";

  it("a handshake with the matching CSRF token and an allowed Origin joins", async () => {
    const { workspace, accessToken, csrfToken } = await member();
    const client = connect(accessToken, { csrfCookie: csrfToken, csrfAuth: csrfToken, origin: ALLOWED });
    await expect(joined(client, workspace.id)).resolves.toMatchObject({ joined: true });
  });

  it("a handshake carrying NO CSRF token is refused", async () => {
    const { workspace, accessToken, csrfToken } = await member();
    const client = connect(accessToken, { csrfCookie: csrfToken, origin: ALLOWED });
    const closed = refused(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id });
    await expect(closed).resolves.toMatchObject({ close_code: ROOM_FORBIDDEN_CLOSE_CODE });
  });

  // The double submit is what makes the token unforgeable by a page that
  // cannot read the cookie. A value that merely LOOKS right must not pass.
  it("a handshake carrying a WRONG CSRF token is refused", async () => {
    const { workspace, accessToken, csrfToken } = await member();
    const wrong = "f".repeat(csrfToken.length);
    const client = connect(accessToken, { csrfCookie: csrfToken, csrfAuth: wrong, origin: ALLOWED });
    const closed = refused(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id });
    await expect(closed).resolves.toMatchObject({ close_code: ROOM_FORBIDDEN_CLOSE_CODE });
  });

  // The attack the allow-list exists for: a same-site subdomain, with the
  // user's cookies and a readable CSRF cookie, so its token IS valid.
  it("a same-site origin that is not on the allow-list is refused, even with a valid token", async () => {
    const { workspace, accessToken, csrfToken } = await member();
    const client = connect(accessToken, {
      csrfCookie: csrfToken,
      csrfAuth: csrfToken,
      origin: "http://evil.localhost:3000",
    });
    const closed = refused(client);
    client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id });
    await expect(closed).resolves.toMatchObject({ close_code: ROOM_FORBIDDEN_CLOSE_CODE });
  });

  // A client that sends no Origin is not a browser, so it is not the threat
  // the allow-list addresses: it had to present the cookie itself, which
  // means it already holds the credential. Refusing it would break every
  // server-to-server consumer without closing anything.
  it("a client sending no Origin at all is allowed, and that is deliberate", async () => {
    const { workspace, accessToken, csrfToken } = await member();
    const client = connect(accessToken, { csrfCookie: csrfToken, csrfAuth: csrfToken, origin: null });
    await expect(joined(client, workspace.id)).resolves.toMatchObject({ joined: true });
  });
});
