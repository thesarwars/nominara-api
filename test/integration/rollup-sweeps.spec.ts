import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { Redis } from "ioredis";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { EnqueueRollup } from "../../src/lib/queue/handlers/run-rollup-request.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { type DirtyEntry, RollupDirtySet } from "../../src/lib/rollup/dirty-dates.js";
import {
  RollupSweepBlindError,
  closedDayJobKey,
  dirtyDateJobKey,
  runClosedDaySweep,
  runDirtyDateSweep,
} from "../../src/lib/rollup/rollup-sweep.js";
import { rollUpDay } from "../../src/lib/rollup/roll-up-day.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-042 — AC2 (closed-day rollup), AC6 (dirty dates, Scenario 7), AC11 (freshness).

const ANSWER = "## Best CRMs\n\n1. **HubSpot** — we recommend it.\n2. Salesforce — deeper reporting.";

interface Enqueued {
  queue: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

describe("STORY-042 · closed-day sweep, dirty-date sweep, freshness", () => {
  let container: StartedPostgreSqlContainer;
  let valkey: ValkeyFixture;
  let redis: Redis;
  let db: Client;
  let sweepDb: Client;
  let appDb: Client;
  let dirty: RollupDirtySet;
  let enqueued: Enqueued[];
  let sampleCounter = 0;

  const connect = async (user = "nominara", password = "nominara"): Promise<Client> => {
    const client = new Client({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user, password });
    await client.connect();
    return client;
  };
  const collector: EnqueueRollup = async (queue, workspaceId, payload, idempotencyKey) => {
    enqueued.push({ queue, workspaceId, payload, idempotencyKey });
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    valkey = await startValkeyFixture();
    redis = new Redis(valkey.connectionString);
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const appPassword = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(appPassword)}`);
    appDb = await connect("nominara_app", appPassword);
    sweepDb = await connect();
  }, 300_000);

  afterAll(async () => {
    await Promise.all([appDb.end(), sweepDb.end(), db.end()]);
    redis.disconnect();
    await valkey.stop();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces CASCADE");
    await redis.flushall();
    dirty = new RollupDirtySet(redis, `test:global:rollup_dirty:${randomUUID()}`);
    enqueued = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedProject(timezone: string, options: { deleted?: boolean; workspaceDeleted?: boolean } = {}): Promise<{ workspaceId: string; projectId: string; promptId: string }> {
    const w = randomUUID();
    const p = randomUUID();
    const q = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone, deleted_at) VALUES ($1,'Secret Co',$2,'growth',$3,$4)", [
      w,
      `w-${randomUUID().slice(0, 8)}`,
      timezone,
      options.workspaceDeleted ? new Date() : null,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, deleted_at)
       VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com',$4)`,
      [p, w, `p-${randomUUID().slice(0, 8)}`, options.deleted ? new Date() : null],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [q, w, p],
    );
    return { workspaceId: w, projectId: p, promptId: q };
  }

  async function seedCapture(
    ids: { workspaceId: string; projectId: string; promptId: string },
    capturedAt: string,
    status: "captured" | "parsed" | "failed" = "parsed",
    runId: string = uuidV7(),
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, response_excerpt,
          payload, flags, cache_layer, status, sample_index)
       VALUES ($1,$2,$3,$4,$5,'gemini',$6::timestamptz,'api','1.0.0','n1',$7,$8,$9::jsonb,'{}','live',$10,$11)`,
      [id, ids.workspaceId, ids.projectId, runId, ids.promptId, capturedAt, createHash("sha256").update(randomUUID()).digest(), ANSWER.slice(0, 280), JSON.stringify({ format: "markdown", text: ANSWER }), status, sampleCounter++],
    );
    return id;
  }

  async function seedRolledRow(ids: { workspaceId: string; projectId: string }, metricDate: string, computedAt: string): Promise<void> {
    await db.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, cells_total, scoring_version, computed_at)
       VALUES ($1,$2,'gemini','brand',$2,$3,1,'v1',$4::timestamptz)`,
      [ids.workspaceId, ids.projectId, metricDate, computedAt],
    );
  }

  describe("AC2 · the closed-day rollup at 00:20 workspace-local (EC-11)", () => {
    it("STORY-042 AC2 · enqueues the closed day once the WORKSPACE's clock has passed 00:20, per timezone", async () => {
      const tokyo = await seedProject("Asia/Tokyo");
      const la = await seedProject("America/Los_Angeles");
      // Tokyo's 2026-10-22 is 2026-10-21T15:00Z..10-22T15:00Z. LA's 2026-10-21 is 10-21T07:00Z..10-22T07:00Z.
      await seedCapture(tokyo, "2026-10-22T03:00:00Z");
      await seedCapture(la, "2026-10-21T20:00:00Z");

      // 15:10Z = Tokyo 00:10 on the 23rd (not yet 00:20), LA 08:10 on the 22nd.
      const early = await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T15:10:00Z"));
      expect(early.status).toBe("complete");
      expect(enqueued.map((e) => [e.workspaceId, e.payload.metricDate])).toEqual([[la.workspaceId, "2026-10-21"]]);

      enqueued = [];
      // 15:30Z = Tokyo 00:30 on the 23rd: its closed day (the 22nd) is due now.
      await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T15:30:00Z"));
      const byWorkspace = new Map(enqueued.map((e) => [e.workspaceId, e]));
      expect(byWorkspace.get(tokyo.workspaceId)).toMatchObject({
        queue: "rollup.metric_daily",
        payload: { projectId: tokyo.projectId, metricDate: "2026-10-22", reason: "closed_day" },
        idempotencyKey: closedDayJobKey(tokyo.projectId, "2026-10-22"),
      });
      expect(byWorkspace.get(la.workspaceId)?.payload.metricDate).toBe("2026-10-21");
      expect(closedDayJobKey(tokyo.projectId, "2026-10-22")).toBe(`rollup:${tokyo.projectId}:closed:2026-10-22`);
    }, 60_000);

    it("STORY-042 AC2 · the boundary is exactly 00:20 workspace-local: due at 00:20:00, not at 00:19:59", async () => {
      const ids = await seedProject("Asia/Kolkata");
      // Kolkata is +05:30: 2026-10-22 local is 10-21T18:30Z..10-22T18:30Z, so 00:20 on the 23rd is 18:50Z on the 22nd.
      await seedCapture(ids, "2026-10-22T06:00:00Z");
      await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T18:49:59Z"));
      expect(enqueued, "00:19:59 local").toEqual([]);
      await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T18:50:00Z"));
      expect(enqueued.map((e) => e.payload.metricDate), "00:20:00 local").toEqual(["2026-10-22"]);
    }, 60_000);

    it("STORY-042 AC2 · the sweep run twice for the same instant asks for the same key (one job per project and date)", async () => {
      const ids = await seedProject("UTC");
      await seedCapture(ids, "2026-10-21T12:00:00Z");
      const now = new Date("2026-10-22T09:00:00Z");
      await runClosedDaySweep(sweepDb, collector, now);
      await runClosedDaySweep(sweepDb, collector, new Date(now.getTime() + 15 * 60_000));
      expect(new Set(enqueued.map((e) => e.idempotencyKey)).size).toBe(1);
    }, 60_000);

    it("STORY-042 AC2 · a closed day already rolled up AFTER the close is not enqueued again", async () => {
      const ids = await seedProject("UTC");
      await seedCapture(ids, "2026-10-21T12:00:00Z");
      await seedRolledRow(ids, "2026-10-21", "2026-10-22T00:25:00Z");
      await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T09:00:00Z"));
      expect(enqueued).toEqual([]);
    }, 60_000);

    it("STORY-042 AC2 · a day rolled up only BEFORE the close (an intraday run) is still enqueued", async () => {
      const ids = await seedProject("UTC");
      await seedCapture(ids, "2026-10-21T12:00:00Z");
      await seedRolledRow(ids, "2026-10-21", "2026-10-21T13:00:00Z");
      // and one rolled between midnight and 00:20, inside the settling grace
      const other = await seedProject("UTC");
      await seedCapture(other, "2026-10-21T12:00:00Z");
      await seedRolledRow(other, "2026-10-21", "2026-10-22T00:10:00Z");
      await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T09:00:00Z"));
      expect(new Set(enqueued.map((e) => e.workspaceId))).toEqual(new Set([ids.workspaceId, other.workspaceId]));
    }, 60_000);

    it("STORY-042 AC2 · a project with no measured cells on the closed day, a failed-only day, or a deleted project or workspace is never enqueued", async () => {
      const quiet = await seedProject("UTC");
      const failedOnly = await seedProject("UTC");
      await seedCapture(failedOnly, "2026-10-21T12:00:00Z", "failed");
      const otherDay = await seedProject("UTC");
      await seedCapture(otherDay, "2026-10-20T12:00:00Z");
      const deleted = await seedProject("UTC", { deleted: true });
      await seedCapture(deleted, "2026-10-21T12:00:00Z");
      const wsDeleted = await seedProject("UTC", { workspaceDeleted: true });
      await seedCapture(wsDeleted, "2026-10-21T12:00:00Z");
      const live = await seedProject("UTC");
      await seedCapture(live, "2026-10-21T12:00:00Z");

      const result = await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T09:00:00Z"));
      expect(enqueued.map((e) => e.workspaceId)).toEqual([live.workspaceId]);
      expect(result).toMatchObject({ status: "complete", found: 1, enqueued: 1, failed: 0 });
      expect([quiet, failedOnly, otherDay].length).toBe(3);
    }, 60_000);

    it("STORY-042 AC2 · a failed enqueue is reported as partial and does not stop the others", async () => {
      const a = await seedProject("UTC");
      const b = await seedProject("UTC");
      await seedCapture(a, "2026-10-21T12:00:00Z");
      await seedCapture(b, "2026-10-21T12:00:00Z");
      const flaky: EnqueueRollup = async (queue, workspaceId, payload, key) => {
        if (workspaceId === a.workspaceId) throw new Error("queue down");
        await collector(queue, workspaceId, payload, key);
      };
      const result = await runClosedDaySweep(sweepDb, flaky, new Date("2026-10-22T09:00:00Z"));
      expect(result).toMatchObject({ status: "partial", found: 2, enqueued: 1, failed: 1 });
      expect(enqueued.map((e) => e.workspaceId)).toEqual([b.workspaceId]);
    }, 60_000);

    it("STORY-042 AC2 · one workspace with an unrecognised stored timezone is skipped and counted; every other tenant's closed day is still enqueued", async () => {
      const bad = await seedProject("US/Eastrn");
      const good = await seedProject("UTC");
      await seedCapture(bad, "2026-10-21T12:00:00Z");
      await seedCapture(good, "2026-10-21T12:00:00Z");
      const lines: unknown[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(message));
      vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void lines.push(message));

      const result = await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T09:00:00Z"));
      expect(enqueued.map((e) => e.workspaceId)).toEqual([good.workspaceId]);
      expect(result).toMatchObject({ status: "complete", found: 1, enqueued: 1, failed: 0 });
      const text = JSON.stringify(lines);
      expect(text).toContain("nominara_rollup_sweep_invalid_timezone_total");
      expect(text).toContain(bad.workspaceId);
      expect(text).not.toContain("US/Eastrn");
    }, 60_000);

    it("STORY-042 AC2 · a connection that cannot see across tenants is refused before it reads anything", async () => {
      const ids = await seedProject("UTC");
      await seedCapture(ids, "2026-10-21T12:00:00Z");
      await expect(runClosedDaySweep(appDb, collector, new Date("2026-10-22T09:00:00Z"))).rejects.toBeInstanceOf(RollupSweepBlindError);
      expect(enqueued).toEqual([]);
    }, 60_000);

    it("STORY-042 AC2 · the sweep writes no tenant data (metric_daily is untouched) and its log lines carry ids, never a workspace name", async () => {
      const ids = await seedProject("UTC");
      await seedCapture(ids, "2026-10-21T12:00:00Z");
      const lines: unknown[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(message));
      await runClosedDaySweep(sweepDb, collector, new Date("2026-10-22T09:00:00Z"));
      expect((await db.query("SELECT 1 FROM metric_daily")).rowCount).toBe(0);
      const text = JSON.stringify(lines);
      expect(text).toContain("rollup.sweep.closed_day");
      expect(text).toContain(ids.workspaceId);
      expect(text).not.toContain("Secret Co");
    }, 60_000);
  });

  describe("AC6 · dirty dates (EC-12, Scenario 7)", () => {
    const entry = (ids: { workspaceId: string; projectId: string }, metricDate = "2026-10-21"): DirtyEntry => ({ workspaceId: ids.workspaceId, projectId: ids.projectId, metricDate });

    it("STORY-042 AC6 · the dirty sweep enqueues one job per entry, then removes it; a failed enqueue keeps it", async () => {
      const a = entry(await seedProject("UTC"));
      const b = entry(await seedProject("UTC"));
      await dirty.mark(a);
      await dirty.mark(b);
      const now = new Date("2026-10-22T09:15:00Z");
      const flaky: EnqueueRollup = async (queue, workspaceId, payload, key) => {
        if (workspaceId === a.workspaceId) throw new Error("queue down");
        await collector(queue, workspaceId, payload, key);
      };
      const bVersion = (await dirty.peek(10)).entries.find((e) => e.workspaceId === b.workspaceId)!.version;
      const result = await runDirtyDateSweep(dirty, flaky, now);
      expect(result).toMatchObject({ status: "partial", found: 2, enqueued: 1, failed: 1 });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        queue: "rollup.metric_daily",
        workspaceId: b.workspaceId,
        payload: { projectId: b.projectId, metricDate: "2026-10-21", reason: "dirty_date" },
        idempotencyKey: dirtyDateJobKey(b.projectId, "2026-10-21", bVersion),
      });
      // b is gone from the set, a is still waiting for the next tick.
      expect((await dirty.peek(10)).entries).toMatchObject([a]);
      expect((await runDirtyDateSweep(dirty, collector, new Date(now.getTime() + 15 * 60_000))).enqueued).toBe(1);
      expect((await dirty.peek(10)).entries).toEqual([]);
    }, 60_000);

    it("STORY-042 AC6 · a mark that lands between the sweep's enqueue and its clear survives (real Valkey, atomic compare-and-remove)", async () => {
      const a = entry(await seedProject("UTC"));
      await dirty.mark(a);
      const racing: EnqueueRollup = async (queue, workspaceId, payload, key) => {
        await collector(queue, workspaceId, payload, key);
        await dirty.mark(a); // a late fact commits while the job is already reading facts
      };
      await runDirtyDateSweep(dirty, racing, new Date("2026-10-22T09:15:00Z"));
      expect((await dirty.peek(10)).entries, "the re-marked entry is still waiting").toMatchObject([a]);
      await runDirtyDateSweep(dirty, collector, new Date("2026-10-22T09:20:00Z"));
      expect(new Set(enqueued.map((e) => e.idempotencyKey)).size, "the newer mark is a NEW job, not deduplicated onto the one that missed it").toBe(2);
      expect((await dirty.peek(10)).entries).toEqual([]);
    }, 60_000);

    it("STORY-042 AC6 · replicas that read the same version ask for the same key", async () => {
      const a = entry(await seedProject("UTC"));
      await dirty.mark(a);
      const [seen] = (await dirty.peek(10)).entries;
      expect(dirtyDateJobKey(a.projectId, "2026-10-21", seen!.version)).toBe(dirtyDateJobKey(a.projectId, "2026-10-21", seen!.version));
      await runDirtyDateSweep(dirty, collector, new Date("2026-10-22T09:15:00Z"));
      expect(enqueued[0]!.idempotencyKey).toBe(dirtyDateJobKey(a.projectId, "2026-10-21", seen!.version));
    }, 60_000);

    it("STORY-042 AC6 · an empty set is a complete sweep of nothing", async () => {
      expect(await runDirtyDateSweep(dirty, collector, new Date())).toMatchObject({ status: "complete", found: 0, enqueued: 0, failed: 0 });
    }, 60_000);

    // --- the writer (the parse path) ---
    function parseHandler(markRollupDirty?: (e: DirtyEntry) => Promise<void>) {
      const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
      return createCaptureParseHandler(context, {
        enqueueRollup: async () => undefined,
        ...(markRollupDirty !== undefined ? { markRollupDirty } : {}),
      });
    }
    function parseJob(ids: { workspaceId: string; projectId: string; promptId: string }, resultId: string, capturedAt: string): Job {
      return { data: { payload: { workspaceId: ids.workspaceId, kid: "k", resultId, projectId: ids.projectId, promptId: ids.promptId, engineKey: "gemini", capturedAt, force: false } } } as unknown as Job;
    }
    const parseInTenant = (ids: { workspaceId: string; projectId: string; promptId: string }, resultId: string, capturedAt: string, mark: (e: DirtyEntry) => Promise<void>, after?: () => void) =>
      withTenantContext(db, { workspaceId: ids.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await parseHandler(mark)(tx, parseJob(ids, resultId, capturedAt));
        after?.();
      });

    it("STORY-042 AC6 · a fact landing on a CLOSED, already-rolled-up day marks that workspace-local date dirty, after commit", async () => {
      const ids = await seedProject("Asia/Tokyo");
      // 23:30Z on the 10th is the 11th in Tokyo.
      const at = "2026-03-10T23:30:00.000Z";
      await seedCapture(ids, at, "parsed");
      await rollUpDay(db, ids.workspaceId, ids.projectId, "2026-03-11", "Asia/Tokyo");
      const late = await seedCapture(ids, at, "captured");

      const marks: DirtyEntry[] = [];
      let markedBeforeCommit = true;
      await parseInTenant(ids, late, at, async (e) => void marks.push(e), () => {
        markedBeforeCommit = marks.length > 0;
      });
      expect(markedBeforeCommit, "marked inside the transaction").toBe(false);
      expect(marks).toEqual([{ workspaceId: ids.workspaceId, projectId: ids.projectId, metricDate: "2026-03-11" }]);
    }, 60_000);

    it("STORY-042 AC6 · a workspace with an unrecognised stored timezone does not fail its parses: nothing is marked, and the skip is counted with the workspace id", async () => {
      const ids = await seedProject("US/Eastrn");
      const at = "2026-03-10T12:00:00.000Z";
      const late = await seedCapture(ids, at, "captured");
      const lines: unknown[] = [];
      vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void lines.push(message));
      vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(message));
      const marks: DirtyEntry[] = [];
      await parseInTenant(ids, late, at, async (e) => void marks.push(e));
      expect((await db.query("SELECT status FROM answer_captures WHERE id = $1", [late])).rows[0].status).toBe("parsed");
      expect(marks).toEqual([]);
      expect(JSON.stringify(lines)).toContain("nominara_rollup_dirty_invalid_timezone_total");
      expect(JSON.stringify(lines)).toContain(ids.workspaceId);
    }, 60_000);

    it("STORY-042 AC6 · the parse worker group hands the handler its dirty-set writer through the context; the handler opens no connection of its own", async () => {
      const ids = await seedProject("UTC");
      const at = "2026-03-10T12:00:00.000Z";
      await seedCapture(ids, at, "parsed");
      await rollUpDay(db, ids.workspaceId, ids.projectId, "2026-03-10", "UTC");
      const late = await seedCapture(ids, at, "captured");
      const marks: DirtyEntry[] = [];
      const context = { pool: undefined, env: {}, markRollupDirty: async (e: DirtyEntry) => void marks.push(e) } as unknown as QueueHandlerContext;
      await withTenantContext(db, { workspaceId: ids.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await createCaptureParseHandler(context, { enqueueRollup: async () => undefined })(tx, parseJob(ids, late, at));
      });
      await vi.waitFor(() => expect(marks).toHaveLength(1));
    }, 60_000);

    it("STORY-042 AC6 · a parse that rolls back marks nothing", async () => {
      const ids = await seedProject("UTC");
      const at = "2026-03-10T12:00:00.000Z";
      await seedCapture(ids, at, "parsed");
      await rollUpDay(db, ids.workspaceId, ids.projectId, "2026-03-10", "UTC");
      const late = await seedCapture(ids, at, "captured");
      const marks: DirtyEntry[] = [];
      await expect(
        parseInTenant(ids, late, at, async (e) => void marks.push(e), () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(marks).toEqual([]);
    }, 60_000);

    it("STORY-042 AC6 · the OPEN day is not marked: the next run's rollup carries it", async () => {
      const ids = await seedProject("UTC");
      const marks: DirtyEntry[] = [];
      const today = new Date().toISOString();
      await seedCapture(ids, today, "parsed");
      await rollUpDay(db, ids.workspaceId, ids.projectId, today.slice(0, 10), "UTC");
      const lateToday = await seedCapture(ids, today, "captured");
      await parseInTenant(ids, lateToday, today, async (e) => void marks.push(e));
      expect(marks).toEqual([]);
    }, 60_000);

    it("STORY-042 AC6 · a closed day with NO row is marked too: a fact landing while the day's first rollup is mid-flight is never missed (an extra reprocess is idempotent)", async () => {
      const ids = await seedProject("UTC");
      const closed = "2026-03-10T12:00:00.000Z";
      const notRolled = await seedCapture(ids, closed, "captured");
      const marks: DirtyEntry[] = [];
      await parseInTenant(ids, notRolled, closed, async (e) => void marks.push(e));
      expect(marks).toEqual([{ workspaceId: ids.workspaceId, projectId: ids.projectId, metricDate: "2026-03-10" }]);
    }, 60_000);

    it("STORY-042 AC6 · a fact on a day three days back that was never rolled up is marked — the closed-day sweep only looks at yesterday", async () => {
      const ids = await seedProject("UTC");
      const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const late = await seedCapture(ids, old, "captured");
      const marks: DirtyEntry[] = [];
      await parseInTenant(ids, late, old, async (e) => void marks.push(e));
      expect(marks.map((m) => m.metricDate)).toEqual([old.slice(0, 10)]);
    }, 60_000);

    it("STORY-042 AC6 · a failed mark is logged and counted, and never fails the parse", async () => {
      const ids = await seedProject("UTC");
      const at = "2026-03-10T12:00:00.000Z";
      await seedCapture(ids, at, "parsed");
      await rollUpDay(db, ids.workspaceId, ids.projectId, "2026-03-10", "UTC");
      const late = await seedCapture(ids, at, "captured");
      const errors: unknown[] = [];
      vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void errors.push(message));
      const logs: unknown[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(message));

      await parseInTenant(ids, late, at, async () => {
        throw new Error("valkey down");
      });
      await vi.waitFor(() => expect(JSON.stringify(errors)).toContain("rollup.dirty_mark_failed"));
      expect(JSON.stringify(logs)).toContain("nominara_rollup_dirty_mark_failed_total");
      expect((await db.query("SELECT status FROM answer_captures WHERE id = $1", [late])).rows[0].status).toBe("parsed");
    }, 60_000);

    it("STORY-042 AC6 · a mark that fails once is retried in-process and lands: nothing is lost, nothing is reported failed", async () => {
      const ids = await seedProject("UTC");
      const at = "2026-03-10T12:00:00.000Z";
      await seedCapture(ids, at, "parsed");
      await rollUpDay(db, ids.workspaceId, ids.projectId, "2026-03-10", "UTC");
      const late = await seedCapture(ids, at, "captured");
      const errors: unknown[] = [];
      vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void errors.push(message));
      let attempts = 0;
      const marks: DirtyEntry[] = [];
      await parseInTenant(ids, late, at, async (e) => {
        attempts += 1;
        if (attempts < 3) throw new Error("valkey blip");
        marks.push(e);
      });
      await vi.waitFor(() => expect(marks).toHaveLength(1));
      expect(attempts).toBe(3);
      expect(JSON.stringify(errors)).not.toContain("rollup.dirty_mark_failed");
    }, 60_000);

    it("STORY-042 Scenario 7 · a fact landing after the day closed is marked dirty and REPROCESSED by the next dirty sweep", async () => {
      const ids = await seedProject("Asia/Tokyo");
      const at = "2026-03-10T23:30:00.000Z";
      await seedCapture(ids, at, "parsed");
      await rollUpDay(db, ids.workspaceId, ids.projectId, "2026-03-11", "Asia/Tokyo");
      const before = await db.query("SELECT cells_total FROM metric_daily WHERE project_id = $1 AND entity_type = 'brand'", [ids.projectId]);
      expect(before.rows[0].cells_total).toBe(1);

      const late = await seedCapture(ids, at, "captured");
      await parseInTenant(ids, late, at, (e) => dirty.mark(e));
      await vi.waitFor(async () => expect((await dirty.peek(10)).entries).toHaveLength(1));

      await runDirtyDateSweep(dirty, collector, new Date());
      expect(enqueued).toHaveLength(1);
      const rollup = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext);
      await rollup(db, { id: "j1", timestamp: Date.now(), data: { payload: { ...enqueued[0]!.payload, workspaceId: ids.workspaceId, kid: "k" } } } as unknown as Job);

      const after = await db.query("SELECT cells_total FROM metric_daily WHERE project_id = $1 AND entity_type = 'brand'", [ids.projectId]);
      expect(after.rows[0].cells_total).toBe(2);
    }, 60_000);
  });

  describe("AC11 · rollup freshness (SLO-14)", () => {
    async function runRollup(reason: string | undefined, timestamp: number | undefined): Promise<{ logs: unknown[] }> {
      const ids = await seedProject("UTC");
      const at = "2026-03-10T12:00:00.000Z";
      await seedCapture(ids, at, "parsed");
      const logs: unknown[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(message));
      const payload = { workspaceId: ids.workspaceId, kid: "k", projectId: ids.projectId, metricDate: "2026-03-10", ...(reason !== undefined ? { reason } : {}) };
      await withTenantContext(db, { workspaceId: ids.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await h(tx, { id: "j", ...(timestamp !== undefined ? { timestamp } : {}), data: { payload } } as unknown as Job);
      });
      return { logs };
    }
    let h: ReturnType<typeof createRollupMetricDailyHandler>;
    beforeEach(() => {
      h = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
        enqueueTaskGenerate: async () => undefined,
        enqueueVerifyPresence: async () => undefined,
      });
    });

    const observation = (logs: unknown[]) => logs.find((l) => typeof l === "object" && l !== null && (l as { event?: string }).event === "rollup.freshness") as { lag_seconds: number; within_slo: boolean; workspace_id: string } | undefined;

    it("STORY-042 AC11 · a parse-triggered rollup reports lag from enqueue to commit, and counts it inside the 15-minute objective", async () => {
      const { logs } = await runRollup("run_parsed", Date.now() - 120_000);
      const seen = observation(logs);
      expect(seen).toBeDefined();
      expect(seen!.lag_seconds).toBeGreaterThanOrEqual(120);
      expect(seen!.lag_seconds).toBeLessThan(180);
      expect(seen!.within_slo).toBe(true);
      expect(JSON.stringify(logs)).toContain("nominara_rollup_freshness_observations_total");
    }, 60_000);

    it("STORY-042 AC11 · a rollup that waited longer than 15 minutes is counted OUTSIDE the objective", async () => {
      const { logs } = await runRollup("run_parsed", Date.now() - 16 * 60_000);
      expect(observation(logs)!.within_slo).toBe(false);
    }, 60_000);

    it("STORY-042 AC11 · exactly 15 minutes is inside the objective (at most 15 min)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-22T10:15:00.000Z"));
        const { logs } = await runRollup("run_parsed", new Date("2026-10-22T10:00:00.000Z").getTime());
        expect(observation(logs)!.within_slo).toBe(true);
        expect(observation(logs)!.lag_seconds).toBe(900);
      } finally {
        vi.useRealTimers();
      }
    }, 60_000);

    it("STORY-042 AC11 · closed-day, dirty-date and rebuild rollups are not parse-to-metric latency and report nothing; neither does a job with no timestamp", async () => {
      for (const reason of ["closed_day", "dirty_date", "rebuild"]) {
        expect(observation((await runRollup(reason, Date.now() - 60_000)).logs), reason).toBeUndefined();
      }
      expect(observation((await runRollup("run_parsed", undefined)).logs), "no enqueue time, no figure (never 0)").toBeUndefined();
    }, 120_000);
  });
});
