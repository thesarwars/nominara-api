import { Pool } from "pg";
import { scheduledReportDeliverySchema, scheduledReportSchema } from "../../contracts/reports/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-E-100c — /v1/scheduled-reports through the REAL ApiModule.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-100 part C · scheduled reports over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }),
  });
  let pool: Pool;
  let sessions: SessionService;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
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
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
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
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
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

  it("AC2 · another workspace's project is refused as unreadable, and its report is invisible (404 on PATCH/DELETE/send-now)", async () => {
    const one = await seeded();
    const two = await seeded();
    const refused = await call(one.a, "POST", "/scheduled-reports", create([two.p]));
    expect(refused.statusCode).toBe(400);
    const mine = scheduledReportSchema.parse(data(await call(two.a, "POST", "/scheduled-reports", create([two.p]))));
    expect((await call(one.a, "PATCH", `/scheduled-reports/${mine.id}`, { paused: true })).statusCode).toBe(404);
    expect((await call(one.a, "DELETE", `/scheduled-reports/${mine.id}`)).statusCode).toBe(404);
    expect((await call(one.a, "POST", `/scheduled-reports/${mine.id}/send-now`)).statusCode).toBe(404);
    expect(data<unknown[]>(await call(one.a, "GET", "/scheduled-reports"))).toEqual([]);
  }, 120_000);

  it("AC4 · pause clears next_run_at, resume recomputes it, delete removes the report; each is audited", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    const paused = scheduledReportSchema.parse(data(await call(a, "PATCH", `/scheduled-reports/${made.id}`, { paused: true })));
    expect([paused.paused, paused.next_run_at]).toEqual([true, null]);
    const resumed = scheduledReportSchema.parse(data(await call(a, "PATCH", `/scheduled-reports/${made.id}`, { paused: false })));
    expect(resumed.next_run_at).not.toBeNull();
    expect((await call(a, "DELETE", `/scheduled-reports/${made.id}`)).statusCode).toBe(204);
    const actions = (await harness.db().query(`SELECT action FROM audit_log WHERE workspace_id = $1 AND action LIKE 'scheduled_report.%' ORDER BY created_at`, [a.workspaceId])).rows.map((r: { action: string }) => r.action);
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
    expect([delivery.status, delivery.reason, delivery.recipients]).toEqual(["logged", null, 1]);
    expect(await credits(a.workspaceId)).toBe(before);
    expect((await used(a.workspaceId))?.used).toBe(1);
    const listed = data<Array<{ deliveries: unknown[] }>>(await call(a, "GET", "/scheduled-reports"));
    expect(listed[0]!.deliveries).toEqual([delivery]);
  }, 180_000);

  it("STORY-100 s9 · send-now on a tier with ZERO allowance is 403 feature_not_in_plan, with no delivery and no unit", async () => {
    const a = await owner("free");
    const p = await project(a.workspaceId);
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    const res = await call(a, "POST", `/scheduled-reports/${made.id}/send-now`);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe("feature_not_in_plan");
    expect((await harness.db().query(`SELECT 1 FROM scheduled_report_deliveries WHERE workspace_id = $1`, [a.workspaceId])).rowCount).toBe(0);
  }, 120_000);

  it("STORY-100 s10 · send-now at the cap writes a skipped_cap delivery AND a notification naming the cap and the reset date", async () => {
    const { a, p } = await seeded();
    const made = scheduledReportSchema.parse(data(await call(a, "POST", "/scheduled-reports", create([p]))));
    expect((await call(a, "POST", `/scheduled-reports/${made.id}/send-now`)).statusCode).toBe(200); // creates the counter
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
        expect((await tx.query(`SELECT 1 FROM scheduled_reports`)).rowCount).toBe(0);
        expect((await tx.query(`SELECT 1 FROM scheduled_report_deliveries`)).rowCount).toBe(0);
      });
    } finally {
      client.release();
    }
  }, 180_000);
});
