import { Pool } from "pg";
import { createScheduledReportRequestSchema, scheduledReportDeliverySchema, scheduledReportSchema } from "../../contracts/reports/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { pdfText } from "../support/pdf-text.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { ScheduledReportsService } from "../../src/modules/reports/scheduled-reports.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import { fetchStored, reportStorageEnv } from "../support/report-storage-env.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-E-100c — /v1/scheduled-reports through the REAL ApiModule.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-100 part C · scheduled reports over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  let localstack: LocalstackFixture;
  const harness = useApiHarness({
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString, ...reportStorageEnv(localstack.endpoint) }),
  });
  let pool: Pool;
  let sessions: SessionService;

  beforeAll(async () => {
    [cacheValkey, queueValkey, localstack] = await Promise.all([startValkey(), startValkeyFixture(), startLocalstack()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop(), localstack.stop()]);
  });
  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
  });
  afterEach(async () => {
    await pool.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly userId: string;
    readonly cookie: string;
    readonly csrf: string;
  }

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`,
      [userId, `${userId}@example.test`],
    );
    return userId;
  }

  /** `strong` = a fresh step-up, which export:data demands of an owner or admin. */
  async function owner(plan: "free" | "starter" | "growth" | "business", strong = true): Promise<Actor> {
    const userId = await newUser();
    const tokens = await sessions.createSession(userId, new Date(), strong ? "email_otp" : null);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly(plan), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const version = ((await harness.db().query(`SELECT entitlement_version AS v FROM workspaces WHERE id = $1`, [workspaceId])).rows[0] as { v: number }).v;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function member(workspaceId: string, role: "manager" | "analyst" | "viewer", projectScope: string[] | null = null): Promise<Actor> {
    const userId = await newUser();
    await harness.db().query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, project_scope, status) VALUES ($1,$2,$3,$4,$5,'active')`,
      [uuidV7(), workspaceId, userId, role, projectScope],
    );
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, role, projectScope, 2);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function project(workspaceId: string, name = "Acme Roofing"): Promise<string> {
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,$3,$4,'https://acme.test','acme.test')`,
      [id, workspaceId, name, `p-${id.slice(-12)}`],
    );
    return id;
  }

  async function metric(workspaceId: string, projectId: string, engine: string, ago: number, over: { cells?: number; score?: string; entity?: string; entityId?: string } = {}): Promise<void> {
    const date = new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    await harness.db().query(
      `INSERT INTO metric_daily (workspace_id,project_id,engine_key,entity_type,entity_id,metric_date,cells_total,cells_present,presence_rate,visibility_score,live_capture_ratio)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,0.5,$9,1)`,
      [workspaceId, projectId, engine, over.entity ?? "brand", over.entityId ?? projectId, date, over.cells ?? 40, Math.floor((over.cells ?? 40) / 2), over.score ?? "62.500"],
    );
  }

  const call = (a: Actor, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown) =>
    harness.app().inject({
      method,
      url: apiUrl(path),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error;

  const create = (projects: string[], over: Record<string, unknown> = {}) => ({
    label: "Monthly client report",
    project_ids: projects,
    sections: ["overview"],
    cadence: "monthly",
    day: 15,
    hour: 8,
    format: "pdf",
    recipients: ["client@example.test"],
    ...over,
  });
  const used = async (workspaceId: string) =>
    (await harness.db().query(`SELECT used_value::int AS used, limit_value::int AS cap FROM usage_counters WHERE workspace_id = $1 AND metric = 'pdf_exports'`, [workspaceId])).rows[0] as
      | { used: number; cap: number }
      | undefined;
  const credits = async (workspaceId: string) =>
    ((await harness.db().query(`SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1`, [workspaceId])).rows[0] as { n: number }).n;

  /** The post-commit delivery of every send-now so far has finished (the row left `sending`). */
  const settleDeliveries = (): Promise<void> => harness.app().get(ScheduledReportsService).settled();

  async function seeded(plan: "starter" | "growth" | "business" = "growth") {
    const a = await owner(plan);
    const p = await project(a.workspaceId);
    await metric(a.workspaceId, p, "gemini", 2, { score: "70.000" });
    await metric(a.workspaceId, p, "all", 2, { score: "70.000" });
    return { a, p };
  }

  it("AC2/AC4 · create returns the contract shape, computes next_run_at, and writes an audit row", async () => {
    const { a, p } = await seeded();
    const res = await call(a, "POST", "/scheduled-reports", create([p]));
    expect(res.statusCode, res.body).toBe(201);
    const made = scheduledReportSchema.parse(data(res));
    expect(made.paused).toBe(false);
    expect(made.deliveries).toEqual([]);
    expect(new Date(made.next_run_at!).getUTCDate()).toBe(15);
    expect(new Date(made.next_run_at!).getUTCHours()).toBe(8);
    const audit = (await harness.db().query(`SELECT action, resource_id FROM audit_log WHERE workspace_id = $1 AND action = 'scheduled_report.created'`, [a.workspaceId])).rows;
    expect(audit).toEqual([{ action: "scheduled_report.created", resource_id: made.id }]);
  }, 120_000);

  it("AC2 · agency:branding is required (a manager is 403); an invalid recipient and an unknown key are 400", async () => {
    const { a, p } = await seeded();
    const manager = await member(a.workspaceId, "manager");
    const denied = await call(manager, "GET", "/scheduled-reports");
    expect(denied.statusCode).toBe(403);
    expect((await call(a, "POST", "/scheduled-reports", create([p], { recipients: ["nope"] }))).statusCode).toBe(400);
    expect((await call(a, "POST", "/scheduled-reports", create([p], { workspace_id: a.workspaceId }))).statusCode).toBe(400);
  }, 120_000);

  it("AC2 · under SET ROLE nominara_app a project of another workspace is refused as unreadable (400) and another workspace's report is invisible (404)", async () => {
    const one = await seeded();
    const two = await seeded();
    const service = new ScheduledReportsService(null as never, null as never, null as never, null as never, null as never, null as never);
    const client = await pool.connect();
    try {
      await expect(
        withTenantContext(client, { workspaceId: one.a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          await tx.query("SET LOCAL ROLE nominara_app");
          return service.create(createScheduledReportRequestSchema.parse(create([two.p])));
        }),
      ).rejects.toMatchObject({ status: 400 });
      const mine = await withTenantContext(client, { workspaceId: two.a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query("SET LOCAL ROLE nominara_app");
        return service.create(createScheduledReportRequestSchema.parse(create([two.p])));
      });
      // another workspace's report is invisible: not listed, and 404 on update and delete
      await withTenantContext(client, { workspaceId: one.a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query("SET LOCAL ROLE nominara_app");
        expect((await service.list({ limit: 50 })).items).toEqual([]);
        await expect(service.remove(mine.id)).rejects.toMatchObject({ status: 404 });
        await expect(service.update(mine.id, { paused: true } as never)).rejects.toMatchObject({ status: 404 });
      });
    } finally {
      client.release();
    }
  }, 120_000);

  it("AC4 · pause clears next_run_at, resume recomputes it, delete removes the report; each is audited", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    const paused = scheduledReportSchema.parse(data(await call(a, "PATCH", `/scheduled-reports/${made.id}`, { paused: true })));
    expect([paused.paused, paused.next_run_at]).toEqual([true, null]);
    const resumed = scheduledReportSchema.parse(data(await call(a, "PATCH", `/scheduled-reports/${made.id}`, { paused: false })));
    expect(resumed.next_run_at).not.toBeNull();
    expect((await call(a, "DELETE", `/scheduled-reports/${made.id}`)).statusCode).toBe(204);
    const actions = (await harness.db().query(`SELECT action FROM audit_log WHERE workspace_id = $1 AND action LIKE 'scheduled_report.%' ORDER BY seq`, [a.workspaceId])).rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(["scheduled_report.created", "scheduled_report.updated", "scheduled_report.updated", "scheduled_report.deleted"]);
  }, 120_000);

  it("STORY-100 s8/s15 · send-now: zero credits, ONE pdf unit for two projects, a 'logged' delivery listed in the history", async () => {
    const { a, p } = await seeded();
    const p2 = await project(a.workspaceId, "Second");
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p, p2]))));
    const before = await credits(a.workspaceId);
    const res = await call(a, "POST", `/scheduled-reports/${made.id}/send-now`);
    expect(res.statusCode, res.body).toBe(200);
    const delivery = scheduledReportDeliverySchema.parse(data(res));
    // The request answers before any email goes out: `sending`, and the history settles to `logged` (the logging sender delivers to nobody).
    expect([delivery.status, delivery.reason, delivery.recipients]).toEqual(["sending", null, 0]);
    await settleDeliveries();
    expect(await credits(a.workspaceId)).toBe(before);
    expect((await used(a.workspaceId))?.used).toBe(1);
    const listed = data<Array<{ deliveries: unknown[] }>>(await call(a, "GET", "/scheduled-reports"));
    expect(listed[0]!.deliveries).toEqual([{ ...delivery, status: "logged", recipients: 1 }]);
  }, 180_000);

  it("STORY-097 AC4 (review fix) · a report pinned to a brand-removed theme T while the DEFAULT shows the brand: no platform name in the subject, text, HTML, From name, attachment names or PDF text", async () => {
    const { a, p } = await seeded("business");
    const pinned = uuidV7();
    await harness.db().query(`INSERT INTO brand_themes (workspace_id, name, is_default, hide_nominara_brand) VALUES ($1,'Default',true,false)`, [a.workspaceId]);
    await harness.db().query(`INSERT INTO brand_themes (id, workspace_id, name, is_default, hide_nominara_brand, email_from_name) VALUES ($1,$2,'T',false,true,'Agency X')`, [pinned, a.workspaceId]);
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p], { theme_id: pinned }))));
    const sent: Array<{ subject: string; textBody: string; htmlBody?: string; fromName?: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
    const restore = withSender({ delivers: true, send: async (m) => void sent.push(m as never) });
    try {
      expect((await call(a, "POST", `/scheduled-reports/${made.id}/send-now`)).statusCode).toBe(200);
      await settleDeliveries();
    } finally {
      restore();
    }
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    for (const part of [m.subject, m.textBody, m.htmlBody ?? "", m.fromName ?? "", ...(m.attachments ?? []).map((f) => f.filename)]) expect(part).not.toMatch(/nominara/i);
    expect(m.fromName).toBe("Agency X");
    for (const f of m.attachments ?? []) expect(pdfText(f.content)).not.toMatch(/nominara/i);
  }, 180_000);

  it("STORY-180 AC1/AC3/AC6 · send-now attaches each file (8 MiB or less) read back from the reports bucket, with no link, and the artifact rows hold the real keys", async () => {
    const { a, p } = await seeded();
    const p2 = await project(a.workspaceId, "Second");
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p, p2]))));
    const sent: Array<{ to: string; textBody: string; attachments?: Array<{ filename: string; content: Buffer; contentType?: string }> }> = [];
    const restore = withSender({ delivers: true, send: async (m) => void sent.push(m as never) });
    try {
      expect((await call(a, "POST", `/scheduled-reports/${made.id}/send-now`)).statusCode).toBe(200);
      await settleDeliveries();
    } finally {
      restore();
    }
    expect(sent).toHaveLength(1);
    const files = sent[0]!.attachments ?? [];
    expect(files).toHaveLength(2);
    for (const f of files) {
      expect(f.contentType).toBe("application/pdf");
      expect(f.content.subarray(0, 5).toString()).toBe("%PDF-");
    }
    expect(new Set(files.map((f) => f.filename)).size).toBe(2);
    expect(sent[0]!.textBody).not.toContain("report-links");
    const keys = (await harness.db().query(`SELECT object_key, bytes FROM report_artifacts WHERE workspace_id = $1 ORDER BY created_at`, [a.workspaceId])).rows as Array<{ object_key: string; bytes: number }>;
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.object_key).toMatch(new RegExp(`^inttest/${a.workspaceId}/[0-9a-f-]{36}\\.pdf$`));
    expect(keys.map((k) => k.bytes).sort()).toEqual(files.map((f) => f.content.length).sort());
  }, 180_000);

  it("STORY-180 AC3/AC6 · a file over 8 MiB is a link in the email, and clicking that very link redirects to the stored bytes", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    // The decision depends only on the `bytes` column, so no 8 MiB file is built: a trigger scoped to this workspace records a size
    // above the limit for the artifact (the stored object stays the real, small file).
    const suffix = a.workspaceId.replaceAll("-", "");
    await harness.db().query(`CREATE OR REPLACE FUNCTION public.t180_oversize_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.bytes := 9000000; RETURN NEW; END $$`);
    await harness.db().query(
      `CREATE TRIGGER t180_oversize_${suffix} BEFORE INSERT ON report_artifacts FOR EACH ROW WHEN (NEW.workspace_id = '${a.workspaceId}') EXECUTE FUNCTION public.t180_oversize_${suffix}()`,
    );
    const sent: Array<{ textBody: string; attachments?: unknown[] }> = [];
    const restore = withSender({ delivers: true, send: async (m) => void sent.push(m as never) });
    try {
      expect((await call(a, "POST", `/scheduled-reports/${made.id}/send-now`)).statusCode).toBe(200);
      await settleDeliveries();
    } finally {
      restore();
      await harness.db().query(`DROP TRIGGER IF EXISTS t180_oversize_${suffix} ON report_artifacts`);
      await harness.db().query(`DROP FUNCTION IF EXISTS public.t180_oversize_${suffix}()`);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments ?? []).toHaveLength(0);
    const url = /https?:\/\/\S*\/v1\/report-links\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{43}/.exec(sent[0]!.textBody)?.[0];
    expect(url).toBeDefined();
    const click = await harness.app().inject({ method: "GET", url: new URL(url!).pathname });
    expect(click.statusCode, click.body).toBe(302);
    expect((await fetchStored(String(click.headers.location))).subarray(0, 5).toString()).toBe("%PDF-");
  }, 180_000);

  it("STORY-100 s9 · send-now on a tier with ZERO allowance is 403 feature_not_in_plan, with no delivery and no unit", async () => {
    const a = await owner("free");
    const p = await project(a.workspaceId);
    const createdRes = await call(a, "POST", "/scheduled-reports", create([p]));
    expect(createdRes.statusCode, createdRes.body).toBe(201);
    const made = scheduledReportSchema.parse(data(createdRes));
    const res = await call(a, "POST", `/scheduled-reports/${made.id}/send-now`);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe("feature_not_in_plan");
    expect((await harness.db().query(`SELECT 1 FROM scheduled_report_deliveries WHERE workspace_id = $1`, [a.workspaceId])).rowCount).toBe(0);
  }, 120_000);

  it("STORY-100 s10 · send-now at the cap writes a skipped_cap delivery AND a notification naming the cap and the reset date", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    expect((await call(a, "POST", `/scheduled-reports/${made.id}/send-now`)).statusCode).toBe(200); // creates the counter
    await settleDeliveries();
    await harness.db().query(`UPDATE usage_counters SET used_value = limit_value WHERE workspace_id = $1 AND metric = 'pdf_exports'`, [a.workspaceId]);
    const cap = (await used(a.workspaceId))!.cap;
    const res = await call(a, "POST", `/scheduled-reports/${made.id}/send-now`);
    expect(res.statusCode, res.body).toBe(200);
    const skipped = scheduledReportDeliverySchema.parse(data(res));
    expect(skipped.status).toBe("skipped_cap");
    expect(skipped.reason).toContain(String(cap));
    expect(skipped.reason).toMatch(/\d{4}-\d{2}-\d{2}/);
    const notes = (await harness.db().query(`SELECT kind, body FROM notifications WHERE workspace_id = $1 AND kind = 'report.skipped_cap'`, [a.workspaceId])).rows as Array<{ body: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain(String(cap));
    expect(notes[0]!.body).toMatch(/\d{4}-\d{2}-\d{2}/);
    const history = data<Array<{ deliveries: Array<{ status: string }> }>>(await call(a, "GET", "/scheduled-reports"))[0]!.deliveries;
    expect(history.map((d) => d.status)).toEqual(["skipped_cap", "logged"]);
  }, 180_000);

  it("RLS · under SET ROLE nominara_app another workspace's reports and deliveries are not readable", async () => {
    const one = await seeded();
    const two = await seeded();
    const made = scheduledReportSchema.parse(data(await call(two.a, "POST", "/scheduled-reports", create([two.p]))));
    await call(two.a, "POST", `/scheduled-reports/${made.id}/send-now`);
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId: one.a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query("SET LOCAL ROLE nominara_app");
        expect((await tx.query(`SELECT 1 FROM scheduled_reports`)).rowCount).toBe(0);
        expect((await tx.query(`SELECT 1 FROM scheduled_report_deliveries`)).rowCount).toBe(0);
      });
    } finally {
      client.release();
    }
  }, 180_000);

  // NEW-E-7 checkpoint-6 (owner 2026-10-09 pm #3) — walks a list by cursor at limit 2 and returns the ids seen, per page.
  async function walk(a: Actor, path: string, idOf: (row: Record<string, unknown>) => string): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 12; guard += 1) {
      const res = await harness.app().inject({ method: "GET", url: apiUrl(`${path}?limit=2${cursor === undefined ? "" : `&cursor=${cursor}`}`), headers: { cookie: a.cookie } });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { data: Record<string, unknown>[]; pagination: { cursor_next: string | null; has_more: boolean; limit: number } };
      expect(body.pagination.limit).toBe(2);
      expect(body.pagination.has_more).toBe(body.pagination.cursor_next !== null);
      pages.push(body.data.map(idOf));
      if (body.pagination.cursor_next === null) return pages;
      cursor = body.pagination.cursor_next;
    }
    throw new Error("cursor walk did not terminate");
  }
  async function rejectsBadCursors(a: Actor, path: string, foreign: string): Promise<void> {
    for (const cursor of ["not-a-cursor", foreign]) {
      const res = await harness.app().inject({ method: "GET", url: apiUrl(`${path}?cursor=${cursor}`), headers: { cookie: a.cookie } });
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    }
    const offset = await harness.app().inject({ method: "GET", url: apiUrl(`${path}?offset=2`), headers: { cookie: a.cookie } });
    expect(offset.statusCode, offset.body).toBe(400);
  }

  it("NEW-E-7 checkpoint-6 · listScheduledReports pages by keyset: a created_at tie at the page boundary is neither skipped nor repeated, deliveries ride on their own report, cursor_next null on the last", async () => {
    const { a, p } = await seeded();
    await harness.db().query(
      `INSERT INTO scheduled_reports (workspace_id, name, project_ids, cadence, recipients, created_at)
       SELECT $1, 'r' || g, ARRAY[$2::uuid], 'monthly', ARRAY['c@example.test']::citext[], '2026-10-01T10:00:00.000001Z' FROM generate_series(1,5) g`,
      [a.workspaceId, p],
    );
    const expected = (
      await harness.db().query<{ id: string }>(`SELECT id FROM scheduled_reports WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`, [a.workspaceId])
    ).rows.map((r) => r.id);
    await harness.db().query(
      `INSERT INTO scheduled_report_deliveries (workspace_id, scheduled_report_id, status, recipient_count) VALUES ($1,$2,'logged',1)`,
      [a.workspaceId, expected[2]],
    );
    const pages = await walk(a, "/scheduled-reports", (r) => r.id as string);
    expect(pages.map((x) => x.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(expected);
    const third = await harness.app().inject({ method: "GET", url: apiUrl("/scheduled-reports?limit=2"), headers: { cookie: a.cookie } });
    const cursor = (third.json() as { pagination: { cursor_next: string } }).pagination.cursor_next;
    const next = await harness.app().inject({ method: "GET", url: apiUrl(`/scheduled-reports?limit=2&cursor=${cursor}`), headers: { cookie: a.cookie } });
    const rows = (next.json() as { data: { id: string; deliveries: unknown[] }[] }).data;
    expect(rows.find((r) => r.id === expected[2])?.deliveries).toHaveLength(1);
  }, 120_000);

  it("NEW-E-7 checkpoint-6 · listScheduledReports: an empty list is an empty page with the envelope; a malformed or foreign cursor and an offset are 400", async () => {
    const { a } = await seeded();
    const res = await harness.app().inject({ method: "GET", url: apiUrl("/scheduled-reports"), headers: { cookie: a.cookie } });
    expect(res.json()).toMatchObject({ data: [], pagination: { cursor_next: null, has_more: false } });
    const foreign = Buffer.from(JSON.stringify({ v: 1, k: ["x"] })).toString("base64url");
    await rejectsBadCursors(a, "/scheduled-reports", foreign);
  }, 120_000);


  // ---- Group C review, owner decision B: the send is not inside the request transaction ------------------------------

  /** Swaps the live service's sender (a private field) for the duration of one test. */
  function withSender(sender: { delivers?: boolean; send(m: { to: string }): Promise<void> }): () => void {
    const service = harness.app().get(ScheduledReportsService) as unknown as { email: unknown };
    const original = service.email;
    service.email = sender;
    return () => {
      service.email = original;
    };
  }
  const deliveryRow = async (workspaceId: string) =>
    (await harness.db().query(`SELECT status, reason, recipient_count FROM scheduled_report_deliveries WHERE workspace_id = $1 ORDER BY attempted_at DESC LIMIT 1`, [workspaceId])).rows[0] as
      | { status: string; reason: string | null; recipient_count: number }
      | undefined;

  it("Group C · a HANGING sender holds no row lock and no transaction: the response is `sending` at once, usage_counters is writable meanwhile, and the row finishes `delivered` when the send ends", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p], { recipients: ["a@example.test", "b@example.test"] }))));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered: string[] = [];
    const restore = withSender({ delivers: true, send: async (m) => { entered.push(m.to); await gate; } });
    try {
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20_000));
      const outcome = await Promise.race([call(a, "POST", `/scheduled-reports/${made.id}/send-now`), timeout]);
      expect(outcome, "the response waited for the hanging sender (the send is inside the request)").not.toBe("timeout");
      const res = outcome as Awaited<ReturnType<typeof call>>;
      expect(scheduledReportDeliverySchema.parse(data(res)).status).toBe("sending");

      // The sender is now stuck mid-send. Everything the request locked must be free: a competing writer must not wait.
      await vi_waitFor(() => entered.length === 1);
      const other = await pool.connect();
      try {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '1500ms'");
        const bumped = await other.query(`UPDATE usage_counters SET used_value = used_value WHERE workspace_id = $1 AND metric = 'pdf_exports'`, [a.workspaceId]);
        expect(bumped.rowCount).toBe(1);
        await other.query("COMMIT");
      } finally {
        other.release();
      }
      expect((await deliveryRow(a.workspaceId))?.status).toBe("sending");
    } finally {
      release();
      await settleDeliveries();
      restore();
    }
    expect(await deliveryRow(a.workspaceId)).toEqual({ status: "delivered", reason: null, recipient_count: 2 });
    const report = (await harness.db().query(`SELECT last_sent_at, last_error FROM scheduled_reports WHERE id = $1`, [made.id])).rows[0] as { last_sent_at: Date | null; last_error: string | null };
    expect(report.last_sent_at).not.toBeNull();
    expect(report.last_error).toBeNull();
  }, 180_000);

  it("Group C · graceful shutdown WAITS for an in-flight delivery, and finalises it before the pool is ended (hook order on the real module graph)", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered: string[] = [];
    withSender({ delivers: true, send: async (m) => { entered.push(m.to); await gate; } });
    expect(scheduledReportDeliverySchema.parse(data(await call(a, "POST", `/scheduled-reports/${made.id}/send-now`))).status).toBe("sending");
    await vi_waitFor(() => entered.length === 1);

    const closing = harness.close();
    const early = await Promise.race([closing.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 500))]);
    expect(early, "app.close() did not wait for the in-flight delivery").toBe("waiting");
    expect((await deliveryRow(a.workspaceId))?.status).toBe("sending");

    release();
    await closing;
    // If DbModule had ended PG_POOL first, finalising would have failed and this row would still read `sending`.
    expect(await deliveryRow(a.workspaceId)).toEqual({ status: "delivered", reason: null, recipient_count: 1 });
  }, 180_000);

  it("Group C · a failing recipient finishes the row `failed` with the N-of-M text, counts the successes, and sets last_error", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p], { recipients: ["ok@example.test", "bad@example.test"] }))));
    const restore = withSender({ delivers: true, send: async (m) => { if (m.to.startsWith("bad")) throw new Error("provider down"); } });
    try {
      expect(scheduledReportDeliverySchema.parse(data(await call(a, "POST", `/scheduled-reports/${made.id}/send-now`))).status).toBe("sending");
      await settleDeliveries();
    } finally {
      restore();
    }
    expect(await deliveryRow(a.workspaceId)).toEqual({ status: "failed", reason: "1 of 2 recipients could not be sent", recipient_count: 1 });
    const report = (await harness.db().query(`SELECT last_error FROM scheduled_reports WHERE id = $1`, [made.id])).rows[0] as { last_error: string };
    expect(report.last_error).toBe("1 of 2 recipients could not be sent");
    const listed = data<Array<{ deliveries: Array<{ status: string }> }>>(await call(a, "GET", "/scheduled-reports"));
    expect(listed[0]!.deliveries.map((d) => d.status)).toEqual(["failed"]);
  }, 180_000);

  it("Group C · a stale `sending` row (its process died) reads as `failed` in the history; the row itself is untouched", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    await harness.db().query(
      `INSERT INTO scheduled_report_deliveries (workspace_id, scheduled_report_id, status, recipient_count, attempted_at) VALUES ($1,$2,'sending',1, now() - interval '1 hour')`,
      [a.workspaceId, made.id],
    );
    const listed = data<Array<{ deliveries: Array<{ status: string; reason: string | null }> }>>(await call(a, "GET", "/scheduled-reports"));
    expect(listed[0]!.deliveries[0]!.status).toBe("failed");
    expect(listed[0]!.deliveries[0]!.reason).toMatch(/did not complete/);
    expect((await deliveryRow(a.workspaceId))?.status).toBe("sending");
  }, 120_000);
});

async function vi_waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error("timed out waiting for the send to start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
