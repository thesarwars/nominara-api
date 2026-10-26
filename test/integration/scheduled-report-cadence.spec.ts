import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createReportBuildHandler } from "../../src/lib/queue/handlers/report-build.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../src/lib/entitlements/structural-usage.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { reportBuildJobKey, scheduledRunDeliveryId, type ReportRunDeps } from "../../src/lib/reports/run-scheduled-report.js";
import { findDueReports, ReportSweepBlindError, runReportSweep, type EnqueueReportBuild } from "../../src/lib/reports/report-sweep.js";
import type { EmailMessage, EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { TEST_SIGNING_KEYS } from "../support/queue-test-harness.js";

// STORY-100 AC5 / AC8 / AC9 / AC10 / AC12 — the CADENCE path of a scheduled report: the sweep that finds a due report, and
// the `report.build` job that builds, sends and settles it. Real migrated Postgres; the handler runs as `nominara_app`
// (NOBYPASSRLS) through the real job processor, so signature verification, the tenant context and RLS are all live. The
// sweep runs as the owner (it must see across tenants); the blind-role scenario runs it as `nominara_app` on purpose.
//
// The mail transport is a recording fake: this suite never talks to Resend.

const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "report.build")!;
const ATTEMPTS = ENTRY.retry.delaysMs.length + 1;

describe("STORY-100 · scheduled reports on their cadence", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appDb: Client;
  let appPool: Pool;
  let sweepDb: Client;

  const connect = async (user = "nominara", password = "nominara"): Promise<Client> => {
    const client = new Client({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user, password });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const appPassword = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(appPassword)}`);
    appDb = await connect("nominara_app", appPassword);
    appPool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password: appPassword, max: 4 });
    sweepDb = await connect();
  }, 300_000);

  afterAll(async () => {
    await appPool.end();
    await Promise.all([appDb.end(), sweepDb.end(), db.end()]);
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE usage_reservations, usage_counters, notifications, notification_emails, scheduled_report_deliveries, scheduled_reports, report_artifacts, brand_themes, projects, workspaces CASCADE");
  });

  // ---- fixtures -----------------------------------------------------------------------------------------------------

  async function workspace(plan = "business", timezone = "UTC"): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, status, timezone) VALUES ($1,'Secret Co Name',$2,$3,'active',$4)", [id, `w-${randomUUID().slice(0, 8)}`, plan, timezone]);
    return id;
  }

  async function project(workspaceId: string, deleted = false): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, deleted_at) VALUES ($1,$2,'Acme Roofing',$3,'https://acme.test','acme.test',$4)`,
      [id, workspaceId, `p-${randomUUID().slice(0, 8)}`, deleted ? new Date() : null],
    );
    return id;
  }

  async function theme(workspaceId: string, fields: { name?: string | null; replyTo?: string | null } = {}, isDefault = true): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO brand_themes (id, workspace_id, name, is_default, email_from_name, email_reply_to) VALUES ($1,$2,'Agency',$3,$4,$5)`, [
      id, workspaceId, isDefault, fields.name ?? null, fields.replyTo ?? null,
    ]);
    return id;
  }

  async function report(
    workspaceId: string,
    projects: string[],
    over: { cadence?: string; day?: number; hour?: number; format?: string; due?: Date | null; active?: boolean; recipients?: string[]; themeId?: string | null } = {},
  ): Promise<{ id: string; due: Date }> {
    const id = randomUUID();
    const due = over.due === undefined ? new Date(Date.now() - 10 * 60_000) : over.due;
    await db.query(
      `INSERT INTO scheduled_reports (id, workspace_id, name, project_ids, cadence, day_of_period, send_hour_local, timeframe, format, recipients, theme_id, include_sections, next_send_at, active)
       VALUES ($1,$2,'Monthly client report',$3::uuid[],$4,$5,$6,'30d',$7,$8::citext[],$9,'{scorecards}',$10,$11)`,
      [id, workspaceId, projects, over.cadence ?? "weekly", over.day ?? 3, over.hour ?? 9, over.format ?? "pdf", over.recipients ?? ["client@example.test"], over.themeId ?? null, due, over.active ?? true],
    );
    return { id, due: due ?? new Date(0) };
  }

  const state = async (reportId: string) =>
    (await db.query<{ next_send_at: Date | null; last_sent_at: Date | null; last_error: string | null }>("SELECT next_send_at, last_sent_at, last_error FROM scheduled_reports WHERE id = $1", [reportId])).rows[0]!;
  const deliveries = async (reportId: string) =>
    (await db.query<{ id: string; status: string; reason: string | null; recipient_count: number }>(
      "SELECT id, status, reason, recipient_count FROM scheduled_report_deliveries WHERE scheduled_report_id = $1 ORDER BY attempted_at, id", [reportId])).rows;
  const unitsUsed = async (workspaceId: string) =>
    (await db.query<{ used: number; reserved: number }>("SELECT used_value::int AS used, reserved_value::int AS reserved FROM usage_counters WHERE workspace_id = $1 AND metric = 'pdf_exports'", [workspaceId])).rows[0];
  const notes = async (workspaceId: string, kind: string) =>
    (await db.query<{ body: string; severity: string; payload: Record<string, unknown> }>("SELECT body, severity, payload FROM notifications WHERE workspace_id = $1 AND kind = $2", [workspaceId, kind])).rows;
  const ledgerRows = async (workspaceId: string) =>
    (await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rowCount;

  function recordingSender(): EmailSender & { sent: EmailMessage[]; failNext: number; delivers: boolean } {
    const sender = {
      sent: [] as EmailMessage[],
      failNext: 0,
      delivers: true,
      async send(message: EmailMessage): Promise<void> {
        if (sender.failNext > 0) {
          sender.failNext -= 1;
          throw new Error(`provider said no to ${message.to}`);
        }
        sender.sent.push(message);
      },
    };
    return sender;
  }

  function processorFor(sender: EmailSender, run?: ReportRunDeps) {
    return createJobProcessor(ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => appDb,
      process: createReportBuildHandler({ pool: appPool, env: {} } as unknown as QueueHandlerContext, { sender, ...(run !== undefined ? { run } : {}) }),
    });
  }

  function jobFor(workspaceId: string, reportId: string, period: Date, attemptsMade = 0, extra: Record<string, unknown> = {}): Job {
    const envelope = signQueueJobPayload({ workspaceId, kid: TEST_SIGNING_KEYS.current.kid, reportId, period: period.toISOString(), ...extra }, TEST_SIGNING_KEYS.current.key);
    return { data: envelope, attemptsMade, opts: { attempts: ATTEMPTS } } as unknown as Job;
  }

  /** Real services over the app pool, but a build that always throws (a stand-in for a renderer fault). */
  function failingBuild(): ReportRunDeps {
    const resolver = new EntitlementResolver(new InMemoryCacheAdapter(), appPool);
    return {
      resolver,
      usage: new StructuralUsage(appPool),
      exports: { export: () => Promise.reject(new Error("renderer exploded while drawing client@example.test")) },
    };
  }

  // ---- the sweep ----------------------------------------------------------------------------------------------------

  describe("the sweep", () => {
    const collector = () => {
      const jobs: Array<{ workspaceId: string; payload: { reportId: string; period: string }; key: string }> = [];
      const enqueue: EnqueueReportBuild = async (_queue, workspaceId, payload, options) => void jobs.push({ workspaceId, payload, key: options.idempotencyKey });
      return { jobs, enqueue };
    };

    it("STORY-100 s7 · enqueues one signed-tenant job per DUE report, oldest first, keyed rep:{report}:{period}", async () => {
      const ws = await workspace();
      const p = await project(ws);
      const newest = await report(ws, [p], { due: new Date(Date.now() - 5 * 60_000) });
      const oldest = await report(ws, [p], { due: new Date(Date.now() - 50 * 60_000) });
      const { jobs, enqueue } = collector();
      const result = await runReportSweep(sweepDb, enqueue, new Date());
      expect(result).toMatchObject({ status: "complete", due: 2, enqueued: 2, failed: 0 });
      expect(jobs.map((j) => j.payload.reportId)).toEqual([oldest.id, newest.id]);
      for (const job of jobs) {
        expect(job.workspaceId).toBe(ws);
        expect(job.key).toBe(reportBuildJobKey(job.payload.reportId, new Date(job.payload.period)));
        expect(job.key).toMatch(/^rep:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}T/);
      }
    });

    it("STORY-100 s7 · a report not yet due, a paused one, and one with no next_send_at are not enqueued", async () => {
      const ws = await workspace();
      const p = await project(ws);
      await report(ws, [p], { due: new Date(Date.now() + 3_600_000) });
      await report(ws, [p], { active: false });
      await report(ws, [p], { due: null });
      const { jobs, enqueue } = collector();
      expect((await runReportSweep(sweepDb, enqueue, new Date())).due).toBe(0);
      expect(jobs).toEqual([]);
    });

    it("STORY-100 s7 · the sweep sees across tenants, and the payload names ids and the period only (no name, recipient or address)", async () => {
      const wsA = await workspace();
      const wsB = await workspace();
      await report(wsA, [await project(wsA)]);
      await report(wsB, [await project(wsB)]);
      const { jobs, enqueue } = collector();
      await runReportSweep(sweepDb, enqueue, new Date());
      expect(new Set(jobs.map((j) => j.workspaceId))).toEqual(new Set([wsA, wsB]));
      for (const job of jobs) expect(Object.keys(job.payload).sort()).toEqual(["period", "reportId"]);
      expect(JSON.stringify(jobs)).not.toMatch(/client@example\.test|Monthly client report|Secret Co Name/);
    });

    it("STORY-100 s7 · a repeated sweep derives the SAME key for the same still-due period (the queue's dedup holds)", async () => {
      const ws = await workspace();
      await report(ws, [await project(ws)]);
      const first = collector();
      const second = collector();
      await runReportSweep(sweepDb, first.enqueue, new Date());
      await runReportSweep(sweepDb, second.enqueue, new Date());
      expect(second.jobs.map((j) => j.key)).toEqual(first.jobs.map((j) => j.key));
    });

    it("STORY-100 s7 · one failed enqueue does not stop the batch: it is counted, the run is `partial`, and the report stays due", async () => {
      const ws = await workspace();
      const p = await project(ws);
      const a = await report(ws, [p], { due: new Date(Date.now() - 30 * 60_000) });
      const b = await report(ws, [p], { due: new Date(Date.now() - 10 * 60_000) });
      const seen: string[] = [];
      const result = await runReportSweep(sweepDb, async (_q, _w, payload) => {
        seen.push(payload.reportId);
        if (payload.reportId === a.id) throw new Error("valkey is down");
      }, new Date());
      expect(result).toMatchObject({ status: "partial", due: 2, enqueued: 1, failed: 1 });
      expect(seen).toEqual([a.id, b.id]);
      expect((await state(a.id)).next_send_at!.getTime()).toBe(a.due.getTime());
    });

    it("STORY-100 s7 · a sweep that cannot see across tenants (an RLS-bound role) is refused instead of looking healthy", async () => {
      const { enqueue } = collector();
      await expect(runReportSweep(appDb, enqueue, new Date())).rejects.toBeInstanceOf(ReportSweepBlindError);
    });

    it("STORY-100 s7 · findDueReports is bounded by its limit", async () => {
      const ws = await workspace();
      const p = await project(ws);
      for (let i = 0; i < 3; i += 1) await report(ws, [p]);
      expect(await findDueReports(sweepDb, new Date(), 2)).toHaveLength(2);
    });
  });

  // ---- the job: a successful period ----------------------------------------------------------------------------------

  describe("a period that runs", () => {
    it("STORY-100 s7 · the job builds, sends, records the delivery and ADVANCES next_send_at past the period; the next sweep finds nothing", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)], { cadence: "weekly", day: 3, hour: 9 });
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, r.due));

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]!.to).toBe("client@example.test");
      expect(sender.sent[0]!.textBody).toContain("/report-artifacts/");
      expect(await deliveries(r.id)).toMatchObject([{ status: "delivered", recipient_count: 1, reason: null }]);
      const after = await state(r.id);
      expect(after.next_send_at!.getTime()).toBeGreaterThan(Date.now());
      expect(after.last_sent_at).not.toBeNull();
      expect(after.last_error).toBeNull();
      expect(await findDueReports(sweepDb, new Date())).toEqual([]);
    }, 60_000);

    it("STORY-100 s7 · the next fire is the next chosen weekday at the chosen WORKSPACE-LOCAL hour", async () => {
      const ws = await workspace("business", "America/New_York");
      const due = new Date(Date.now() - 60_000);
      const r = await report(ws, [await project(ws)], { cadence: "weekly", day: 3, hour: 9, due });
      await processorFor(recordingSender())(jobFor(ws, r.id, due));
      const next = (await state(r.id)).next_send_at!;
      const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(next);
      expect(local.find((p) => p.type === "weekday")!.value).toBe("Wed");
      expect(local.find((p) => p.type === "hour")!.value).toBe("9");
    }, 60_000);

    it("STORY-100 s7 · a BIWEEKLY report repeats a fortnight after the period that fired (not a week)", async () => {
      const ws = await workspace();
      const due = new Date(Date.now() - 60_000);
      const r = await report(ws, [await project(ws)], { cadence: "biweekly", day: 5, hour: 6, due });
      await processorFor(recordingSender())(jobFor(ws, r.id, due));
      const next = (await state(r.id)).next_send_at!;
      // Strictly on the fortnight phase of the period that fired, at its local hour.
      expect((next.getTime() - due.getTime()) % (14 * 86_400_000)).toBeLessThan(2 * 3_600_000);
      expect(next.getTime() - due.getTime()).toBeGreaterThanOrEqual(13 * 86_400_000);
    }, 60_000);

    it("STORY-100 s7 · a REDELIVERED job (same period) finds the period already moved on: nothing is sent or recorded twice", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      const process = processorFor(sender);
      await process(jobFor(ws, r.id, r.due));
      await process(jobFor(ws, r.id, r.due));
      expect(sender.sent).toHaveLength(1);
      expect(await deliveries(r.id)).toHaveLength(1);
      expect((await unitsUsed(ws))!.used).toBe(1);
    }, 60_000);

    it("STORY-100 s7 · a job for a period that is no longer the report's next_send_at (edited or paused since) does nothing", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, new Date(r.due.getTime() - 3_600_000)));
      await db.query("UPDATE scheduled_reports SET active = false WHERE id = $1", [r.id]);
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect(sender.sent).toEqual([]);
      expect(await deliveries(r.id)).toEqual([]);
    }, 60_000);

    it("STORY-100 s8 · a run costs ZERO credits and consumes exactly ONE pdf_exports unit, for two projects", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws), await project(ws)]);
      await processorFor(recordingSender())(jobFor(ws, r.id, r.due));
      expect(await unitsUsed(ws)).toEqual({ used: 1, reserved: 0 });
      expect(await ledgerRows(ws)).toBe(0);
    }, 60_000);

    it("STORY-100 s8 · a csv-only report consumes no pdf unit", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)], { format: "csv" });
      await processorFor(recordingSender())(jobFor(ws, r.id, r.due));
      expect(await unitsUsed(ws)).toBeUndefined();
      expect((await deliveries(r.id))[0]!.status).toBe("delivered");
    }, 60_000);

    it("STORY-100 s8 · a sender that delivers to nobody records `logged`, never `delivered`", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      sender.delivers = false;
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect((await deliveries(r.id))[0]!.status).toBe("logged");
    }, 60_000);
  });

  // ---- AC10: the agency's identity ----------------------------------------------------------------------------------

  describe("the email's identity", () => {
    it("STORY-100 s12 · the email carries the agency display name and Reply-To from the report's theme", async () => {
      const ws = await workspace();
      const t = await theme(ws, { name: "Acme Agency", replyTo: "team@acme.example" });
      const r = await report(ws, [await project(ws)], { themeId: t });
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect(sender.sent[0]).toMatchObject({ fromName: "Acme Agency", replyTo: "team@acme.example" });
    }, 60_000);

    it("STORY-100 s12 · with no theme on the report, the workspace DEFAULT theme's identity is used", async () => {
      const ws = await workspace();
      await theme(ws, { name: "Default Agency", replyTo: "hello@default.example" });
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect(sender.sent[0]).toMatchObject({ fromName: "Default Agency", replyTo: "hello@default.example" });
    }, 60_000);

    it("STORY-100 s12 · a theme with no reply-to stored OMITS it (the key is absent, not empty), and no theme at all is the platform sender", async () => {
      const ws = await workspace();
      await theme(ws, { name: "Acme Agency", replyTo: null });
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect("replyTo" in sender.sent[0]!).toBe(false);
      expect(sender.sent[0]!.fromName).toBe("Acme Agency");

      const bare = await workspace();
      const r2 = await report(bare, [await project(bare)]);
      const sender2 = recordingSender();
      await processorFor(sender2)(jobFor(bare, r2.id, r2.due));
      expect("replyTo" in sender2.sent[0]!).toBe(false);
      expect("fromName" in sender2.sent[0]!).toBe(false);
    }, 60_000);

    it("STORY-100 s12 · another workspace's theme identity is never used (RLS), even when its theme id is on the report row", async () => {
      const wsA = await workspace();
      const wsB = await workspace();
      const foreign = await theme(wsB, { name: "Rival Agency", replyTo: "rival@rival.example" });
      const r = await report(wsA, [await project(wsA)]);
      await db.query("UPDATE scheduled_reports SET theme_id = $2 WHERE id = $1", [r.id, foreign]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(wsA, r.id, r.due));
      expect(JSON.stringify(sender.sent)).not.toMatch(/Rival|rival@/);
    }, 60_000);
  });

  // ---- the refusals that settle a period -----------------------------------------------------------------------------

  describe("a period that cannot run", () => {
    it("STORY-100 s9 · a tier with NO allowance settles the period `failed` naming the plan, builds and meters nothing, and advances", async () => {
      const ws = await workspace("free");
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect(sender.sent).toEqual([]);
      const [delivery] = await deliveries(r.id);
      expect(delivery).toMatchObject({ status: "failed", recipient_count: 0 });
      expect(delivery!.reason).toMatch(/plan does not include PDF exports/);
      expect(delivery!.reason).not.toMatch(/quota|cap/i);
      expect(await unitsUsed(ws)).toBeUndefined();
      expect((await state(r.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now());
      expect((await notes(ws, "report.failed"))[0]!.body).toContain("plan does not include PDF exports");
    }, 60_000);

    it("STORY-100 s10 · at the cap the period is SKIPPED with a notification naming the cap and the reset date, and advances", async () => {
      const ws = await workspace();
      const first = await report(ws, [await project(ws)]);
      await processorFor(recordingSender())(jobFor(ws, first.id, first.due)); // creates the counter
      await db.query("UPDATE usage_counters SET used_value = limit_value WHERE workspace_id = $1 AND metric = 'pdf_exports'", [ws]);
      const cap = (await db.query<{ cap: number }>("SELECT limit_value::int AS cap FROM usage_counters WHERE workspace_id = $1 AND metric = 'pdf_exports'", [ws])).rows[0]!.cap;

      const second = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, second.id, second.due));
      expect(sender.sent).toEqual([]);
      const [delivery] = await deliveries(second.id);
      expect(delivery!.status).toBe("skipped_cap");
      expect(delivery!.reason).toContain(String(cap));
      expect(delivery!.reason).toMatch(/\d{4}-\d{2}-\d{2}/);
      const [note] = await notes(ws, "report.skipped_cap");
      expect(note!.body).toContain(String(cap));
      expect(note!.body).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect((await state(second.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now());
      expect((await unitsUsed(ws))!.used).toBe(cap);
    }, 90_000);

    it("STORY-100 s13 · a project deleted since the schedule was made is a terminal refusal, not a retry loop", async () => {
      const ws = await workspace();
      const gone = await project(ws, true);
      const r = await report(ws, [gone]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect(sender.sent).toEqual([]);
      expect((await deliveries(r.id))[0]).toMatchObject({ status: "failed", reason: "A project in this report no longer exists." });
      expect((await state(r.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now());
    }, 60_000);
  });

  // ---- AC12: failure, retries, then notify ---------------------------------------------------------------------------

  describe("a build that fails", () => {
    it("STORY-100 s13 · the first attempts THROW (the queue retries), leaving nothing recorded, nothing metered and the period still due", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const process = processorFor(recordingSender(), failingBuild());
      for (let attempt = 0; attempt < ATTEMPTS - 1; attempt += 1) {
        await expect(process(jobFor(ws, r.id, r.due, attempt))).rejects.toThrow();
        expect(await deliveries(r.id)).toEqual([]);
        expect(await unitsUsed(ws)).toBeUndefined();
        expect((await state(r.id)).next_send_at!.getTime()).toBe(r.due.getTime());
        expect(await notes(ws, "report.failed")).toEqual([]);
      }
    }, 60_000);

    it("STORY-100 s13 · the documented retry count is the topology's ladder: 1 attempt + doubling(3) = 4", () => {
      expect(ATTEMPTS).toBe(4);
    });

    it("STORY-100 s13 · the FINAL attempt does not throw: the period is `failed` with the reason, the workspace is notified, next_send_at ADVANCES, the unit is released", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      await processorFor(recordingSender(), failingBuild())(jobFor(ws, r.id, r.due, ATTEMPTS - 1));
      const [delivery] = await deliveries(r.id);
      expect(delivery).toMatchObject({ status: "failed", reason: "report build failed (Error)" });
      const [note] = await notes(ws, "report.failed");
      expect(note!.body).toContain("report build failed (Error)");
      expect(note!.body).toContain("Monthly client report");
      expect(note!.severity).toBe("warning");
      const after = await state(r.id);
      expect(after.next_send_at!.getTime()).toBeGreaterThan(Date.now());
      expect(after.last_error).toBe("report build failed (Error)");
      expect(await unitsUsed(ws)).toEqual({ used: 0, reserved: 0 });
    }, 60_000);

    it("STORY-100 s13 · the failure reason and the notification carry no raw error text, no address and no workspace name", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      await processorFor(recordingSender(), failingBuild())(jobFor(ws, r.id, r.due, ATTEMPTS - 1));
      const everything = JSON.stringify([await deliveries(r.id), await state(r.id), await notes(ws, "report.failed")]);
      expect(everything).not.toMatch(/exploded|client@example\.test|Secret Co Name/);
    }, 60_000);

    it("STORY-100 s13 · a replayed final attempt writes ONE notification (the event key is the period)", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const process = processorFor(recordingSender(), failingBuild());
      await process(jobFor(ws, r.id, r.due, ATTEMPTS - 1));
      await process(jobFor(ws, r.id, r.due, ATTEMPTS - 1));
      expect(await notes(ws, "report.failed")).toHaveLength(1);
      expect(await deliveries(r.id)).toHaveLength(1);
    }, 60_000);
  });

  describe("a send that fails", () => {
    it("STORY-100 s13 · a failed send THROWS before the final attempt; the retry sends again under the SAME provider key and consumes the unit ONCE", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      sender.failNext = 1;
      const process = processorFor(sender);
      await expect(process(jobFor(ws, r.id, r.due, 0))).rejects.toThrow(/1 of 1 recipients could not be sent/);
      expect((await deliveries(r.id)).map((d) => d.status)).toEqual(["sending"]);
      expect((await state(r.id)).next_send_at!.getTime()).toBe(r.due.getTime());

      await process(jobFor(ws, r.id, r.due, 1));
      expect(sender.sent).toHaveLength(1);
      expect((await deliveries(r.id)).map((d) => d.status)).toEqual(["delivered"]);
      expect(await unitsUsed(ws)).toEqual({ used: 1, reserved: 0 });
      expect((await state(r.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now());
    }, 90_000);

    it("STORY-100 s13 · every attempt's email carries the same idempotency key per recipient, and it is derived from the delivery, not random", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)], { recipients: ["a@example.test", "b@example.test"] });
      const keys: string[] = [];
      const sender = recordingSender();
      const send = sender.send.bind(sender);
      sender.send = async (m) => {
        keys.push(m.idempotencyKey!);
        await send(m);
      };
      sender.failNext = 1; // the first recipient fails on attempt 1
      const process = processorFor(sender);
      await expect(process(jobFor(ws, r.id, r.due, 0))).rejects.toThrow();
      await process(jobFor(ws, r.id, r.due, 1));
      const id = scheduledRunDeliveryId(r.id, r.due);
      expect(keys.every((k) => k.startsWith(`scheduled-report/${id}:`))).toBe(true);
      // attempt 1: a, b ; attempt 2: a, b  -> two distinct keys, each used twice
      expect(new Set(keys).size).toBe(2);
      expect(keys).toHaveLength(4);
    }, 90_000);

    it("STORY-100 s13 · the FINAL attempt's send failure settles the period `failed` ('N of M'), notifies, and advances; the reason has no address", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      sender.failNext = 99;
      await processorFor(sender)(jobFor(ws, r.id, r.due, ATTEMPTS - 1));
      const [delivery] = await deliveries(r.id);
      expect(delivery).toMatchObject({ status: "failed", reason: "1 of 1 recipients could not be sent", recipient_count: 0 });
      expect((await notes(ws, "report.failed"))[0]!.body).toContain("1 of 1 recipients could not be sent");
      expect(JSON.stringify(await notes(ws, "report.failed"))).not.toContain("client@example.test");
      expect((await state(r.id)).next_send_at!.getTime()).toBeGreaterThan(Date.now());
    }, 60_000);

    it("STORY-100 s13 · a partial send (one of two recipients) before the final attempt is retried, not recorded as delivered", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)], { recipients: ["a@example.test", "b@example.test"] });
      const sender = recordingSender();
      sender.failNext = 1;
      await expect(processorFor(sender)(jobFor(ws, r.id, r.due, 0))).rejects.toThrow(/1 of 2/);
      expect((await deliveries(r.id))[0]!.status).toBe("sending");
    }, 60_000);
  });

  // ---- tenancy ---------------------------------------------------------------------------------------------------------

  describe("tenancy and the job envelope", () => {
    it("RLS · a job signed for workspace A that names workspace B's report finds nothing: nothing is sent, recorded or advanced", async () => {
      const wsA = await workspace();
      const wsB = await workspace();
      const mine = await report(wsB, [await project(wsB)]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(wsA, mine.id, mine.due));
      expect(sender.sent).toEqual([]);
      expect(await deliveries(mine.id)).toEqual([]);
      expect((await state(mine.id)).next_send_at!.getTime()).toBe(mine.due.getTime());
    }, 60_000);

    it("NFR-ARCH-04 · a job whose signature does not verify is refused before anything is read or sent", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      const job = jobFor(ws, r.id, r.due);
      (job.data as { payload: { reportId: string } }).payload.reportId = randomUUID();
      await expect(processorFor(sender)(job)).rejects.toThrow();
      expect(sender.sent).toEqual([]);
    }, 60_000);

    it("KAD-05 · the job payload is strict: an unknown key is refused, not dropped", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      const sender = recordingSender();
      await expect(processorFor(sender)(jobFor(ws, r.id, r.due, 0, { recipients: ["evil@example.test"] }))).rejects.toThrow();
      expect(sender.sent).toEqual([]);
    }, 60_000);

    it("STORY-100 s7 · a report deleted before its job runs ends the job with nothing done", async () => {
      const ws = await workspace();
      const r = await report(ws, [await project(ws)]);
      await db.query("DELETE FROM scheduled_reports WHERE id = $1", [r.id]);
      const sender = recordingSender();
      await processorFor(sender)(jobFor(ws, r.id, r.due));
      expect(sender.sent).toEqual([]);
    }, 60_000);
  });
});
