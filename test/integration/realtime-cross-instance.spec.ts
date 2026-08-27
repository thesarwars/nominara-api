import { randomUUID } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import { JOIN_WORKSPACE_MESSAGE, RealtimeGateway } from "../../src/gateway/realtime.gateway.js";
import { workspaceRoom } from "../../src/gateway/room-authorization.service.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkey, type StartedValkey } from "../support/valkey-fixture.js";

// STORY-026 T20 row 4 — AC4, and the epic's own success metric: "Cross-instance
// socket broadcast working with no sticky sessions."
//
// This is the ONE test that can prove it. Every other realtime assertion runs
// against a single process, where a broadcast trivially reaches its own
// sockets whether an adapter exists or not — so a missing adapter is invisible
// to all of them, and shows up in production as events that arrive for some
// users and not others depending on which replica the balancer picked.
//
// Two gateways, one Valkey, a client on A and the emit from B.

const WRAPPING_KEY = Buffer.alloc(32, 11);

describe("STORY-026 · a broadcast from one gateway reaches a client on another", () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedValkey;
  let db: Client;
  let pool: Pool;
  let workspaces: WorkspacesService;
  let sessions: SessionService;
  let instanceA: NestFastifyApplication;
  let instanceB: NestFastifyApplication;
  let portA: number;
  const clients: ClientSocket[] = [];
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    valkey = await startValkey();
  }, 180_000);

  afterAll(async () => {
    await postgres.stop();
    await valkey.stop();
  });

  async function bootGateway(): Promise<{ app: NestFastifyApplication; port: number }> {
    const moduleRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen({ port: 0, host: "127.0.0.1" });
    // The adapter is what this test exists to exercise, so it is attached
    // explicitly rather than left to the bootstrap's environment gate.
    app.get(RealtimeGateway).attachAdapter(valkey.url);
    const address = app.getHttpServer().address() as { port: number };
    return { app, port: address.port };
  }

  beforeEach(async () => {
    applyFakeApiEnv();
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.DATABASE_URL_POOLED = postgres.getConnectionUri();

    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    sessions = new SessionService(pool);
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(WRAPPING_KEY, "local:dev"),
      new AuditChainService(),
      new MembershipService(new MembershipCacheService()),
      sessions,
      new NoopRealtimePublisher(),
    );

    const a = await bootGateway();
    const b = await bootGateway();
    instanceA = a.app;
    portA = a.port;
    instanceB = b.app;
  }, 180_000);

  afterEach(async () => {
    // Sockets first, then a tick to let their disconnects land, THEN the
    // apps. Closing an app while its adapter still has traffic in flight makes
    // ioredis reject the in-flight commands with "Connection is closed" —
    // harmless, but it surfaces as unhandled errors and would eventually be
    // mistaken for a real fault.
    // KNOWN TEARDOWN NOISE, stated rather than hidden. Closing these prints
    // "Connection is closed" rejections from inside
    // `@socket.io/redis-adapter`'s own request machinery. They are not
    // reachable from here — `quit()` and `disconnect()` produce the same ones,
    // and so does reordering this block; all three were tried. The library owns
    // that promise. It is teardown-only, the assertions above complete before
    // any of it, and the file passes. If this ever coincides with a real
    // failure, look past it rather than at it.
    await instanceA.close();
    await instanceB.close();
    for (const client of clients.splice(0)) client.close();
    await pool.end();
    await db.end();
    process.env = { ...originalEnv };
  });

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function joinedClientOnA(): Promise<{ client: ClientSocket; workspaceId: string }> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `xi-${randomUUID()}@example.com`,
    ]);
    const userId = result.rows[0]!.id;
    const workspace = await workspaces.create(userId, { name: `Xi ${randomUUID()}` }, meta);
    const session = await sessions.createSession(userId);
    const pinned = await sessions.switchWorkspace(session.sid, userId, workspace.id, "owner", null, 1);

    const client = io(`http://127.0.0.1:${String(portA)}/rt`, {
      transports: ["websocket"],
      extraHeaders: {
        cookie: `${ACCESS_COOKIE_NAME}=${pinned.accessToken}; ${CSRF_COOKIE_NAME}=${pinned.csrfToken}`,
      },
      // STORY-026 — the handshake now carries the double-submit token, the
      // same as any other cookie-authenticated request. socket.io puts it in
      // `auth` because a browser cannot set a header on a WebSocket
      // handshake; the server copies it into the header slot AuthGuard
      // already reads.
      auth: { csrf: pinned.csrfToken },
      reconnection: false,
    });
    clients.push(client);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const reply = await new Promise<{ joined: boolean }>((resolve) => {
      client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id }, resolve);
    });
    expect(reply.joined, "the fixture must actually be in the room before anything is proven").toBe(true);

    return { client, workspaceId: workspace.id };
  }

  it("row 4 — an event emitted on instance B arrives at a client connected to instance A", async () => {
    const { client, workspaceId } = await joinedClientOnA();

    const received = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("nothing arrived within 5s — the adapter is not carrying the broadcast"));
      }, 5_000);
      client.on("run.completed", (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    // The other process. It has never seen this socket.
    const serverB = (instanceB.get(RealtimeGateway) as unknown as { server: { to: (room: string) => { emit: (e: string, p: unknown) => void } } })
      .server;
    serverB.to(workspaceRoom(workspaceId)).emit("run.completed", { run_id: "r-1", status: "completed" });

    await expect(received).resolves.toEqual({ run_id: "r-1", status: "completed" });
  }, 60_000);

  it("row 4 — the broadcast is scoped to the room, not fanned out to every socket", async () => {
    // Cross-instance delivery that ignored rooms would be a cross-TENANT leak
    // wearing a performance feature's clothes.
    const first = await joinedClientOnA();
    const second = await joinedClientOnA();

    // THE NEGATIVE ASSERTION MUST BE GIVEN TIME TO FAIL.
    //
    // This previously awaited the intended recipient and then checked the
    // other socket's inbox immediately. Both frames are in flight together, so
    // that check ran in the same tick the first handler fired — before the
    // second client had parsed anything. The dangerous-area audit mutated
    // `serverB.to(room).emit(...)` to `serverB.emit(...)` — a real
    // namespace-wide fan-out, the exact cross-tenant leak this test names —
    // and measured: wrongInbox 0 at the moment of the check, 1 after a 250ms
    // settle. Green against a gateway broadcasting every workspace's events to
    // every socket in /rt.
    //
    // So the wrong recipient is now raced against a deadline and the DEADLINE
    // must win. A leaked frame beats the timer; silence does not.
    const leaked = new Promise<"leaked">((resolve) => {
      second.client.on("run.completed", () => resolve("leaked"));
    });
    const quiet = new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), 1_000));

    const arrived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the intended recipient got nothing"));
      }, 5_000);
      first.client.on("run.completed", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const serverB = (instanceB.get(RealtimeGateway) as unknown as { server: { to: (room: string) => { emit: (e: string, p: unknown) => void } } })
      .server;
    serverB.to(workspaceRoom(first.workspaceId)).emit("run.completed", { run_id: "r-2", status: "completed" });

    await arrived;
    await expect(
      Promise.race([leaked, quiet]),
      "another workspace's socket must receive nothing",
    ).resolves.toBe("quiet");
  }, 60_000);
});
