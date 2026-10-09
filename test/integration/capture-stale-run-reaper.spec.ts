import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { FAIR_USE_METRIC } from "../../src/lib/capture/fair-use.js";
import { SchedulerSweepRuntime } from "../../src/lib/capture/scheduler-sweep.js";
import { STALE_QUEUED_RUN_BOUND_MS, reapStaleQueuedRuns } from "../../src/lib/capture/stale-run-reaper.js";

// NEW-A-13 checkpoint-4 (second-engineer finding 4) — a crash between the
// planning COMMIT and the fire-and-forget dispatch leaves a run `queued`
// forever with its fair-use reservation consumed; next_run_at already moved,
// so nothing replans it. The reaper fails such a run once it is older than a
// bound and gives the reservation back, in the run's own tenant context.

const HOUR_MS = 60 * 60 * 1000;

describe("NEW-A-13 checkpoint-4 · the stale queued-run reaper", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let owner: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
  }, 300_000);

  afterAll(async () => {
    await owner.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE capture_runs, usage_counters, projects, workspaces CASCADE");
  });

  afterEach(() => vi.restoreAllMocks());

  async function addTenant(reserved: number): Promise<{ ws: string; project: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'Secret Co Name',$2,'business')", [
      ws,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')",
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, reserved_value)
       VALUES ($1,$2,date_trunc('month', now())::date,1000,$3)`,
      [ws, FAIR_USE_METRIC, reserved],
    );
    return { ws, project };
  }

  async function addRun(
    tenant: { ws: string; project: string },
    options: { ageHours: number; status?: string; trigger?: string; planned?: number; skipped?: number },
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, skipped_cells, status, created_at)
       VALUES ($1,$2,$3,$4,ARRAY['gemini'],$5,$6,$7, now() - ($8 || ' hours')::interval)`,
      [
        id,
        tenant.ws,
        tenant.project,
        options.trigger ?? "scheduled",
        options.planned ?? 10,
        options.skipped ?? 0,
        options.status ?? "queued",
        String(options.ageHours),
      ],
    );
    return id;
  }

  const runRow = async (id: string) =>
    (await db.query<{ status: string; error_summary: unknown; finished_at: Date | null }>(
      "SELECT status, error_summary, finished_at FROM capture_runs WHERE id = $1",
      [id],
    )).rows[0]!;

  const reserved = async (ws: string) =>
    (await db.query<{ v: string }>("SELECT reserved_value::text AS v FROM usage_counters WHERE workspace_id = $1", [ws])).rows[0]!.v;

  it("NEW-A-13 CP4-4a · a scheduled run queued past the bound is failed with reason stale_queued and its reservation (planned - skipped) is released", async () => {
    const tenant = await addTenant(10);
    const run = await addRun(tenant, { ageHours: 7, planned: 10, skipped: 3 });
    await db.query("UPDATE usage_counters SET reserved_value = 12 WHERE workspace_id = $1", [tenant.ws]);

    const result = await reapStaleQueuedRuns(owner, new Date());

    expect(result).toEqual({ reaped: 1 });
    expect(await runRow(run)).toMatchObject({ status: "failed", error_summary: { reason: "stale_queued" } });
    expect((await runRow(run)).finished_at).not.toBeNull();
    expect(await reserved(tenant.ws)).toBe("5"); // 12 - (10 - 3)
  });

  it("NEW-A-13 CP4-4b · a run younger than the bound, a running run and a manual run are left alone", async () => {
    const tenant = await addTenant(40);
    const fresh = await addRun(tenant, { ageHours: 1 });
    const justInside = await addRun(tenant, { ageHours: STALE_QUEUED_RUN_BOUND_MS / HOUR_MS - 0.5 });
    const running = await addRun(tenant, { ageHours: 30, status: "running" });
    const manual = await addRun(tenant, { ageHours: 30, trigger: "manual" });

    const result = await reapStaleQueuedRuns(owner, new Date());

    expect(result).toEqual({ reaped: 0 });
    expect((await runRow(fresh)).status).toBe("queued");
    expect((await runRow(justInside)).status).toBe("queued");
    expect((await runRow(running)).status).toBe("running");
    expect((await runRow(manual)).status).toBe("queued");
    expect(await reserved(tenant.ws)).toBe("40");
  });

  it("NEW-A-13 CP4-4c · reaping twice releases once", async () => {
    const tenant = await addTenant(20);
    await addRun(tenant, { ageHours: 8, planned: 10 });

    await reapStaleQueuedRuns(owner, new Date());
    const second = await reapStaleQueuedRuns(owner, new Date());

    expect(second).toEqual({ reaped: 0 });
    expect(await reserved(tenant.ws)).toBe("10");
  });

  it("NEW-A-13 CP4-4d · each workspace's own counter is credited, across tenants", async () => {
    const a = await addTenant(10);
    const b = await addTenant(10);
    await addRun(a, { ageHours: 9, planned: 4 });
    await addRun(b, { ageHours: 9, planned: 6 });

    await expect(reapStaleQueuedRuns(owner, new Date())).resolves.toEqual({ reaped: 2 });

    expect(await reserved(a.ws)).toBe("6");
    expect(await reserved(b.ws)).toBe("4");
  });

  it("NEW-A-13 CP4-4e · the reservation never goes below zero", async () => {
    const tenant = await addTenant(3);
    await addRun(tenant, { ageHours: 9, planned: 10 });
    await reapStaleQueuedRuns(owner, new Date());
    expect(await reserved(tenant.ws)).toBe("0");
  });

  it("NEW-A-13 CP4-4f · the sweep runtime's tick reaps stale runs", async () => {
    const tenant = await addTenant(10);
    const run = await addRun(tenant, { ageHours: 9, planned: 10 });
    const runtime = new SchedulerSweepRuntime({
      connect: () => {
        const client = new Client({ connectionString: container.getConnectionUri() });
        return client.connect().then(() => client);
      },
      enqueue: () => Promise.resolve(),
    });

    await runtime.tick();

    expect((await runRow(run)).status).toBe("failed");
    expect(await reserved(tenant.ws)).toBe("0");
  }, 60_000);

  it("NEW-A-13 CP4-4g · observability: a metric per reaped run and a log line with the workspace id, never its name", async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(message));
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void lines.push(message));
    const tenant = await addTenant(10);
    const run = await addRun(tenant, { ageHours: 9 });

    await reapStaleQueuedRuns(owner, new Date());

    expect(lines.find((l) => (l as { metric?: string }).metric === "nominara_capture_stale_runs_reaped_total")).toBeDefined();
    expect(lines.find((l) => (l as { event?: string }).event === "capture.run.reaped_stale")).toMatchObject({
      workspace_id: tenant.ws,
      run_id: run,
    });
    expect(JSON.stringify(lines)).not.toContain("Secret Co Name");
  });
});
