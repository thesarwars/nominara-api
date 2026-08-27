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
import { SOCKET_MESSAGE_CAP_PER_SECOND, RESYNC_DIRECTIVE } from "../../src/gateway/backpressure.js";
import { startValkey, type StartedValkey } from "../support/valkey-fixture.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-026 AC6 and AC7, over the path events ACTUALLY take.
//
// The cross-instance spec drives `namespace.to(room).emit()` directly, which
// proves the Valkey adapter works and nothing about what a client receives
// when the API publishes. That distinction became load-bearing: a room
// broadcast cannot honour either budget, because `Adapter.broadcast` encodes
// once and writes straight to each socket's engine, and its only per-socket
// hook is observational. So client events now travel a fan-out channel and the
// gateway delivers them per socket.
//
// This file drives the whole of it — a real publisher, a real Valkey, a real
// gateway, a real authenticated socket — because AC6 and AC7 are promises
// about what arrives at a client, and every intermediate assertion has already
// been shown in this epic to pass while the end-to-end behaviour was broken.

const WRAPPING_KEY = Buffer.alloc(32, 9);

describe("STORY-026 · coalescing and backpressure on the real delivery path", () => {
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

    // The gateway subscribes to the fan-out channel, and the publisher writes
    // to it — the same two ends the deployed system wires together.
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

  /** A joined, authorised socket in a workspace room — the only thing events are delivered to. */
  async function joinedSocket(): Promise<{ workspaceId: string; client: ClientSocket }> {
    const ownerId = await createUser();
    const workspace = await workspaces.create(ownerId, { name: `RT ${randomUUID()}` }, meta);
    const session = await sessions.createSession(ownerId);
    const pinned = await sessions.switchWorkspace(session.sid, ownerId, workspace.id, "owner", null, 1);
    const client = connect(pinned.accessToken, pinned.csrfToken);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply to join:workspace within 5s")), 5_000);
      client.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: workspace.id }, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { workspaceId: workspace.id, client };
  }

  function collect(client: ClientSocket, event: string): unknown[] {
    const seen: unknown[] = [];
    client.on(event, (payload: unknown) => seen.push(payload));
    return seen;
  }

  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function progress(runId: string, pct: number): Record<string, unknown> {
    return {
      run_id: runId,
      project_id: randomUUID(),
      planned: 100,
      captured: pct,
      skipped: 0,
      failed: 0,
      pct,
      eta_ms: null,
    };
  }

  // The guard on everything below: if nothing arrives at all, every
  // "at most N" assertion passes vacuously.
  it("an event published by the API reaches a joined client at all", async () => {
    const { workspaceId, client } = await joinedSocket();
    const seen = collect(client, "run.progress");

    publisher.toWorkspace(workspaceId, "run.progress", progress(randomUUID(), 5) as never);
    await settle(600);

    expect(seen.length, "the real publish path must deliver").toBe(1);
  }, 30_000);

  // AC6. §11 caps run.progress at one per 750 ms per run. The trailing flush
  // means a burst yields the FIRST and the LATEST, never the whole burst and
  // never a stale value at the end.
  it("coalesces a burst of run.progress to at most two, ending on the latest state", async () => {
    const { workspaceId, client } = await joinedSocket();
    const seen = collect(client, "run.progress") as { pct: number }[];
    const runId = randomUUID();

    for (let pct = 1; pct <= 12; pct += 1) {
      publisher.toWorkspace(workspaceId, "run.progress", progress(runId, pct) as never);
    }
    await settle(1_500);

    expect(seen.length, "a 12-event burst inside one window must not arrive as 12").toBeLessThanOrEqual(2);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]!.pct, "the last event must be the CURRENT state, not a stale one").toBe(12);
  }, 30_000);

  // The budget is per RUN, not per event name. Sharing one would coalesce two
  // runs against each other and lose one of them.
  it("keeps a separate budget per run, so two runs do not coalesce each other away", async () => {
    const { workspaceId, client } = await joinedSocket();
    const seen = collect(client, "run.progress") as { run_id: string }[];
    const first = randomUUID();
    const second = randomUUID();

    publisher.toWorkspace(workspaceId, "run.progress", progress(first, 1) as never);
    publisher.toWorkspace(workspaceId, "run.progress", progress(second, 1) as never);
    await settle(600);

    expect(new Set(seen.map((event) => event.run_id)), "both runs must be represented").toEqual(
      new Set([first, second]),
    );
  }, 30_000);

  function finding(projectId: string): Record<string, unknown> {
    return {
      finding_id: randomUUID(),
      project_id: projectId,
      rule_code: "AUX-001",
      severity: "high",
      url: "https://example.test/page",
    };
  }

  // Decision #4. §11 says "≤ 5 / s / project"; it was implemented as a 200 ms
  // replace-latest throttle. Both deliver about five of twenty — the
  // difference, and the entire defect, is that the throttle delivered five and
  // said NOTHING about the fifteen it dropped. The client could not know it
  // was missing rows, so it never refetched them.
  //
  // The resync directive is therefore the discriminating assertion here, not
  // the count: a replace-latest throttle passes every count-based check in
  // this test and emits no resync at all.
  it("spends a per-project budget and tells the client once that it missed rows", async () => {
    const { workspaceId, client } = await joinedSocket();
    const projectId = randomUUID();
    const delivered = collect(client, "aux.finding_created");
    const resyncs = collect(client, RESYNC_DIRECTIVE) as { scope: string; project_id: string | null }[];

    for (let i = 0; i < 20; i += 1) {
      publisher.toWorkspace(workspaceId, "aux.finding_created", finding(projectId) as never);
    }
    await settle(900);

    expect(delivered.length, "§11 caps this at five per second per project").toBeLessThanOrEqual(5);
    expect(delivered.length).toBeGreaterThan(0);
    expect(resyncs, "silent loss is the defect; the client must be told it missed rows").toHaveLength(1);
    expect(resyncs[0], "and told WHICH project to refetch, not to refetch everything").toEqual({
      reason: "rate_limited",
      scope: "project",
      project_id: projectId,
    });
  }, 30_000);

  // One budget per project, not one per socket. A workspace with a busy
  // project would otherwise silence a quiet one.
  it("gives each project its own budget", async () => {
    const { workspaceId, client } = await joinedSocket();
    const busy = randomUUID();
    const quiet = randomUUID();
    const delivered = collect(client, "aux.finding_created") as { project_id: string }[];

    for (let i = 0; i < 20; i += 1) {
      publisher.toWorkspace(workspaceId, "aux.finding_created", finding(busy) as never);
    }
    publisher.toWorkspace(workspaceId, "aux.finding_created", finding(quiet) as never);
    await settle(900);

    expect(
      delivered.some((event) => event.project_id === quiet),
      "the quiet project's single event must survive the busy one's flood",
    ).toBe(true);
  }, 30_000);

  // AC7. §9 caps one socket at 20 messages per second: beyond that it is told
  // ONCE to resync and further messages are DROPPED, never queued.
  it("caps a socket at the per-second budget and sends resync instead of a backlog", async () => {
    const { workspaceId, client } = await joinedSocket();
    const delivered = collect(client, "task.moved");
    const resyncs = collect(client, RESYNC_DIRECTIVE);

    // task.moved carries no §11 budget, so every one of these reaches the
    // backpressure gate — which is the thing under test here.
    for (let i = 0; i < SOCKET_MESSAGE_CAP_PER_SECOND * 3; i += 1) {
      publisher.toWorkspace(workspaceId, "task.moved", {
        task_id: randomUUID(),
        project_id: randomUUID(),
        from_status: "todo",
        to_status: "doing",
        actor_id: randomUUID(),
      } as never);
    }
    await settle(900);

    expect(delivered.length, "the socket must not receive more than its budget").toBeLessThanOrEqual(
      SOCKET_MESSAGE_CAP_PER_SECOND,
    );
    expect(resyncs.length, "a throttled client is told once, not once per drop").toBe(1);
    expect(
      delivered.length + resyncs.length,
      "dropped messages must be DROPPED — a backlog would deliver them all eventually",
    ).toBeLessThan(SOCKET_MESSAGE_CAP_PER_SECOND * 3);
  }, 30_000);
});
