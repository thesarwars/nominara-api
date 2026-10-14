import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { FAIR_USE_METRIC } from "../../src/lib/capture/fair-use.js";
import type { ScheduledRun } from "../../src/lib/capture/scheduler.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createCaptureExecuteHandler } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import { createCapturePlanHandler } from "../../src/lib/queue/handlers/capture-plan.handler.js";
import { QUEUE_HANDLERS, type QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { TEST_SIGNING_KEYS } from "../support/queue-test-harness.js";

// NEW-A-10 — `capture.plan`: one signed tenant job plans and dispatches ONE
// project's scheduled run.
//
// RUN AS `nominara_app`, through the real `createJobProcessor`. The superuser
// the other handler specs use bypasses RLS, which would make the isolation
// scenario vacuous; and going through the real processor is what proves the
// signature is verified before any context is set and that the handler runs in
// the job's tenant context.

const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.plan")!;

describe("NEW-A-10 · capture.plan plans and dispatches one scheduled run", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appDb: Client;
  let dispatched: ScheduledRun[];
  let dispatchSawRun: boolean[];
  let wsA: string;
  let projA: string;
  let projB: string;
  const originalKey = process.env.GEMINI_API_KEY;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const appPassword = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(appPassword)}`);
    appDb = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: appPassword,
    });
    await appDb.connect();
  }, 300_000);

  afterAll(async () => {
    await appDb.end();
    await db.end();
    await container.stop();
  });

  // 'business': the seeded catalog (migration 0027) makes gemini `min_plan_key =
  // 'business'` with a business cadence, so a lower plan is never entitled to it
  // and a scheduled run would legitimately cover nothing.
  async function seedTenant(): Promise<{ ws: string; project: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'business')", [
      ws,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit, next_run_at)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test',10, now() - interval '10 minutes')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    for (const text of ["best crm", "top crm for startups", "crm pricing"]) {
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
         VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration',false,'active')`,
        [randomUUID(), ws, project, text, Buffer.from(text)],
      );
    }
    return { ws, project };
  }

  beforeEach(async () => {
    await db.query(
      "TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, usage_counters, projects, workspaces CASCADE",
    );
    process.env.GEMINI_API_KEY = "test-key-not-a-secret";
    dispatched = [];
    dispatchSawRun = [];
    ({ ws: wsA, project: projA } = await seedTenant());
    ({ project: projB } = await seedTenant());
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  function processor() {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const handler = createCapturePlanHandler(context, {
      cache: new InMemoryCacheAdapter(),
      dispatch: async (scheduled) => {
        // Called after COMMIT: the superuser connection must already see the row.
        const seen = await db.query("SELECT 1 FROM capture_runs WHERE id = $1", [scheduled.runId]);
        dispatchSawRun.push(seen.rows.length === 1);
        dispatched.push(scheduled);
      },
    });
    return createJobProcessor(ENTRY, { keys: TEST_SIGNING_KEYS, getClient: () => appDb, process: handler });
  }

  function signedJob(workspaceId: string, projectId: string, extra: Record<string, unknown> = {}): Job {
    const envelope = signQueueJobPayload(
      { workspaceId, kid: TEST_SIGNING_KEYS.current.kid, projectId, trigger: "scheduled", ...extra },
      TEST_SIGNING_KEYS.current.key,
    );
    return { data: envelope } as unknown as Job;
  }

  /** The after-commit dispatch is fire-and-forget; let it settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  const runsFor = async (projectId: string) =>
    (await db.query<{ trigger: string; engine_keys: string[]; status: string }>(
      "SELECT trigger, engine_keys, status FROM capture_runs WHERE project_id = $1",
      [projectId],
    )).rows;

  it("NEW-A-10 AC1 · is registered in QUEUE_HANDLERS", () => {
    expect(QUEUE_HANDLERS["capture.plan"]).toBeTypeOf("function");
  });

  it("NEW-A-10 AC1 · a signed job plans a scheduled run for the project and dispatches it after commit", async () => {
    await processor()(signedJob(wsA, projA));
    await settle();

    const runs = await runsFor(projA);
    expect(runs).toEqual([{ trigger: "scheduled", engine_keys: ["gemini"], status: "queued" }]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ projectId: projA, trigger: "scheduled" });
    expect(dispatched[0]!.plan.cells.length).toBeGreaterThan(0);
    expect(dispatchSawRun, "dispatch happened after the run row committed").toEqual([true]);
    // Planning advanced the schedule.
    const next = await db.query<{ next_run_at: Date }>("SELECT next_run_at FROM projects WHERE id = $1", [projA]);
    expect(next.rows[0]!.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("NEW-A-10 AC2 · a scheduled run debits 0 credits and reserves fair-use only for its live cells", async () => {
    await processor()(signedJob(wsA, projA));
    await settle();

    expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [wsA])).rowCount).toBe(0);
    const charged = await db.query<{ n: string }>(
      "SELECT coalesce(sum(credits_charged),0)::text AS n FROM usage_ledger WHERE workspace_id = $1",
      [wsA],
    );
    expect(charged.rows[0]!.n).toBe("0");
    const live = dispatched[0]!.plan.live;
    expect(live).toBeGreaterThan(0);
    const counter = await db.query<{ reserved_value: string }>(
      "SELECT reserved_value::text FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [wsA, FAIR_USE_METRIC],
    );
    expect(counter.rows[0]!.reserved_value).toBe(String(live));
  });

  it("NEW-A-10 AC3 · plans only captureReady engines — gemini — never a demo engine", async () => {
    await processor()(signedJob(wsA, projA));
    await settle();

    const engines = new Set(dispatched[0]!.plan.cells.map((cell) => cell.engineKey));
    expect([...engines]).toEqual(["gemini"]);
    expect((await runsFor(projA))[0]!.engine_keys).toEqual(["gemini"]);
  });

  it("NEW-A-10 AC3 · a project with no capturable engine creates no run and no failure", async () => {
    delete process.env.GEMINI_API_KEY; // no key: gemini is not capture-ready, and nothing else is
    await expect(processor()(signedJob(wsA, projA))).resolves.not.toThrow();
    await settle();

    expect(await runsFor(projA)).toEqual([]);
    expect(dispatched).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM answer_captures WHERE project_id = $1", [projA])).rowCount).toBe(0);
  });

  it("NEW-A-10 AC4 · duplicate delivery creates one capture_runs row and dispatches once", async () => {
    const job = signedJob(wsA, projA);
    await processor()(job);
    await processor()(job);
    await settle();

    expect(await runsFor(projA)).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it("NEW-A-10 AC4 · concurrent delivery of the same job still creates one row", async () => {
    const job = signedJob(wsA, projA);
    // Two connections: the project row lock is what serialises them.
    const second = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await second.connect();
    try {
      const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
      const handler = createCapturePlanHandler(context, {
        cache: new InMemoryCacheAdapter(),
        dispatch: async (scheduled) => {
          dispatched.push(scheduled);
        },
      });
      const other = createJobProcessor(ENTRY, { keys: TEST_SIGNING_KEYS, getClient: () => second, process: handler });
      await Promise.all([processor()(job), other(job)]);
      await settle();
    } finally {
      await second.end();
    }
    expect(await runsFor(projA)).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it("NEW-A-10 AC4 · a job signed for workspace A cannot plan workspace B's project", async () => {
    await processor()(signedJob(wsA, projB));
    await settle();

    expect(await runsFor(projB)).toEqual([]);
    expect(dispatched).toHaveLength(0);
    const untouched = await db.query<{ next_run_at: Date }>("SELECT next_run_at FROM projects WHERE id = $1", [projB]);
    expect(untouched.rows[0]!.next_run_at.getTime()).toBeLessThan(Date.now());
  });

  it("NEW-A-10 · a tampered payload is rejected before any run is written", async () => {
    const job = signedJob(wsA, projA);
    (job.data as { payload: Record<string, unknown> }).payload.projectId = projB;
    await expect(processor()(job)).rejects.toThrow();
    expect(await runsFor(projA)).toEqual([]);
    expect(await runsFor(projB)).toEqual([]);
  });

  it("NEW-A-10 · a microsecond-precision next_run_at plans exactly one run", async () => {
    // The JS Date a claim carries holds milliseconds; a next_run_at written by
    // SQL (now(), an ops backfill) does not. The schedule advance must still win.
    await db.query(
      "UPDATE projects SET next_run_at = now() - interval '10 minutes' + interval '1 microsecond' WHERE id = $1",
      [projA],
    );
    await expect(processor()(signedJob(wsA, projA))).resolves.not.toThrow();
    await settle();
    expect(await runsFor(projA)).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    const next = await db.query<{ next_run_at: Date }>("SELECT next_run_at FROM projects WHERE id = $1", [projA]);
    expect(next.rows[0]!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    // And the next delivery finds nothing due: still exactly one run.
    await processor()(signedJob(wsA, projA));
    await settle();
    expect(await runsFor(projA)).toHaveLength(1);
  });

  it("NEW-A-10 · a project that is not due yet is skipped without a run", async () => {
    await db.query("UPDATE projects SET next_run_at = now() + interval '1 day' WHERE id = $1", [projA]);
    await processor()(signedJob(wsA, projA));
    await settle();
    expect(await runsFor(projA)).toEqual([]);
    expect(dispatched).toHaveLength(0);
  });

  it("NEW-A-10 · a suspended workspace's project is skipped", async () => {
    await db.query("UPDATE workspaces SET status = 'suspended' WHERE id = $1", [wsA]);
    await processor()(signedJob(wsA, projA));
    await settle();
    expect(await runsFor(projA)).toEqual([]);
  });

  it("NEW-A-10 · a payload with an unknown key is refused, not planned", async () => {
    await expect(processor()(signedJob(wsA, projA, { credits: 0 }))).rejects.toThrow();
    expect(await runsFor(projA)).toEqual([]);
  });

  it("NEW-A-10 · a dispatch failure does not fail the job, fails the run and releases its fair-use reservation", async () => {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const handler = createCapturePlanHandler(context, {
      cache: new InMemoryCacheAdapter(),
      dispatch: () => Promise.reject(new Error("queue unreachable")),
      withClient: (fn) => fn(appDb),
    });
    const proc = createJobProcessor(ENTRY, { keys: TEST_SIGNING_KEYS, getClient: () => appDb, process: handler });
    await expect(proc(signedJob(wsA, projA))).resolves.not.toThrow();
    await settle();

    const runs = await runsFor(projA);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status, "a never-dispatched run must reach a terminal status").toBe("failed");
    const counter = await db.query<{ reserved_value: string }>(
      "SELECT reserved_value::text FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [wsA, FAIR_USE_METRIC],
    );
    expect(counter.rows[0]!.reserved_value).toBe("0");
  });

  it("NEW-A-10 · checkpoint-4 · a manual-cadence project with a past next_run_at is not planned: no run, no fair-use reservation", async () => {
    await db.query("UPDATE projects SET cadence = 'manual' WHERE id = $1", [projA]);
    for (let i = 0; i < 3; i += 1) await processor()(signedJob(wsA, projA));
    await settle();

    expect(await runsFor(projA)).toEqual([]);
    expect(dispatched).toHaveLength(0);
    const counter = await db.query("SELECT 1 FROM usage_counters WHERE workspace_id = $1 AND metric = $2 AND reserved_value > 0", [
      wsA,
      FAIR_USE_METRIC,
    ]);
    expect(counter.rowCount).toBe(0);
  });

  const failingDispatchProcessor = (dispatch: (scheduled: ScheduledRun) => Promise<unknown>) => {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const handler = createCapturePlanHandler(context, {
      cache: new InMemoryCacheAdapter(),
      dispatch,
      withClient: (fn) => fn(appDb),
    });
    return createJobProcessor(ENTRY, { keys: TEST_SIGNING_KEYS, getClient: () => appDb, process: handler });
  };

  const reservedValue = async (workspaceId: string): Promise<string> =>
    (await db.query<{ reserved_value: string }>(
      "SELECT reserved_value::text FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    )).rows[0]!.reserved_value;

  it("NEW-A-10 · checkpoint-4 · a dispatch that rejects after a cell has started leaves the run and its fair-use reservation alone", async () => {
    // The compensation's `status = 'queued'` guard is the only thing standing
    // between a partly-delivered run and a released reservation for cells that ran.
    let live = 0;
    const proc = failingDispatchProcessor(async (scheduled) => {
      live = scheduled.plan.live;
      await db.query("UPDATE capture_runs SET status = 'running', started_at = now() WHERE id = $1", [scheduled.runId]);
      throw new Error("reply lost after the first cell started");
    });
    await expect(proc(signedJob(wsA, projA))).resolves.not.toThrow();
    await settle();

    expect(live).toBeGreaterThan(0);
    expect((await runsFor(projA))[0]!.status).toBe("running");
    expect(await reservedValue(wsA)).toBe(String(live));
  });

  it("NEW-A-10 · checkpoint-4 · cells that WERE enqueued before an ambiguous dispatch failure do not call the vendor or write a capture against the failed run", async () => {
    const delivered: ScheduledRun[] = [];
    const proc = failingDispatchProcessor(async (scheduled) => {
      delivered.push(scheduled); // the addBulk landed; only the reply was lost
      throw new Error("connection reset after MULTI applied");
    });
    await proc(signedJob(wsA, projA));
    await settle();
    expect((await runsFor(projA))[0]!.status).toBe("failed");

    // The delayed cells now come due.
    const fetchSpy = vi.fn(() => Promise.reject(new Error("the vendor must not be called")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const execute = createCaptureExecuteHandler(
        { pool: undefined, env: {} } as unknown as QueueHandlerContext,
        {
          cache: new InMemoryCacheAdapter(),
          realtime: { toWorkspace: () => undefined, toProject: () => undefined, memberChanged: () => undefined },
          enqueueParse: () => Promise.resolve(),
          enqueueRollup: () => Promise.resolve(),
        },
      );
      for (const cell of delivered[0]!.plan.cells) {
        const job = { data: { payload: { ...(cell.payload as object), kid: "test-kid" } } } as unknown as Job;
        await execute(db, job).catch(() => undefined);
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(delivered[0]!.plan.cells.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await db.query("SELECT 1 FROM answer_captures WHERE run_id = $1", [delivered[0]!.runId])).rowCount).toBe(0);
    expect((await runsFor(projA))[0]!.status).toBe("failed");
  });

  it("NEW-A-10 · observability: emits the outcome metric and a log line carrying the workspace id, not its name or any prompt text", async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      lines.push(message);
    });
    await processor()(signedJob(wsA, projA));
    await settle();

    const metric = lines.find((l) => (l as { metric?: string }).metric === "nominara_capture_plan_runs_total");
    expect(metric).toMatchObject({ metric: "nominara_capture_plan_runs_total", outcome: "planned" });
    const event = lines.find((l) => (l as { event?: string }).event === "capture.plan.planned");
    expect(event).toMatchObject({ workspace_id: wsA, project_id: projA });
    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain("best crm");
  });
});
