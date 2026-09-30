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
import {
  NoopRealtimePublisher,
  ValkeyRealtimePublisher,
  realtimeControlChannel,
  realtimeFanoutChannel,
} from "../../src/lib/cache/realtime-publisher.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { SOCKET_MESSAGE_CAP_PER_SECOND, RESYNC_DIRECTIVE } from "../../src/gateway/backpressure.js";
import { startValkey, type StartedValkey } from "../support/valkey-fixture.js";
import { Redis } from "ioredis";
import { SOCKET_MESSAGE_CAP_PER_SECOND as SOCKET_CAP } from "../../src/gateway/backpressure.js";
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

    // The gateway subscribes to the fan-out channel, and the publisher writes
    // to it — the same two ends the deployed system wires together.
    app.get(RealtimeGateway).attachFanoutChannel(valkey.url, realtimeFanoutChannel(cacheKeyNamespace()));
    // The CONTROL channel too — `member.changed` is what closes a revoked
    // socket immediately instead of leaving it to the 60s timer, and until now
    // nothing in the suite constructed both ends of it.
    app.get(RealtimeGateway).attachControlChannel(valkey.url, realtimeControlChannel(cacheKeyNamespace()));
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
  async function joinedSocket(): Promise<{ workspaceId: string; ownerId: string; client: ClientSocket }> {
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
    return { workspaceId: workspace.id, ownerId, client };
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

  // THE TENANCY TEST, and the reason this file exists at all.
  //
  // Delivery used to be the socket.io adapter's room broadcast — a library's
  // filter, and not in doubt. It is now ELEVEN LINES OF HAND-WRITTEN CODE in
  // deliverFanout, and the only test that covered tenant scoping
  // (realtime-cross-instance.spec.ts "row 4") drives
  // `namespace.to(room).emit()` — the adapter path client events no longer
  // travel. So it went on proving the library while the thing production
  // actually runs had no test at all: removing the room check left the whole
  // suite green while every workspace's events reached every socket.
  //
  // Found by the STORY-026 second-engineer review. The recurring shape of
  // this epic, for the fifth time: a check that passes whether or not the
  // thing works.
  it("delivers a workspace's events ONLY to that workspace's sockets", async () => {
    const mine = await joinedSocket();
    const theirs = await joinedSocket();

    const runId = randomUUID();
    // A deadline the other tenant's socket must lose to. Asserting "nothing
    // arrived" without racing a clock is the vacuity this epic keeps
    // producing — it resolves before any frame could have been parsed.
    const leaked = new Promise<"leaked">((resolve) => {
      theirs.client.on("run.progress", () => resolve("leaked"));
    });
    const quiet = new Promise<"quiet">((resolve) => {
      setTimeout(() => resolve("quiet"), 1_000);
    });
    const arrived = new Promise<"arrived">((resolve) => {
      mine.client.on("run.progress", () => resolve("arrived"));
    });

    publisher.toWorkspace(mine.workspaceId, "run.progress", progress(runId, 7) as never);

    // The intended recipient must actually receive it, or "nothing leaked"
    // would pass against a gateway that delivers nothing to anyone.
    await expect(arrived, "the intended workspace must receive its own event").resolves.toBe("arrived");
    await expect(
      Promise.race([leaked, quiet]),
      "another workspace's socket must receive nothing",
    ).resolves.toBe("quiet");
  }, 30_000);

  // AC4 — "the gateway requires NO sticky sessions" — for the path client
  // events now actually take.
  //
  // realtime-cross-instance.spec.ts proves that property about
  // `namespace.to(room).emit()`, the socket.io adapter path. Client events no
  // longer travel it: they arrive on the fan-out channel and each instance
  // delivers to its own local sockets. So the criterion was being proven
  // about a mechanism that, for this traffic, does nothing. Found by the
  // second-engineer review.
  //
  // Two independent gateways, one publish, both clients receive.
  it("reaches a client on a gateway instance that did not publish, with no sticky session", async () => {
    const first = await joinedSocket();

    const secondRef = await Test.createTestingModule({ imports: [RealtimeModule] }).compile();
    const secondApp = secondRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await secondApp.init();
    await secondApp.listen({ port: 0, host: "127.0.0.1" });
    const secondPort = (secondApp.getHttpServer().address() as { port: number }).port;
    secondApp.get(RealtimeGateway).attachFanoutChannel(valkey.url, realtimeFanoutChannel(cacheKeyNamespace()));
    await settle(250);

    try {
      // A second socket for the SAME workspace, connected to the other
      // instance — the arrangement a load balancer with no affinity produces.
      // The SAME member, a second session — one person with two tabs, landing
      // on different replicas. No new membership: workspaces.create() already
      // made this user the owner.
      const session = await sessions.createSession(first.ownerId);
      const pinned = await sessions.switchWorkspace(session.sid, first.ownerId, first.workspaceId, "owner", null, 1);

      const other = io(`http://127.0.0.1:${String(secondPort)}/rt`, {
        transports: ["websocket"],
        extraHeaders: {
          cookie: `${ACCESS_COOKIE_NAME}=${pinned.accessToken}; ${CSRF_COOKIE_NAME}=${pinned.csrfToken}`,
        },
        auth: { csrf: pinned.csrfToken },
        reconnection: false,
      });
      clients.push(other);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no reply to join on the second instance")), 5_000);
        other.emit(JOIN_WORKSPACE_MESSAGE, { workspace_id: first.workspaceId }, () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const here = collect(first.client, "run.progress");
      const there = collect(other, "run.progress");

      publisher.toWorkspace(first.workspaceId, "run.progress", progress(randomUUID(), 11) as never);
      await settle(700);

      expect(here, "the publishing instance's client").toHaveLength(1);
      expect(there, "a client on the OTHER instance must receive it too").toHaveLength(1);
    } finally {
      await secondApp.close();
    }
  }, 45_000);

  // THE CROSS-PROCESS REVOCATION WIRE, which had no test at all.
  //
  // Nothing constructed ValkeyRealtimePublisher, called attachControlChannel
  // and asserted the two ends meet. They compute the channel INDEPENDENTLY
  // from process.env, so a CACHE_KEY_NAMESPACE mismatch between the api and
  // gateway containers disables immediate revocation silently — a removed
  // member keeps a live socket for the full 60 seconds §7 treats as the
  // ceiling, not the mechanism, and nothing anywhere says so.
  it("a member.changed published by the API closes the socket, cross-process", async () => {
    const { workspaceId, ownerId, client } = await joinedSocket();

    const closed = new Promise<"closed">((resolve) => {
      client.on("disconnect", () => resolve("closed"));
    });
    const stayedOpen = new Promise<"open">((resolve) => {
      setTimeout(() => resolve("open"), 3_000);
    });

    publisher.memberChanged(workspaceId, {
      workspace_id: workspaceId,
      user_id: ownerId,
      role: "viewer",
      status: "removed",
    });

    await expect(
      Promise.race([closed, stayedOpen]),
      "the control channel is what makes revocation immediate rather than a 60s wait",
    ).resolves.toBe("closed");
  }, 30_000);

  // WHAT THIS FILE STILL CANNOT COVER, stated rather than left implied.
  //
  // The remaining risk is a CACHE_KEY_NAMESPACE mismatch between the api and
  // gateway containers: both derive their channel from the environment, so
  // they can disagree and revocation goes quiet with nothing to see. A test
  // here cannot catch it — both ends call the same function in one process,
  // so any assertion comparing them is trivially true. I wrote that assertion
  // first, mutated the channel builder, and watched it pass; it was deleted
  // rather than shipped, because a check that cannot fail is worse than none.
  //
  // Catching it needs a real mechanism — a startup handshake on the channel,
  // or a deploy-time assertion that the two containers' configuration matches
  // — and that is a decision, not an oversight. Recorded as open in
  // STORY-026.

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

  // The resync notice must not become the flood it reports.
  //
  // The budget is per (socket, PROJECT) and nothing bounds how many project
  // ids a publisher can name, so an unbounded resync emitted outside §9's cap
  // sent 201 frames to one socket against a cap of 20 — ten times the limit,
  // in control traffic, to the client already established as unable to keep
  // up. Found by the second-engineer review; AC7's own words are "a SINGLE
  // resynchronise directive rather than a backlog".
  it("keeps total frames to one socket within §9's cap even across many projects", async () => {
    const { workspaceId, client } = await joinedSocket();
    let frames = 0;
    client.onAny(() => {
      frames += 1;
    });

    for (let project = 0; project < 40; project += 1) {
      const projectId = randomUUID();
      for (let i = 0; i < 7; i += 1) {
        publisher.toWorkspace(workspaceId, "aux.finding_created", finding(projectId) as never);
      }
    }
    await settle(900);

    // §9's cap governs DATA. The resync is the notice, and a notice that
    // could itself be capped away would be useless — so it is allowed beyond
    // the cap, but bounded: at most one naming a project and at most one
    // widening to the socket. Two, not the 201 the review measured.
    expect(frames, "the notice must not become the flood it reports").toBeLessThanOrEqual(SOCKET_CAP + 2);
  }, 30_000);

  // ...and suppression must not become silence. A second project overflowing
  // in the same window is told BROADLY rather than not at all.
  it("upgrades a second project's overflow to a socket-wide resync instead of dropping the notice", async () => {
    const { workspaceId, client } = await joinedSocket();
    const resyncs = collect(client, RESYNC_DIRECTIVE) as { scope: string; project_id: string | null }[];
    const first = randomUUID();
    const second = randomUUID();

    for (let i = 0; i < 12; i += 1) publisher.toWorkspace(workspaceId, "aux.finding_created", finding(first) as never);
    for (let i = 0; i < 12; i += 1) publisher.toWorkspace(workspaceId, "aux.finding_created", finding(second) as never);
    await settle(900);

    expect(resyncs.map((r) => r.scope), "the first names its project; the second widens to the socket").toEqual([
      "project",
      "socket",
    ]);
    expect(resyncs[0]!.project_id).toBe(first);
    expect(resyncs[1]!.project_id, "a socket-wide resync names no single project").toBeNull();
  }, 30_000);

  // A malformed message on the fan-out channel must not take the gateway
  // down. Every replica subscribes to the same channel, so one bad publish
  // would kill the whole fleet at once, with no request to trace it back to.
  it("survives malformed fan-out messages and keeps delivering afterwards", async () => {
    const { workspaceId, client } = await joinedSocket();
    const seen = collect(client, "run.progress");

    const raw = new Redis(valkey.url);
    const channel = realtimeFanoutChannel(cacheKeyNamespace());
    try {
      await raw.publish(channel, "not json at all");
      await raw.publish(channel, JSON.stringify(null));
      // socket.io reserves this name and THROWS when it is emitted — the
      // event name was previously forwarded to socket.emit unvalidated.
      await raw.publish(channel, JSON.stringify({ workspaceId, event: "disconnect", payload: {} }));
      await raw.publish(channel, JSON.stringify({ workspaceId: "not-a-uuid", event: "run.progress", payload: {} }));
      // A catalogued name whose payload does not match its schema.
      await raw.publish(channel, JSON.stringify({ workspaceId, event: "run.progress", payload: { nonsense: true } }));
      await settle(300);

      publisher.toWorkspace(workspaceId, "run.progress", progress(randomUUID(), 3) as never);
      await settle(600);

      expect(seen, "the gateway must still be alive and delivering").toHaveLength(1);
      expect(client.connected, "and the socket must not have been torn down").toBe(true);
    } finally {
      raw.disconnect();
    }
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
