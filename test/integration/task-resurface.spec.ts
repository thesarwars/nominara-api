import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { handlerFor, type QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createTaskResurfaceHandler } from "../../src/lib/queue/handlers/task-resurface.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import type { Env } from "../../src/config/env.schema.js";

// STORY-064 AC5 / scenario 6 — "Advance past the re-surface date: the task reappears."
//
// `task.resurface` is the daily workspace-agnostic sweep (a job scheduler tick, NOT a rollup step). Discovery is
// cross-tenant on the owner connection; every state change is applied in ONE tenant's context as `nominara_app`, so a
// resurface in workspace A can only ever touch A. The superuser would bypass RLS and make the isolation vacuous.

const counters: { name: string; labels: Record<string, string> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/telemetry/metrics.js")>("../../src/lib/telemetry/metrics.js");
  return {
    ...actual,
    incrementCounter: (name: string, labels: Record<string, string> = {}) => {
      counters.push({ name, labels });
      actual.incrementCounter(name, labels);
    },
  };
});

const DAY = 86_400_000;
const NOW = new Date("2027-04-01T02:10:00Z");
const tick = (): Job => ({ data: {} }) as unknown as Job;

describe("STORY-064 AC5 · task.resurface (dismissed tasks return after resurface_at)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let env: Env;
  let seq = 0;
  const exporter = new InMemorySpanExporter();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password });
    env = { DATABASE_URL: container.getConnectionUri() } as unknown as Env;
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("DROP TRIGGER IF EXISTS poison_events ON task_events");
    await db.query("TRUNCATE workspaces CASCADE");
    counters.length = 0;
    exporter.reset();
    seq = 0;
  });

  const context = (): QueueHandlerContext => ({ pool, env });
  const run = (deps: { now?: Date; batchSize?: number } = {}) =>
    createTaskResurfaceHandler(context(), { now: () => deps.now ?? NOW, ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }) })(db, tick());

  async function workspace(): Promise<string> {
    seq += 1;
    return (await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id", [`WS ${seq}`, `ws-${seq}-${randomUUID()}`])).rows[0]!.id;
  }
  async function project(ws: string, deleted = false): Promise<string> {
    seq += 1;
    return (await db.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, deleted_at) VALUES ($1, $2, $3, 'https://example.com', $4, $5) RETURNING id`,
      [ws, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`, deleted ? new Date() : null])).rows[0]!.id;
  }
  async function task(ws: string, p: string, o: { status?: string; resurfaceAt?: Date | null; deleted?: boolean } = {}): Promise<string> {
    seq += 1;
    const status = o.status ?? "dismissed";
    const id = (await db.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, dismissed_reason, resurface_at, deleted_at)
       VALUES ($1, $2, $3, 'content', $4, 'SECRET TITLE', 'D', $5, $6, $7, $8) RETURNING id`,
      [ws, p, `HUB-${seq}`, createHash("sha256").update(`t-${seq}-${randomUUID()}`).digest(), status,
        status === "dismissed" ? "SECRET REASON" : null, o.resurfaceAt === undefined ? new Date(NOW.getTime() - DAY) : o.resurfaceAt, o.deleted ? new Date() : null])).rows[0]!.id;
    await db.query("UPDATE projects SET open_task_count = (SELECT count(*) FROM tasks WHERE project_id = $1 AND status IN ('todo','in_progress') AND deleted_at IS NULL) WHERE id = $1", [p]);
    return id;
  }
  const state = async (id: string) =>
    (await db.query<{ status: string; dismissed_reason: string | null; resurface_at: Date | null }>("SELECT status, dismissed_reason, resurface_at FROM tasks WHERE id = $1", [id])).rows[0]!;
  const events = async (id: string) =>
    (await db.query<{ event: string; actor_id: string | null; actor_type: string; from_value: string | null; to_value: string | null; payload: Record<string, unknown> | null; workspace_id: string }>(
      "SELECT event, actor_id, actor_type, from_value, to_value, payload, workspace_id FROM task_events WHERE task_id = $1 ORDER BY occurred_at, id", [id])).rows;
  const openCount = async (p: string) => (await db.query<{ open_task_count: number }>("SELECT open_task_count FROM projects WHERE id = $1", [p])).rows[0]!.open_task_count;

  it("[STORY-064 #6] advancing past the re-surface date reopens the task, clears reason and date, restores the open count and writes a system 'reopened' event", async () => {
    const ws = await workspace(); const p = await project(ws);
    const t = await task(ws, p);
    await task(ws, p, { status: "todo", resurfaceAt: null });
    expect(await openCount(p)).toBe(1);

    // Before the date: nothing returns.
    const early = await run({ now: new Date(NOW.getTime() - 2 * DAY) });
    expect(early).toMatchObject({ reopened: 0 });
    expect((await state(t)).status).toBe("dismissed");

    // After it: the task is back.
    const out = await run();
    expect(out).toMatchObject({ status: "complete", reopened: 1 });
    expect(await state(t)).toEqual({ status: "todo", dismissed_reason: null, resurface_at: null });
    expect(await openCount(p)).toBe(2);
    const ev = await events(t);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event: "reopened", actor_id: null, actor_type: "system", from_value: "dismissed", to_value: "todo", workspace_id: ws });
    expect(ev[0]!.payload).toMatchObject({ resurfaced: true });
  });

  it("a task whose re-surface date is exactly now is due (inclusive), and one a second away is not", async () => {
    const ws = await workspace(); const p = await project(ws);
    const due = await task(ws, p, { resurfaceAt: NOW });
    const notYet = await task(ws, p, { resurfaceAt: new Date(NOW.getTime() + 1000) });
    await run();
    expect((await state(due)).status).toBe("todo");
    expect((await state(notYet)).status).toBe("dismissed");
  });

  it("is idempotent: a second run (an at-least-once redelivery) reopens nothing and writes no second event", async () => {
    const ws = await workspace(); const p = await project(ws);
    const t = await task(ws, p);
    await run();
    const again = await run();
    expect(again).toMatchObject({ reopened: 0, status: "complete" });
    expect(await events(t)).toHaveLength(1);
    expect(await openCount(p)).toBe(1);
  });

  it("only a dismissed, live task past its date returns: done, open, no-date, soft-deleted and soft-deleted-project tasks are untouched", async () => {
    const ws = await workspace(); const p = await project(ws); const gone = await project(ws, true);
    const past = new Date(NOW.getTime() - DAY);
    const done = await task(ws, p, { status: "done", resurfaceAt: past });
    const open = await task(ws, p, { status: "in_progress", resurfaceAt: past });
    const noDate = await task(ws, p, { resurfaceAt: null });
    const deleted = await task(ws, p, { deleted: true });
    const inGone = await task(ws, gone);
    expect(await run()).toMatchObject({ reopened: 0 });
    expect((await state(done)).status).toBe("done");
    expect((await state(open)).status).toBe("in_progress");
    expect((await state(noDate)).status).toBe("dismissed");
    expect((await state(deleted)).status).toBe("dismissed");
    expect((await state(inGone)).status).toBe("dismissed");
    for (const t of [done, open, noDate, deleted, inGone]) expect(await events(t)).toEqual([]);
  });

  it("sweeps every workspace in one run, each applied in its own tenant: events and open counts land in the right workspace", async () => {
    const wsA = await workspace(); const wsB = await workspace();
    const pA = await project(wsA); const pB = await project(wsB);
    const a = await task(wsA, pA); const b1 = await task(wsB, pB); const b2 = await task(wsB, pB);
    const out = await run();
    expect(out).toMatchObject({ status: "complete", reopened: 3 });
    expect((await events(a))[0]!.workspace_id).toBe(wsA);
    expect((await events(b1))[0]!.workspace_id).toBe(wsB);
    expect((await events(b2))[0]!.workspace_id).toBe(wsB);
    expect(await openCount(pA)).toBe(1);
    expect(await openCount(pB)).toBe(2);
  });

  it("a snoozed task resurfaces on its own date, not the 180-day default", async () => {
    const ws = await workspace(); const p = await project(ws);
    const snoozed = await task(ws, p, { resurfaceAt: new Date(NOW.getTime() + 3 * DAY) });
    await run();
    expect((await state(snoozed)).status).toBe("dismissed");
    await run({ now: new Date(NOW.getTime() + 3 * DAY + 1000) });
    expect((await state(snoozed)).status).toBe("todo");
  });

  it("is bounded: batchSize caps one run, oldest date first, and the remainder is picked up next run", async () => {
    const ws = await workspace(); const p = await project(ws);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await task(ws, p, { resurfaceAt: new Date(NOW.getTime() - (10 - i) * DAY) }));
    expect(await run({ batchSize: 2 })).toMatchObject({ reopened: 2 });
    expect((await state(ids[0]!)).status).toBe("todo");
    expect((await state(ids[1]!)).status).toBe("todo");
    expect((await state(ids[2]!)).status).toBe("dismissed");
    expect(await run({ batchSize: 2 })).toMatchObject({ reopened: 2 });
    expect(await run({ batchSize: 2 })).toMatchObject({ reopened: 1 });
    expect(await openCount(p)).toBe(5);
  });

  it("one workspace failing does not stop the others: the run is 'partial', the failed workspace rolls back whole and is retried next run", async () => {
    const bad = await workspace(); const good = await workspace();
    const pBad = await project(bad); const pGood = await project(good);
    const tBad = await task(bad, pBad); const tGood = await task(good, pGood);
    await db.query(`CREATE OR REPLACE FUNCTION poison_events_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${bad}' THEN RAISE EXCEPTION 'poisoned'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER poison_events BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION poison_events_fn()");
    const out = await run();
    expect(out).toMatchObject({ status: "partial", reopened: 1, failed: 1 });
    expect((await state(tGood)).status).toBe("todo");
    expect((await state(tBad)).status).toBe("dismissed"); // rolled back whole: no reopened-without-event
    expect(await events(tBad)).toEqual([]);
    await db.query("DROP TRIGGER poison_events ON task_events");
    expect(await run()).toMatchObject({ status: "complete", reopened: 1 });
    expect((await state(tBad)).status).toBe("todo");
  });

  it("a task already reopened by hand before the sweep is not reopened again, and writes no event", async () => {
    const ws = await workspace(); const p = await project(ws);
    const t = await task(ws, p);
    await db.query("UPDATE tasks SET status = 'in_progress', dismissed_reason = NULL, resurface_at = NULL WHERE id = $1", [t]);
    expect(await run()).toMatchObject({ reopened: 0 });
    expect(await events(t)).toEqual([]);
  });

  it("is single-flight: a replica that does not get the advisory lock yields and touches nothing", async () => {
    const ws = await workspace(); const p = await project(ws);
    const t = await task(ws, p);
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      expect(await tryAdvisorySessionLock(holder, globalQueueLockKey("task.resurface"))).toBe(true);
      expect(await run()).toEqual({ status: "yielded" });
      expect((await state(t)).status).toBe("dismissed");
      expect(counters.some((c) => c.name === "nominara_tasks_resurface_yielded_total")).toBe(true);
    } finally {
      await holder.end();
    }
    expect(await run()).toMatchObject({ reopened: 1 });
  });

  it("observability: a span with counts, a counter, and a log line that carries IDs and counts only (no title, no dismissal reason)", async () => {
    const ws = await workspace(); const p = await project(ws);
    await task(ws, p);
    const lines: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => { lines.push(message); });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    const span = exporter.getFinishedSpans().find((s) => s.name === "task.resurface");
    expect(span).toBeDefined();
    expect(span!.attributes["nominara.task_resurface.reopened"]).toBe(1);
    expect(counters).toContainEqual({ name: "nominara_tasks_resurfaced_total", labels: {} });
    expect(counters.some((c) => c.name === "nominara_tasks_resurface_runs_total" && c.labels.status === "complete")).toBe(true);
    const logged = JSON.stringify(lines);
    expect(logged).toContain("task.resurface.run");
    expect(logged).not.toContain("SECRET");
  });

  it("is registered as the handler for the task.resurface queue", () => {
    expect(handlerFor("task.resurface")).toBeDefined();
  });
});
