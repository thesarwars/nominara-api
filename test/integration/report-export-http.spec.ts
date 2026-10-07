import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportResponseSchema } from "../../contracts/reports/index.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { METHODOLOGY_NOTE } from "../../src/lib/reports/methodology-footer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { pdfRaw } from "../support/pdf-text.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-E-100b — POST /v1/projects/{id}/reports/export through the REAL ApiModule.
// STORY-100 scenarios 1, 2, 3, 4, 8, 9 and 18 end to end; the document model's
// own scenarios (1-3, 5, 6) are in test/unit/reports/export-document.spec.ts.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-100 · on-demand export over HTTP", () => {
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

  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    format: "pdf",
    sections: ["overview", "growth_map", "competitors"],
    timeframe: "30d",
    hide_competitors: false,
    hide_costs: true,
    ...over,
  });

  let keyCounter = 0;
  const exportReport = (a: Actor, projectId: string, payload: unknown, key: string | null = `key-${String(++keyCounter)}-${uuidV7()}`) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${projectId}/reports/export`),
      headers: {
        cookie: a.cookie,
        [CSRF_HEADER_NAME]: a.csrf,
        "content-type": "application/json",
        ...(key === null ? {} : { "idempotency-key": key }),
      },
      payload: payload as object,
    });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;
  type Exported = ReturnType<typeof exportResponseSchema.parse>;
  const fileOf = (e: Exported): Buffer => Buffer.from(e.download_url.slice(e.download_url.indexOf(",") + 1), "base64");
  const usage = async (workspaceId: string) =>
    (await harness.db().query(`SELECT used_value::int AS used, reserved_value::int AS reserved FROM usage_counters WHERE workspace_id = $1 AND metric = 'pdf_exports'`, [workspaceId])).rows[0] as
      | { used: number; reserved: number }
      | undefined;
  const credits = async (workspaceId: string) =>
    ((await harness.db().query(`SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1`, [workspaceId])).rows[0] as { n: number }).n;

  async function seeded(plan: "starter" | "growth" | "business" = "growth") {
    const a = await owner(plan);
    const p = await project(a.workspaceId);
    await metric(a.workspaceId, p, "gemini", 2, { score: "70.000" });
    await metric(a.workspaceId, p, "chatgpt", 2, { score: "50.000" });
    await metric(a.workspaceId, p, "all", 2, { score: "60.000" });
    return { a, p };
  }

  it("STORY-100 s1 — a PDF export validates against the contract, carries the footer, and is stored with it (s4)", async () => {
    const { a, p } = await seeded();
    const res = await exportReport(a, p, body());
    expect(res.statusCode, res.body).toBe(201);
    const exported = exportResponseSchema.parse(data(res));
    expect(exported.format).toBe("pdf");
    expect(exported.filename).toMatch(/\.pdf$/);
    expect(exported.download_url).toMatch(/^data:application\/pdf;base64,/);
    expect(exported.footer.note).toBe(METHODOLOGY_NOTE);
    expect(exported.footer.engines).toEqual(["chatgpt", "gemini"]);
    const file = fileOf(exported);
    expect(file.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfRaw(file)).toContain(METHODOLOGY_NOTE);

    const row = (await harness.db().query(`SELECT * FROM report_artifacts WHERE id = $1`, [exported.export_id])).rows[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.workspace_id).toBe(a.workspaceId);
    expect(row.project_ids).toEqual([p]);
    expect(row.format).toBe("pdf");
    expect(row.object_key).toBe(`inline:${exported.export_id}`);
    expect(row.bytes).toBe(file.length);
    expect(row.methodology_footer).toEqual(exported.footer);
    expect(row.scheduled_report_id).toBeNull();
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now());
  }, 120_000);

  it("STORY-100 s1 — a CSV export carries the footer rows and the per-engine rows beside the blend", async () => {
    const { a, p } = await seeded();
    const res = await exportReport(a, p, body({ format: "csv" }));
    expect(res.statusCode, res.body).toBe(201);
    const exported = exportResponseSchema.parse(data(res));
    expect(exported.download_url).toMatch(/^data:text\/csv;base64,/);
    expect(exported.filename).toMatch(/\.csv$/);
    const csv = fileOf(exported).toString("utf8");
    expect(csv).toContain("methodology,,,,scoring_version,");
    expect(csv).toContain(METHODOLOGY_NOTE);
    expect(csv).toContain("overview,,brand,all,visibility_score,60,");
    expect(csv).toContain("overview,,brand,gemini,visibility_score,70,");
    expect(csv).toContain("overview,,brand,chatgpt,visibility_score,50,");
    const row = (await harness.db().query(`SELECT format, methodology_footer FROM report_artifacts WHERE id = $1`, [exported.export_id])).rows[0];
    expect(row).toEqual({ format: "csv", methodology_footer: exported.footer });
  }, 120_000);

  it("STORY-100 s2/s3 — brand removal and a hostile theme stylesheet leave the footer in the stored artifact", async () => {
    const { a, p } = await seeded();
    await harness.db().query(
      `INSERT INTO brand_themes (id, workspace_id, name, is_default, hide_nominara_brand, custom_css) VALUES ($1,$2,'T',true,true,'.footer{display:none}')`,
      [uuidV7(), a.workspaceId],
    );
    for (const sections of [["overview"], ["tasks"]]) {
      const res = await exportReport(a, p, body({ sections }));
      expect(res.statusCode, res.body).toBe(201);
      const exported = exportResponseSchema.parse(data(res));
      expect(pdfRaw(fileOf(exported))).toContain(METHODOLOGY_NOTE);
      expect(exported.footer.note).toBe(METHODOLOGY_NOTE);
    }
  }, 120_000);

  it("STORY-100 s3 — a request that tries to carry a footer or style override is a 400 and creates nothing", async () => {
    const { a, p } = await seeded();
    for (const extra of [{ hide_footer: true }, { footer: null }, { style_override: { footer: "none" } }]) {
      const res = await exportReport(a, p, body(extra));
      expect(res.statusCode, res.body).toBe(400);
      expect(errorOf(res).code).toBe("validation_failed");
    }
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM report_artifacts`)).rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-100 s8 — a PDF export uses zero credits and consumes exactly one pdf_exports unit; the response reads used/cap", async () => {
    const { a, p } = await seeded();
    const before = await credits(a.workspaceId);
    const res = await exportReport(a, p, body());
    expect(res.statusCode, res.body).toBe(201);
    expect(data<Exported>(res).pdf).toEqual({ used: 1, cap: 25 });
    expect(await usage(a.workspaceId)).toEqual({ used: 1, reserved: 0 });
    expect(await credits(a.workspaceId)).toBe(before);
  }, 120_000);

  it("STORY-100 s8 — a CSV export consumes no pdf_exports unit", async () => {
    const { a, p } = await seeded();
    const res = await exportReport(a, p, body({ format: "csv" }));
    expect(res.statusCode, res.body).toBe(201);
    expect(data<Exported>(res).pdf.used).toBe(0);
    const counter = await usage(a.workspaceId);
    expect(counter === undefined || (counter.used === 0 && counter.reserved === 0)).toBe(true);
  }, 120_000);

  it("STORY-100 s8 — replaying the same Idempotency-Key returns the same artifact and consumes one unit in total", async () => {
    const { a, p } = await seeded();
    const key = `replay-${uuidV7()}`;
    const first = await exportReport(a, p, body(), key);
    const second = await exportReport(a, p, body(), key);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.body).toBe(first.body);
    expect(await usage(a.workspaceId)).toEqual({ used: 1, reserved: 0 });
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM report_artifacts`)).rows[0] as { n: number }).n).toBe(1);
  }, 120_000);

  it("STORY-100 s8 — the Idempotency-Key is required on this route", async () => {
    const { a, p } = await seeded();
    const res = await exportReport(a, p, body(), null);
    expect(res.statusCode, res.body).toBe(400);
  });

  it("STORY-100 s9 — a tier with ZERO allowance is 403 feature_not_in_plan for a PDF, not 429, and nothing is stored", async () => {
    const { a, p } = await seeded("starter");
    const res = await exportReport(a, p, body());
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "feature_not_in_plan", details: { key: "exports.pdf_per_cycle" } });
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM report_artifacts`)).rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-100 — CSV is gated by exports.csv: a tier without it is 403 feature_not_in_plan naming exports.csv", async () => {
    const { a, p } = await seeded("starter");
    const res = await exportReport(a, p, body({ format: "csv" }));
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "feature_not_in_plan", details: { key: "exports.csv" } });
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM report_artifacts`)).rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-100 — an exhausted non-zero allowance is 429 quota_exceeded with the reset date, distinct from the 403", async () => {
    const { a, p } = await seeded();
    expect((await exportReport(a, p, body())).statusCode).toBe(201);
    await harness.db().query(`UPDATE usage_counters SET used_value = 25 WHERE workspace_id = $1 AND metric = 'pdf_exports'`, [a.workspaceId]);
    const res = await exportReport(a, p, body());
    expect(res.statusCode, res.body).toBe(429);
    expect(errorOf(res)).toMatchObject({ code: "quota_exceeded", details: { metric: "pdf_exports", limit: 25 } });
    expect(typeof errorOf(res).details?.resets_at).toBe("string");
  }, 120_000);

  it("STORY-100 — owner export:data demands a fresh step-up; an analyst does not", async () => {
    const stale = await owner("growth", false);
    const p = await project(stale.workspaceId);
    const refused = await exportReport(stale, p, body());
    expect(refused.statusCode, refused.body).toBe(401);
    expect(errorOf(refused).code).toBe("step_up_required");
    const analyst = await member(stale.workspaceId, "analyst");
    expect((await exportReport(analyst, p, body())).statusCode).toBe(201);
  }, 120_000);

  it("STORY-100 — a viewer is refused 403 naming export:data", async () => {
    const { a, p } = await seeded();
    const viewer = await member(a.workspaceId, "viewer");
    const res = await exportReport(viewer, p, body());
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.stringify(res.json())).toContain("export:data");
  }, 120_000);

  it("STORY-100 s18 — a project-scoped manager cannot export a project outside the scope, and can export one inside it", async () => {
    const { a, p } = await seeded();
    const other = await project(a.workspaceId, "Other");
    const manager = await member(a.workspaceId, "manager", [other]);
    const refused = await exportReport(manager, p, body());
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused).code).toBe("project_out_of_scope");
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM report_artifacts`)).rows[0] as { n: number }).n).toBe(0);
    expect((await exportReport(manager, other, body())).statusCode).toBe(201);
  }, 120_000);

  it("STORY-100 — another workspace's project is a 404 and nothing is metered", async () => {
    const { a } = await seeded();
    const b = await owner("growth");
    const foreign = await project(b.workspaceId);
    const res = await exportReport(a, foreign, body());
    expect(res.statusCode, res.body).toBe(404);
    expect(await usage(b.workspaceId)).toBeUndefined();
  }, 120_000);

  it("STORY-100 s6 — a project with no rollup exports an honest empty document, not zeros", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const res = await exportReport(a, p, body({ format: "csv" }));
    expect(res.statusCode, res.body).toBe(201);
    const exported = exportResponseSchema.parse(data(res));
    expect(exported.footer.data_through).toBeNull();
    expect(exported.footer.live_capture_ratio).toBeNull();
    const csv = fileOf(exported).toString("utf8");
    expect(csv).toContain("methodology,,,,data_through,,");
    expect(csv).not.toMatch(/visibility_score,0,/);
  }, 120_000);

  it("STORY-100 — hide_competitors keeps competitor names out of the stored file", async () => {
    const { a, p } = await seeded();
    const competitorId = uuidV7();
    await harness.db().query(`INSERT INTO competitors (id, workspace_id, project_id, name) VALUES ($1,$2,$3,'Rival Roofing')`, [competitorId, a.workspaceId, p]);
    await metric(a.workspaceId, p, "gemini", 2, { entity: "competitor", entityId: competitorId, score: "30.000" });
    await metric(a.workspaceId, p, "all", 2, { entity: "competitor", entityId: competitorId, score: "30.000" });
    const shown = fileOf(data<Exported>(await exportReport(a, p, body({ format: "csv" }))));
    expect(shown.toString()).toContain("Rival Roofing");
    const hidden = fileOf(data<Exported>(await exportReport(a, p, body({ format: "csv", hide_competitors: true }))));
    expect(hidden.toString()).not.toContain("Rival Roofing");
  }, 120_000);
});
