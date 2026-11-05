import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { Queue, type Job } from "bullmq";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePlanJobSchema } from "../../contracts/tracking/capture-plan-job.schema.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import {
  SchedulerBlindError,
  SchedulerSweepRuntime,
  runSchedulerSweep,
  sweepIdempotencyKey,
  type SweepJob,
} from "../../src/lib/capture/scheduler-sweep.js";
import { claimDueProject } from "../../src/lib/capture/scheduler.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createCapturePlanHandler } from "../../src/lib/queue/handlers/capture-plan.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createQueueWorkerConnection } from "../../src/lib/queue/connection.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { rotatingHmacJobVerifier } from "../../src/lib/queue/signing.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { TEST_SIGNING_KEYS } from "../support/queue-test-harness.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-A-13 (Option A, owner decision 2026-10-08) — the scheduler sweep.
//
// The sweep CLAIMS due projects (FOR UPDATE SKIP LOCKED) and enqueues one signed
// capture.plan job per project with the dedup key run:{project}:{next_run_at}. It
// never advances next_run_at: only the capture.plan handler does (NEW-A-10).
//
// The claim runs as the superuser (the production sweep runs on the owner
// connection, which sees across tenants); the blind-role scenario runs as
// nominara_app on purpose.

const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.plan")!;

describe("NEW-A-13 · the scheduler sweep claims due projects and enqueues signed capture.plan jobs", () => {
  let container: StartedPostgreSqlContainer;
  let valkey: ValkeyFixture;
  let db: Client;
  let sweepA: Client;
  let sweepB: Client;
  let appDb: Client;
  const originalKey = process.env.GEMINI_API_KEY;

  const connect = async (user = "nominara", password = "nominara"): Promise<Client> => {
    const client = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user,
      password,
    });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    valkey = await startValkeyFixture();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const appPassword = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(appPassword)}`);
    appDb = await connect("nominara_app", appPassword);
    sweepA = await connect();
    sweepB = await connect();
  }, 300_000);

  afterAll(async () => {
    await Promise.all([appDb.end(), sweepA.end(), sweepB.end(), db.end()]);
    await valkey.stop();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE capture_runs, projects, workspaces CASCADE");
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  async function addWorkspace(status = "active"): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, status) VALUES ($1,'Secret Co Name',$2,'business',$3)", [
      id,
      `w-${randomUUID().slice(0, 8)}`,
      status,
    ]);
    return id;
  }

  async function addProject(
    workspaceId: string,
    options: { dueMinutesAgo?: number | null; status?: string; deleted?: boolean; cadence?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const due = options.dueMinutesAgo === null ? null : new Date(Date.now() - (options.dueMinutesAgo ?? 10) * 60_000);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, deleted_at, next_run_at, cadence)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test',$4,$5,$6,$7)`,
      [
        id,
        workspaceId,
        `p-${randomUUID().slice(0, 8)}`,
        options.status ?? "active",
        options.deleted ? new Date() : null,
        due,
        options.cadence ?? "daily",
      ],
    );
    return id;
  }

  const collector = () => {
    const jobs: SweepJob[] = [];
    return { jobs, enqueue: async (job: SweepJob): Promise<void> => void jobs.push(job) };
  };

  const schedule = async (projectId: string) =>
    (await db.query<{ next_run_at: Date | null; last_run_at: Date | null }>(
      "SELECT next_run_at, last_run_at FROM projects WHERE id = $1",
      [projectId],
    )).rows[0]!;

  it("NEW-A-13 AC2 · enqueues one job per due project, longest-waiting first, keyed run:{project}:{next_run_at}", async () => {
    const ws = await addWorkspace();
    const newest = await addProject(ws, { dueMinutesAgo: 5 });
    const oldest = await addProject(ws, { dueMinutesAgo: 50 });
    const middle = await addProject(ws, { dueMinutesAgo: 20 });
    const due = Object.fromEntries(
      await Promise.all([newest, oldest, middle].map(async (id) => [id, (await schedule(id)).next_run_at!] as const)),
    );

    const { jobs, enqueue } = collector();
    const result = await runSchedulerSweep(sweepA, enqueue, new Date());

    expect(jobs.map((job) => job.projectId)).toEqual([oldest, middle, newest]);
    expect(jobs.every((job) => job.workspaceId === ws)).toBe(true);
    for (const job of jobs) expect(job.idempotencyKey).toBe(sweepIdempotencyKey(job.projectId, due[job.projectId]!));
    expect(result).toEqual({ status: "complete", claimed: 3, enqueued: 3, failed: 0 });
  }, 60_000);

  it("NEW-A-13 AC2 · skips soft_capped and suspended workspaces, paused and deleted projects, and projects not yet due or never scheduled", async () => {
    const active = await addWorkspace("active");
    const trialing = await addWorkspace("trialing");
    const softCapped = await addWorkspace("soft_capped");
    const suspended = await addWorkspace("suspended");
    const due = await addProject(active);
    const dueTrial = await addProject(trialing);
    const everyProject = [
      due,
      dueTrial,
      await addProject(softCapped),
      await addProject(suspended),
      await addProject(active, { status: "paused" }),
      await addProject(active, { deleted: true }),
      await addProject(active, { dueMinutesAgo: -30 }), // due in the future
      await addProject(active, { dueMinutesAgo: null }), // never scheduled
    ];

    const now = new Date();
    const { jobs, enqueue } = collector();
    await runSchedulerSweep(sweepA, enqueue, now);

    expect(new Set(jobs.map((job) => job.projectId))).toEqual(new Set([due, dueTrial]));

    // The per-project claim the capture.plan handler uses must call exactly the same projects due.
    for (const id of everyProject) {
      await sweepB.query("BEGIN");
      const one = await claimDueProject(sweepB, id, now);
      await sweepB.query("ROLLBACK");
      expect(one !== null, `claimDueProject agrees with the sweep for ${id}`).toBe(id === due || id === dueTrial);
    }
  }, 60_000);

  it("NEW-A-13 AC2 · checkpoint-4 · a manual-cadence project with a past next_run_at is neither claimed by the sweep nor by the handler's claim", async () => {
    const ws = await addWorkspace();
    const manual = await addProject(ws, { cadence: "manual", dueMinutesAgo: 10 });
    const now = new Date();
    const { jobs, enqueue } = collector();
    const result = await runSchedulerSweep(sweepA, enqueue, now);

    expect(jobs.map((job) => job.projectId)).not.toContain(manual);
    expect(result.claimed).toBe(0);
    await sweepB.query("BEGIN");
    const one = await claimDueProject(sweepB, manual, now);
    await sweepB.query("ROLLBACK");
    expect(one).toBeNull();
  }, 60_000);

  it("NEW-A-13 AC2 · an empty tick enqueues nothing and is complete, not an error", async () => {
    const { jobs, enqueue } = collector();
    await expect(runSchedulerSweep(sweepA, enqueue, new Date())).resolves.toEqual({
      status: "complete",
      claimed: 0,
      enqueued: 0,
      failed: 0,
    });
    expect(jobs).toEqual([]);
  }, 60_000);

  it("NEW-A-13 AC2 · the sweep never advances next_run_at or last_run_at: only the capture.plan handler does", async () => {
    const ws = await addWorkspace();
    const project = await addProject(ws);
    const before = await schedule(project);

    const { enqueue } = collector();
    await runSchedulerSweep(sweepA, enqueue, new Date());

    expect(await schedule(project)).toEqual(before);
  }, 60_000);

  it("NEW-A-13 AC2 · two concurrent ticks never enqueue the same project twice (the claim is held across the enqueue)", async () => {
    const ws = await addWorkspace();
    const projects = await Promise.all([addProject(ws), addProject(ws), addProject(ws)]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => (firstEntered = resolve));
    const first: SweepJob[] = [];
    const second = collector();

    const tickA = runSchedulerSweep(
      sweepA,
      async (job) => {
        first.push(job);
        firstEntered();
        await gate; // tick A is mid-enqueue, still holding its claim transaction
      },
      new Date(),
    );
    await entered;
    const resultB = await runSchedulerSweep(sweepB, second.enqueue, new Date());
    release();
    const resultA = await tickA;

    expect(resultB.claimed, "B steps over every row A has locked").toBe(0);
    expect(second.jobs).toEqual([]);
    expect(first.map((job) => job.projectId).sort()).toEqual([...projects].sort());
    expect(resultA.enqueued).toBe(3);
  }, 60_000);

  it("NEW-A-13 AC2 · a failed enqueue is reported as partial, the other projects still go out, and nothing is advanced", async () => {
    const ws = await addWorkspace();
    const bad = await addProject(ws, { dueMinutesAgo: 30 });
    const good = await addProject(ws, { dueMinutesAgo: 10 });
    const before = await schedule(bad);
    const sent: string[] = [];

    const result = await runSchedulerSweep(
      sweepA,
      async (job) => {
        if (job.projectId === bad) throw new Error("queue unavailable");
        sent.push(job.projectId);
      },
      new Date(),
    );

    expect(sent).toEqual([good]);
    expect(result).toEqual({ status: "partial", claimed: 2, enqueued: 1, failed: 1 });
    expect(await schedule(bad), "a failed enqueue leaves the project due for the next tick").toEqual(before);
  }, 60_000);

  it("NEW-A-13 AC2 · end to end with the handler: the job the sweep enqueues is planned by capture.plan, which advances next_run_at, and the next sweep finds nothing", async () => {
    const ws = await addWorkspace();
    const project = await addProject(ws);
    const processor = createJobProcessor(ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => appDb,
      process: createCapturePlanHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
        cache: new InMemoryCacheAdapter(),
        dispatch: async () => undefined,
        enqueueCrawlAudit: async () => undefined,
      }),
    });

    // The handler runs AFTER the sweep commits, as it does in production (the
    // job travels through the queue): the sweep holds the project row lock until
    // then, and the handler's FOR UPDATE claim would wait on it.
    const { jobs, enqueue } = collector();
    await runSchedulerSweep(sweepA, enqueue, new Date());
    expect(jobs).toHaveLength(1);
    for (const job of jobs) {
      const envelope = signQueueJobPayload(
        { workspaceId: job.workspaceId, kid: TEST_SIGNING_KEYS.current.kid, projectId: job.projectId, trigger: "scheduled" },
        TEST_SIGNING_KEYS.current.key,
      );
      await processor({ data: envelope } as unknown as Job);
    }

    expect((await schedule(project)).next_run_at!.getTime()).toBeGreaterThan(Date.now());
    const again = collector();
    expect((await runSchedulerSweep(sweepA, again.enqueue, new Date())).claimed).toBe(0);
  }, 60_000);

  it("NEW-A-13 AC3 · every enqueued job is a real signed capture.plan job for the project's own workspace, and a repeated sweep adds no second job", async () => {
    const wsA = await addWorkspace();
    const wsB = await addWorkspace();
    const projA = await addProject(wsA);
    const projB = await addProject(wsB);

    const prefix = `test-${randomUUID().slice(0, 8)}`;
    const connection = createQueueWorkerConnection(valkey.connectionString);
    const producer = new QueueProducer(connection, prefix, TEST_SIGNING_KEYS);
    const reader = new Queue(ENTRY.name, { connection, prefix });
    try {
      const enqueue = async (job: SweepJob): Promise<void> => {
        await producer.enqueueTenantJob(
          "capture.plan",
          job.workspaceId,
          { projectId: job.projectId, trigger: "scheduled" },
          { idempotencyKey: job.idempotencyKey },
        );
      };
      await runSchedulerSweep(sweepA, enqueue, new Date());
      await runSchedulerSweep(sweepA, enqueue, new Date()); // next_run_at unchanged: same keys

      const jobs = await reader.getJobs(["waiting", "prioritized", "delayed"]);
      expect(jobs).toHaveLength(2);
      const verify = rotatingHmacJobVerifier(TEST_SIGNING_KEYS);
      const byProject = new Map<string, string>();
      for (const job of jobs) {
        const envelope = job.data as { payload: Record<string, unknown> & { workspaceId: string }; signature: string };
        expect(() => verify({ data: envelope.payload, signature: envelope.signature })).not.toThrow();
        const payload = capturePlanJobSchema.parse(envelope.payload);
        byProject.set(payload.projectId, payload.workspaceId);
      }
      expect(byProject.get(projA)).toBe(wsA);
      expect(byProject.get(projB)).toBe(wsB);
    } finally {
      await reader.close();
      await producer.onModuleDestroy();
      connection.disconnect();
    }
  }, 90_000);

  it("NEW-A-13 AC3 · the claim reads only project id, workspace id, cadence and next_run_at", async () => {
    const ws = await addWorkspace();
    await addProject(ws);
    const statements: string[] = [];
    const spy = {
      query: (...args: unknown[]) => {
        statements.push(String(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text));
        return (sweepA.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as Client;

    await runSchedulerSweep(spy, collector().enqueue, new Date());

    const claim = statements.find((sql) => /FOR UPDATE/i.test(sql) && /SKIP LOCKED/i.test(sql));
    expect(claim, "the claim is FOR UPDATE SKIP LOCKED").toBeDefined();
    const selectList = /SELECT([\s\S]*?)\bFROM\b/i.exec(claim!)![1]!;
    const columns = selectList.split(",").map((c) => c.trim().replace(/\s+/g, " ")).sort();
    expect(columns).toEqual(["p.cadence", "p.id", "p.next_run_at", "p.workspace_id"]);
    expect(claim).toMatch(/ORDER BY p\.next_run_at ASC/i);
  }, 60_000);

  it("NEW-A-13 AC3 · a connection that cannot see across tenants fails closed with SchedulerBlindError and enqueues nothing", async () => {
    const ws = await addWorkspace();
    await addProject(ws);
    const { jobs, enqueue } = collector();

    await expect(runSchedulerSweep(appDb, enqueue, new Date())).rejects.toBeInstanceOf(SchedulerBlindError);
    expect(jobs).toEqual([]);
  }, 60_000);

  it("NEW-A-13 AC4 · a project whose next_run_at is now() is enqueued by the next tick", async () => {
    const ws = await addWorkspace();
    const project = await addProject(ws, { dueMinutesAgo: 0 });
    // next_run_at is the DATABASE's now(); the tick reads the host clock. The colima VM and the host
    // drift by milliseconds, so the tick's clock is anchored just after the value the DB wrote.
    const set = await db.query<{ next_run_at: Date }>(
      "UPDATE projects SET next_run_at = now() WHERE id = $1 RETURNING next_run_at",
      [project],
    );
    const { jobs, enqueue } = collector();
    const runtime = new SchedulerSweepRuntime({
      connect: () => connect(),
      enqueue,
      clock: () => new Date(set.rows[0]!.next_run_at.getTime() + 1),
    });

    const result = await runtime.tick();

    expect(result).toMatchObject({ status: "complete", enqueued: 1 });
    expect(jobs.map((job) => job.projectId)).toEqual([project]);
  }, 60_000);

  it("NEW-A-13 · observability: a sweep metric and a log line carry counts and ids, never a workspace name", async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(message));
    const ws = await addWorkspace();
    const project = await addProject(ws);

    await runSchedulerSweep(sweepA, collector().enqueue, new Date());

    expect(lines.find((l) => (l as { metric?: string }).metric === "nominara_capture_scheduler_sweeps_total")).toMatchObject({
      status: "complete",
    });
    expect(lines.find((l) => (l as { metric?: string }).metric === "nominara_capture_scheduler_jobs_enqueued_total")).toBeDefined();
    const event = lines.find((l) => (l as { event?: string }).event === "capture.scheduler.enqueued");
    expect(event).toMatchObject({ workspace_id: ws, project_id: project });
    expect(JSON.stringify(lines)).not.toContain("Secret Co Name");
  }, 60_000);

  // CHECKPOINT-3 blocker. The sweep holds FOR UPDATE on up to 500 project rows
  // across the enqueue; a Valkey that stops answering must not keep them.
  const noLocksHeld = async (projectId: string): Promise<boolean> => {
    const probe = await connect();
    try {
      await probe.query("BEGIN");
      await probe.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE NOWAIT", [projectId]);
      await probe.query("ROLLBACK");
      return true;
    } catch {
      await probe.query("ROLLBACK").catch(() => undefined);
      return false;
    } finally {
      await probe.end();
    }
  };
  const eventually = async (check: () => Promise<boolean>, withinMs: number): Promise<boolean> => {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  };
  const bounds = { enqueueTimeoutMs: 400, transactionBudgetMs: 5_000, lockTimeoutMs: 1_000, idleInTransactionTimeoutMs: 5_000 };

  it("NEW-A-13 CP3-1d · an enqueue that never resolves: the sweep returns partial within the bound and the project row locks are released (a second connection's FOR UPDATE NOWAIT succeeds)", async () => {
    const ws = await addWorkspace();
    const project = await addProject(ws);
    const started = Date.now();
    const result = await Promise.race([
      runSchedulerSweep(sweepA, () => new Promise<void>(() => undefined), new Date(), bounds),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 8_000)),
    ]);
    expect(result, "the sweep must not pend on a stalled queue").toEqual({ status: "partial", claimed: 1, enqueued: 0, failed: 1 });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(await noLocksHeld(project)).toBe(true);
  }, 30_000);

  it("NEW-A-13 CP3-2 · Postgres bounds the transaction itself: past idle_in_transaction_session_timeout the server ends the session and drops the row locks, even if the process never lets go", async () => {
    const ws = await addWorkspace();
    const project = await addProject(ws);
    const lonely = await connect();
    lonely.on("error", () => undefined);
    const sweep = runSchedulerSweep(lonely, () => new Promise<void>(() => undefined), new Date(), {
      ...bounds,
      enqueueTimeoutMs: 60_000,
      transactionBudgetMs: 60_000,
      idleInTransactionTimeoutMs: 400,
    });
    sweep.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await noLocksHeld(project), "the lock is held while the enqueue is pending").toBe(false);
    expect(await eventually(() => noLocksHeld(project), 5_000), "released by the server, not by the client").toBe(true);
    await lonely.end().catch(() => undefined);
  }, 30_000);

  it("NEW-A-13 CP3-3d · a tick whose enqueue never resolves is abandoned at tickTimeoutMs, its connection is ended, the row locks are released, and tick() settles so the runtime can re-arm", async () => {
    const ws = await addWorkspace();
    const project = await addProject(ws);
    const runtime = new SchedulerSweepRuntime({
      connect: () => connect(),
      enqueue: () => new Promise<void>(() => undefined),
      limits: { ...bounds, enqueueTimeoutMs: 60_000, transactionBudgetMs: 60_000, idleInTransactionTimeoutMs: 60_000, tickTimeoutMs: 700, connectTimeoutMs: 2_000 },
    } as never);
    const settled = await Promise.race([
      runtime.tick().then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 8_000)),
    ]);
    expect(settled).toBe("settled");
    expect(await eventually(() => noLocksHeld(project), 5_000)).toBe(true);
  }, 30_000);
});
