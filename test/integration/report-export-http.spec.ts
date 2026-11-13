import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportResponseSchema } from "../../contracts/reports/index.js";
import { collectAfterTransactionTasks, type AfterTransactionTask } from "../../src/api/after-transaction.js";
import { RateLimitBuckets } from "../../src/api/rate-limit/buckets.js";
import { ReportsController } from "../../src/modules/reports/reports.controller.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { hashReportLinkToken, reportLinkToken } from "../../src/lib/reports/report-artifact-mail.js";
import { OBJECT_STORAGE, type ObjectStoragePort } from "../../src/lib/storage/storage.port.js";
import { METHODOLOGY_NOTE } from "../../src/lib/reports/methodology-footer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import { fetchStored, reportStorageEnv } from "../support/report-storage-env.js";
import { pdfRaw, pdfText } from "../support/pdf-text.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-E-100b — POST /v1/projects/{id}/reports/export through the REAL ApiModule.
// STORY-100 scenarios 1, 2, 3, 4, 8, 9 and 18 end to end; the document model's
// own scenarios (1-3, 5, 6) are in test/unit/reports/export-document.spec.ts.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-100 · on-demand export over HTTP", () => {
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
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function member(workspaceId: string, role: "admin" | "manager" | "analyst" | "viewer", projectScope: string[] | null = null): Promise<Actor> {
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
  const exportReport = (a: Actor, projectId: string, payload: unknown, key: string | null = `key-${String(++keyCounter)}-${uuidV7()}`) => {
    lastActor = a;
    return harness.app().inject({
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
  };
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;
  type Exported = ReturnType<typeof exportResponseSchema.parse>;
  // STORY-180: download_url is the API's own route. The browser follows it with the session cookie of whoever exported (the latest
  // exportReport call). Since owner decision 60 (c) the export answers only once the file is stored, so the FIRST request is a 302.
  let lastActor: Actor | undefined;
  const downloadRoute = (e: Exported, cookie: string) => harness.app().inject({ method: "GET", url: new URL(e.download_url).pathname, headers: { cookie } });
  const fileOf = async (e: Exported): Promise<Buffer> => {
    const res = await downloadRoute(e, lastActor!.cookie);
    if (res.statusCode !== 302) throw new Error(`download route answered ${String(res.statusCode)}: ${res.body}`);
    return fetchStored(String(res.headers.location));
  };
  const objectKeyOf = async (id: string): Promise<string> => ((await harness.db().query(`SELECT object_key FROM report_artifacts WHERE id = $1`, [id])).rows[0] as { object_key: string }).object_key;
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
    // STORY-180 AC2: the API's download route (an http(s) URL), never a data: URL and never a presign minted before the file exists.
    expect(exported.download_url).toMatch(/^https?:\/\//);
    expect(exported.download_url).not.toMatch(/^data:/);
    expect(new URL(exported.download_url).pathname).toBe(`/v1/exports/${exported.export_id}/download`);
    expect(exported.footer.note).toBe(METHODOLOGY_NOTE);
    expect(exported.footer.engines).toEqual(["chatgpt", "gemini"]);
    const file = (await fileOf(exported));
    expect(file.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfRaw(file)).toContain(METHODOLOGY_NOTE);

    const row = (await harness.db().query(`SELECT * FROM report_artifacts WHERE id = $1`, [exported.export_id])).rows[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.workspace_id).toBe(a.workspaceId);
    expect(row.project_ids).toEqual([p]);
    expect(row.format).toBe("pdf");
    // r5 (c): the real key was recorded BEFORE the export answered - no waiting.
    const stored = (await harness.db().query(`SELECT object_key FROM report_artifacts WHERE id = $1`, [exported.export_id])).rows[0] as { object_key: string };
    expect(stored.object_key).toBe(`inttest/${a.workspaceId}/${exported.export_id}.pdf`);
    expect(row.bytes).toBe(file.length);
    expect(row.methodology_footer).toEqual(exported.footer);
    expect(row.scheduled_report_id).toBeNull();
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(Date.now());
    const audit = (await harness.db().query(`SELECT action, resource_type, resource_id FROM audit_log WHERE workspace_id = $1 AND action = 'report.exported'`, [a.workspaceId])).rows;
    expect(audit).toEqual([{ action: "report.exported", resource_type: "report_artifact", resource_id: exported.export_id }]);
  }, 120_000);

  it("STORY-180 AC2 · the download route 302s to a fresh 15-minute presign of the STORED key, named for the file, uncached", async () => {
    const { a, p } = await seeded();
    const exported = exportResponseSchema.parse(data(await exportReport(a, p, body())));
    expect(await objectKeyOf(exported.export_id)).toBe(`inttest/${a.workspaceId}/${exported.export_id}.${exported.format}`);
    const res = await downloadRoute(exported, a.cookie);
    expect(res.statusCode, res.body).toBe(302);
    const location = String(res.headers.location);
    expect(location).toContain(`/nominara-reports/inttest/${a.workspaceId}/${exported.export_id}.pdf`);
    expect(new URL(location).searchParams.get("X-Amz-Expires")).toBe("900");
    expect(res.headers["cache-control"]).toBe("no-store");
    const fetched = await fetch(location);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toBe(`attachment; filename="${exported.filename}"`);
    await fetched.arrayBuffer();
    // Re-fetched on every click: a replayed response (same Idempotency-Key) still downloads.
    expect((await downloadRoute(exported, a.cookie)).statusCode).toBe(302);
    const row = (await harness.db().query(`SELECT download_count FROM report_artifacts WHERE id = $1`, [exported.export_id])).rows[0] as { download_count: number };
    expect(row.download_count).toBe(2);
  }, 120_000);

  it("STORY-180 AC2 · more concurrent downloads than the pool holds all complete (the route takes no pooled connection beyond the request's own)", async () => {
    const { a, p } = await seeded();
    const exported = exportResponseSchema.parse(data(await exportReport(a, p, body())));
    expect(await objectKeyOf(exported.export_id)).toBe(`inttest/${a.workspaceId}/${exported.export_id}.${exported.format}`);
    // The app pool's default max is 10: 40 in flight at once would hang forever if each request waited for a second connection.
    const all = await Promise.all(Array.from({ length: 40 }, () => downloadRoute(exported, a.cookie)));
    expect(all.map((r) => r.statusCode)).toEqual(Array.from({ length: 40 }, () => 302));
    const row = (await harness.db().query(`SELECT download_count FROM report_artifacts WHERE id = $1`, [exported.export_id])).rows[0] as { download_count: number };
    expect(row.download_count).toBe(40);
  }, 60_000);

  it("STORY-180 AC2 · a manager scoped to the export's project may download it; one scoped to another project gets the neutral 404", async () => {
    const { a, p } = await seeded();
    const other = await project(a.workspaceId, "Other");
    const exported = exportResponseSchema.parse(data(await exportReport(a, p, body({ format: "csv" }))));
    expect(await objectKeyOf(exported.export_id)).toBe(`inttest/${a.workspaceId}/${exported.export_id}.${exported.format}`);
    const inScope = await member(a.workspaceId, "manager", [p]);
    const outOfScope = await member(a.workspaceId, "manager", [other]);
    expect((await downloadRoute(exported, inScope.cookie)).statusCode).toBe(302);
    expect((await downloadRoute(exported, outOfScope.cookie)).statusCode).toBe(404);
  }, 180_000);

  it.each(["pending", "failed", "purged"])("STORY-180 r5 · a row whose key is only a %s marker answers a clear 503 degraded, with no redirect and no Retry-After", async (marker) => {
    const { a, p } = await seeded();
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO report_artifacts (id, workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-31','pdf',$4,10,'{}'::jsonb, now() + interval '7 days')`,
      [id, a.workspaceId, [p], `${marker}:${id}`],
    );
    const res = await harness.app().inject({ method: "GET", url: apiUrl(`/exports/${id}/download`), headers: { cookie: a.cookie } });
    expect(res.statusCode, res.body).toBe(503);
    expect(errorOf(res).code).toBe("degraded");
    expect(res.headers.location).toBeUndefined();
    expect(res.headers["retry-after"]).toBeUndefined();
  }, 120_000);

  it("STORY-180 r5 (c) · the export answers only after the file is stored: the first download after the response is a 302 to an existing object", async () => {
    const { a, p } = await seeded();
    const res = await exportReport(a, p, body({ format: "csv" }));
    expect(res.statusCode, res.body).toBe(201);
    const exported = exportResponseSchema.parse(data(res));
    const first = await downloadRoute(exported, a.cookie);
    expect(first.statusCode, first.body).toBe(302);
    const fetched = await fetch(String(first.headers.location));
    expect(fetched.status).toBe(200);
    await fetched.arrayBuffer();
  }, 120_000);

  it("STORY-180 r5 (c) · a failed upload answers 503 degraded, the row is marked failed (never left pending), and its download is a 503", async () => {
    const { a, p } = await seeded();
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const put = vi.spyOn(port, "put").mockRejectedValueOnce(new Error("s3 down"));
    try {
      const res = await exportReport(a, p, body({ format: "csv" }));
      expect(res.statusCode, res.body).toBe(503);
      expect(errorOf(res).code).toBe("degraded");
    } finally {
      put.mockRestore();
    }
    const rows = (await harness.db().query(`SELECT id, object_key FROM report_artifacts WHERE workspace_id = $1`, [a.workspaceId])).rows as Array<{ id: string; object_key: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.object_key).toBe(`failed:${rows[0]!.id}`);
    expect(await harness.db().query(`SELECT 1 FROM report_artifacts WHERE workspace_id = $1 AND object_key LIKE 'pending:%'`, [a.workspaceId]).then((r) => r.rowCount)).toBe(0);
    const download = await harness.app().inject({ method: "GET", url: apiUrl(`/exports/${rows[0]!.id}/download`), headers: { cookie: a.cookie } });
    expect(download.statusCode, download.body).toBe(503);
  }, 120_000);

  it("STORY-180 r6 · a PDF whose upload fails uses no unit: a retry under a NEW key that succeeds leaves used = 1 and reserved = 0", async () => {
    const { a, p } = await seeded();
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const put = vi.spyOn(port, "put").mockRejectedValueOnce(new Error("s3 down"));
    try {
      const failed = await exportReport(a, p, body());
      expect(failed.statusCode, failed.body).toBe(503);
    } finally {
      put.mockRestore();
    }
    expect(await usage(a.workspaceId)).toEqual({ used: 0, reserved: 0 });
    const retried = await exportReport(a, p, body());
    expect(retried.statusCode, retried.body).toBe(201);
    expect(data<Exported>(retried).pdf).toEqual({ used: 1, cap: 25 });
    expect(await usage(a.workspaceId)).toEqual({ used: 1, reserved: 0 });
  }, 120_000);

  it("STORY-180 r6 · a retry under the SAME key after a failed upload re-takes the released unit: it is capped and counted, not free", async () => {
    const { a, p } = await seeded();
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const key = `same-${uuidV7()}`;
    const put = vi.spyOn(port, "put").mockRejectedValueOnce(new Error("s3 down"));
    try {
      expect((await exportReport(a, p, body(), key)).statusCode).toBe(503);
    } finally {
      put.mockRestore();
    }
    expect(await usage(a.workspaceId)).toEqual({ used: 0, reserved: 0 });
    const retried = await exportReport(a, p, body(), key);
    expect(retried.statusCode, retried.body).toBe(201);
    expect(await usage(a.workspaceId)).toEqual({ used: 1, reserved: 0 });
  }, 120_000);

  it("STORY-180 r6 · the audit trail tells the truth: a failed upload leaves report.export_attempted and report.export_failed (outcome put_failed) and NO report.exported; a stored one leaves attempted and exported", async () => {
    const { a, p } = await seeded();
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    const actions = async (): Promise<string[]> =>
      ((await harness.db().query(`SELECT action FROM audit_log WHERE workspace_id = $1 AND action LIKE 'report.export%' ORDER BY seq`, [a.workspaceId])).rows as Array<{ action: string }>).map((r) => r.action);
    const put = vi.spyOn(port, "put").mockRejectedValueOnce(new Error("s3 down"));
    try {
      expect((await exportReport(a, p, body({ format: "csv" }))).statusCode).toBe(503);
    } finally {
      put.mockRestore();
    }
    expect(await actions()).toEqual(["report.export_attempted", "report.export_failed"]);
    const failedRow = (await harness.db().query(`SELECT after_state FROM audit_log WHERE workspace_id = $1 AND action = 'report.export_failed'`, [a.workspaceId])).rows[0] as { after_state: unknown };
    expect(failedRow.after_state).toEqual({ outcome: "put_failed" });
    expect((await exportReport(a, p, body({ format: "csv" }))).statusCode).toBe(201);
    expect(await actions()).toEqual(["report.export_attempted", "report.export_failed", "report.export_attempted", "report.exported"]);
  }, 120_000);

  it("STORY-180 r5 (c) · a put that landed but could not be recorded: the object is deleted, the row is marked failed, the export answers 503", async () => {
    const { a, p } = await seeded();
    const port = harness.app().get<ObjectStoragePort>(OBJECT_STORAGE, { strict: false });
    // Fail exactly the statement that records the real key (an UPDATE setting a full `inttest/...` key), nothing else.
    await harness.db().query(`CREATE OR REPLACE FUNCTION s180_block_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 's180 record blocked'; END $$`);
    await harness.db().query(`CREATE TRIGGER s180_block_record_trg BEFORE UPDATE ON report_artifacts FOR EACH ROW WHEN (NEW.object_key LIKE 'inttest/%') EXECUTE FUNCTION s180_block_record()`);
    try {
      const res = await exportReport(a, p, body({ format: "csv" }));
      expect(res.statusCode, res.body).toBe(503);
    } finally {
      await harness.db().query(`DROP TRIGGER s180_block_record_trg ON report_artifacts`);
    }
    const row = (await harness.db().query(`SELECT id, object_key FROM report_artifacts WHERE workspace_id = $1`, [a.workspaceId])).rows[0] as { id: string; object_key: string };
    expect(row.object_key).toBe(`failed:${row.id}`);
    await expect(port.head("reports", `inttest/${a.workspaceId}/${row.id}.csv`)).rejects.toMatchObject({ name: "NotFoundError" });
  }, 120_000);

  it("STORY-180 AC2 · another workspace's export, an expired one and an unknown id are the same 404; no session is 401; a malformed id is 400", async () => {
    const { a, p } = await seeded();
    const other = await seeded();
    const exported = exportResponseSchema.parse(data(await exportReport(other.a, other.p, body({ format: "csv" }))));
    expect(await objectKeyOf(exported.export_id)).toBe(`inttest/${other.a.workspaceId}/${exported.export_id}.${exported.format}`);
    const foreign = await downloadRoute(exported, a.cookie);
    await harness.db().query(`UPDATE report_artifacts SET expires_at = now() - interval '1 minute' WHERE id = $1`, [exported.export_id]);
    const expired = await downloadRoute(exported, other.a.cookie);
    const unknown = await harness.app().inject({ method: "GET", url: apiUrl(`/exports/${uuidV7()}/download`), headers: { cookie: a.cookie } });
    for (const res of [foreign, expired, unknown]) {
      expect(res.statusCode).toBe(404);
      expect(res.headers.location).toBeUndefined();
    }
    expect((await harness.app().inject({ method: "GET", url: apiUrl(`/exports/${uuidV7()}/download`) })).statusCode).toBe(401);
    expect((await harness.app().inject({ method: "GET", url: apiUrl(`/exports/not-a-uuid/download`), headers: { cookie: a.cookie } })).statusCode).toBe(400);
    void p;
  }, 180_000);

  it("STORY-100 s1 — a CSV export carries the footer rows and the per-engine rows beside the blend", async () => {
    const { a, p } = await seeded();
    const res = await exportReport(a, p, body({ format: "csv" }));
    expect(res.statusCode, res.body).toBe(201);
    const exported = exportResponseSchema.parse(data(res));
    expect(new URL(exported.download_url).pathname).toBe(`/v1/exports/${exported.export_id}/download`);
    expect(exported.filename).toMatch(/\.csv$/);
    const csv = (await fileOf(exported)).toString("utf8");
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
      expect(pdfRaw((await fileOf(exported)))).toContain(METHODOLOGY_NOTE);
      expect(exported.footer.note).toBe(METHODOLOGY_NOTE);
    }
  }, 120_000);

  async function hideBrandTheme(workspaceId: string): Promise<void> {
    await harness.db().query(`INSERT INTO brand_themes (id, workspace_id, name, is_default, hide_nominara_brand) VALUES ($1,$2,'T',true,true)`, [uuidV7(), workspaceId]);
  }

  it("CP1 downgrade — with whitelabel.remove_branding granted (business) a stored hide_nominara_brand drops the brand line; the footer stays", async () => {
    const { a, p } = await seeded("business");
    await hideBrandTheme(a.workspaceId);
    const res = await exportReport(a, p, body());
    expect(res.statusCode, res.body).toBe(201);
    const text = pdfText((await fileOf(exportResponseSchema.parse(data(res)))));
    expect(text).not.toContain("Powered by Nominara");
    expect(text).toContain("Methodology");
  }, 120_000);

  it("CP1 downgrade — a workspace downgraded below the plan that grants brand removal exports WITH the brand line, though its stored theme still says hide", async () => {
    const { a, p } = await seeded("growth");
    await hideBrandTheme(a.workspaceId);
    const res = await exportReport(a, p, body());
    expect(res.statusCode, res.body).toBe(201);
    const text = pdfText((await fileOf(exportResponseSchema.parse(data(res)))));
    expect(text).toContain("Powered by Nominara");
    expect(text).toContain("Methodology");
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
    // the unit QuotaGuard reserved for a PDF that can never succeed is given back
    expect(await usage(a.workspaceId)).toEqual({ used: 0, reserved: 0 });
  }, 120_000);

  it("STORY-100 s6 — a project with no rollup exports an honest empty document, not zeros", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    const res = await exportReport(a, p, body({ format: "csv" }));
    expect(res.statusCode, res.body).toBe(201);
    const exported = exportResponseSchema.parse(data(res));
    expect(exported.footer.data_through).toBeNull();
    expect(exported.footer.live_capture_ratio).toBeNull();
    const csv = (await fileOf(exported)).toString("utf8");
    expect(csv).toContain("methodology,,,,data_through,,");
    expect(csv).not.toMatch(/visibility_score,0,/);
  }, 120_000);

  it("STORY-100 — hide_competitors keeps competitor names out of the stored file", async () => {
    const { a, p } = await seeded();
    const competitorId = uuidV7();
    await harness.db().query(`INSERT INTO competitors (id, workspace_id, project_id, name) VALUES ($1,$2,$3,'Rival Roofing')`, [competitorId, a.workspaceId, p]);
    await metric(a.workspaceId, p, "gemini", 2, { entity: "competitor", entityId: competitorId, score: "30.000" });
    await metric(a.workspaceId, p, "all", 2, { entity: "competitor", entityId: competitorId, score: "30.000" });
    const shown = (await fileOf(data<Exported>(await exportReport(a, p, body({ format: "csv" })))));
    expect(shown.toString()).toContain("Rival Roofing");
    const hidden = (await fileOf(data<Exported>(await exportReport(a, p, body({ format: "csv", hide_competitors: true })))));
    expect(hidden.toString()).not.toContain("Rival Roofing");
  }, 120_000);
  // STORY-100 AC2 / scenario 3 — the third suppression route (a section selection) and the second format (CSV).
  const SECTIONS = ["overview", "growth_map", "matrix", "competitors", "sources", "tasks", "aux"] as const;

  it("STORY-100 s3 — a section selection cannot drop the footer: an empty selection or a 'footer' section is a 400, and EVERY single-section selection keeps it in PDF and CSV", async () => {
    const { a, p } = await seeded();
    for (const sections of [[], ["footer"], ["methodology"], ["overview", "footer"]]) {
      const res = await exportReport(a, p, body({ sections }));
      expect(res.statusCode, JSON.stringify(sections)).toBe(400);
      expect(errorOf(res).code).toBe("validation_failed");
    }
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM report_artifacts`)).rows[0] as { n: number }).n).toBe(0);
    for (const section of SECTIONS) {
      const pdf = await exportReport(a, p, body({ sections: [section] }));
      expect(pdf.statusCode, `${section} pdf: ${pdf.body}`).toBe(201);
      const stored = exportResponseSchema.parse(data(pdf));
      expect(pdfRaw((await fileOf(stored))), `${section} pdf`).toContain(METHODOLOGY_NOTE);
      expect(stored.footer.note).toBe(METHODOLOGY_NOTE);

      const csv = await exportReport(a, p, body({ format: "csv", sections: [section] }));
      expect(csv.statusCode, `${section} csv: ${csv.body}`).toBe(201);
      const text = (await fileOf(exportResponseSchema.parse(data(csv)))).toString("utf8");
      expect(text, `${section} csv`).toContain("methodology,,,,scoring_version,");
      expect(text, `${section} csv`).toContain(METHODOLOGY_NOTE);
    }
  }, 240_000);

  it("STORY-100 s2/s3 — on a CSV export, brand removal and a hostile theme stylesheet leave the footer rows in the file and in the stored artifact", async () => {
    const { a, p } = await seeded("business");
    await harness.db().query(
      `INSERT INTO brand_themes (id, workspace_id, name, is_default, hide_nominara_brand, custom_css) VALUES ($1,$2,'T',true,true,'.footer{display:none}')`,
      [uuidV7(), a.workspaceId],
    );
    const res = await exportReport(a, p, body({ format: "csv", sections: ["tasks"] }));
    expect(res.statusCode, res.body).toBe(201);
    const exported = exportResponseSchema.parse(data(res));
    const text = (await fileOf(exported)).toString("utf8");
    expect(text).toContain("methodology,,,,scoring_version,");
    expect(text).toContain("methodology,,,,note,");
    expect(text).toContain(METHODOLOGY_NOTE);
    const row = (await harness.db().query(`SELECT methodology_footer FROM report_artifacts WHERE id = $1`, [exported.export_id])).rows[0] as { methodology_footer: { note: string } };
    expect(row.methodology_footer.note).toBe(METHODOLOGY_NOTE);
  }, 120_000);

  it("STORY-100 s6 — a low-confidence figure keeps its treatment: 'low confidence' in the PDF, `low` in the CSV confidence column; an absent figure is an empty cell, never 0", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    await metric(a.workspaceId, p, "gemini", 2, { cells: 3, score: "70.000" });
    await metric(a.workspaceId, p, "chatgpt", 2, { cells: 200, score: "50.000" });
    await metric(a.workspaceId, p, "all", 2, { cells: 3, score: "60.000" });

    const pdf = await exportReport(a, p, body({ sections: ["overview"] }));
    expect(pdf.statusCode, pdf.body).toBe(201);
    const text = pdfText((await fileOf(exportResponseSchema.parse(data(pdf)))));
    expect(text).toContain("low confidence");
    expect(text).toContain("high");

    const csv = await exportReport(a, p, body({ format: "csv", sections: ["overview"] }));
    expect(csv.statusCode, csv.body).toBe(201);
    const rows = (await fileOf(exportResponseSchema.parse(data(csv)))).toString("utf8");
    expect(rows).toMatch(/overview,,brand,gemini,visibility_score,70,low,3,/);
    expect(rows).toMatch(/overview,,brand,all,visibility_score,60,low,3,/);
    expect(rows).toMatch(/overview,,brand,chatgpt,visibility_score,50,high,200,/);
    // sentiment was never measured: an empty value cell, not a zero
    expect(rows).toMatch(/overview,,brand,gemini,sentiment_score,,low,3,/);
    expect(rows).not.toMatch(/sentiment_score,0,/);
  }, 120_000);

  it("STORY-100 s6 (batch 13) — the growth map carries each day's cell count and confidence from the rollup, and an unavailable section makes the footer say partial", async () => {
    const a = await owner("growth");
    const p = await project(a.workspaceId);
    await metric(a.workspaceId, p, "gemini", 2, { cells: 3, score: "70.000" });
    await metric(a.workspaceId, p, "chatgpt", 2, { cells: 200, score: "50.000" });
    await metric(a.workspaceId, p, "all", 2, { cells: 203, score: "52.000" });

    const csv = await exportReport(a, p, body({ format: "csv", sections: ["growth_map", "matrix"] }));
    expect(csv.statusCode, csv.body).toBe(201);
    const rows = (await fileOf(exportResponseSchema.parse(data(csv)))).toString("utf8");
    expect(rows).toMatch(/growth_map,\d{4}-\d{2}-\d{2},brand,gemini,visibility_score,70,low,3,/);
    expect(rows).toMatch(/growth_map,\d{4}-\d{2}-\d{2},brand,chatgpt,visibility_score,50,high,200,/);
    expect(rows).toContain("methodology,,,,export_status,partial,");
    expect(rows).toContain("methodology,,,,unavailable_sections,matrix,");
  }, 120_000);

  // ---- STORY-180 r5 (d): revoking a sent link --------------------------------------------------------------------------------------
  const LINK_KEY = Buffer.alloc(32, 9);
  async function linked(workspaceId: string, projectId: string): Promise<{ id: string; token: string }> {
    const id = uuidV7();
    const token = reportLinkToken(LINK_KEY, id);
    await harness.db().query(
      `INSERT INTO report_artifacts (id, workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at, link_token_hash)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-31','pdf',$4,10,'{}'::jsonb, now() + interval '7 days', $5)`,
      [id, workspaceId, [projectId], `inttest/${workspaceId}/${id}.pdf`, hashReportLinkToken(token)],
    );
    return { id, token };
  }
  const revoke = (a: Actor, id: string) =>
    harness.app().inject({ method: "POST", url: apiUrl(`/exports/${id}/revoke-link`), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf } });
  const clickLink = (workspaceId: string, token: string) => harness.app().inject({ method: "GET", url: apiUrl(`/report-links/${workspaceId}/${token}`) });
  const revokedAt = async (id: string) => ((await harness.db().query(`SELECT link_revoked_at FROM report_artifacts WHERE id = $1`, [id])).rows[0] as { link_revoked_at: Date | null }).link_revoked_at;

  it("STORY-180 r5 (d) · an owner revokes a sent link: link_revoked_at is set, it is audited, and the link route then says 'This link was revoked.' (not a 404)", async () => {
    const { a, p } = await seeded();
    const l = await linked(a.workspaceId, p);
    expect((await clickLink(a.workspaceId, l.token)).statusCode).toBe(302);
    const res = await revoke(a, l.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ export_id: string; link_revoked_at: string }>(res).export_id).toBe(l.id);
    expect(await revokedAt(l.id)).not.toBeNull();
    const audit = (await harness.db().query(`SELECT action, resource_type, resource_id FROM audit_log WHERE workspace_id = $1 AND action = 'report_link.revoked'`, [a.workspaceId])).rows;
    expect(audit).toEqual([{ action: "report_link.revoked", resource_type: "report_artifact", resource_id: l.id }]);
    const click = await clickLink(a.workspaceId, l.token);
    expect(click.statusCode, click.body).toBe(401);
    expect(errorOf(click).code).toBe("token_revoked");
    expect((click.json() as { error: { message: string } }).error.message).toBe("This link was revoked.");
    expect(click.headers.location).toBeUndefined();
  }, 120_000);

  it("STORY-180 r5 (d) · revoking twice is idempotent: the first revocation's time stands", async () => {
    const { a, p } = await seeded();
    const l = await linked(a.workspaceId, p);
    const first = data<{ link_revoked_at: string }>(await revoke(a, l.id)).link_revoked_at;
    await new Promise((r) => setTimeout(r, 20));
    const second = data<{ link_revoked_at: string }>(await revoke(a, l.id)).link_revoked_at;
    expect(second).toBe(first);
  }, 120_000);

  it("STORY-180 r5 (d) · an admin may revoke; a manager, analyst and viewer are refused 403 naming agency:branding and nothing is revoked", async () => {
    const { a, p } = await seeded();
    const l = await linked(a.workspaceId, p);
    for (const role of ["manager", "analyst", "viewer"] as const) {
      const res = await revoke(await member(a.workspaceId, role), l.id);
      expect(res.statusCode, `${role}: ${res.body}`).toBe(403);
      expect(JSON.stringify(res.json())).toContain("agency:branding");
    }
    // A project-scoped manager is refused too (the permission is workspace-wide).
    expect((await revoke(await member(a.workspaceId, "manager", [p]), l.id)).statusCode).toBe(403);
    expect(await revokedAt(l.id)).toBeNull();
    expect((await revoke(await member(a.workspaceId, "admin"), l.id)).statusCode).toBe(200);
    expect(await revokedAt(l.id)).not.toBeNull();
  }, 180_000);

  it("STORY-180 r5 (d) · another workspace's owner cannot revoke this workspace's link: a 404, and the link keeps working", async () => {
    const { a, p } = await seeded();
    const other = await seeded();
    const l = await linked(a.workspaceId, p);
    const res = await revoke(other.a, l.id);
    expect(res.statusCode, res.body).toBe(404);
    expect(await revokedAt(l.id)).toBeNull();
    expect((await clickLink(a.workspaceId, l.token)).statusCode).toBe(302);
    expect((await harness.app().inject({ method: "POST", url: apiUrl(`/exports/${l.id}/revoke-link`) })).statusCode).toBe(401);
    expect((await revoke(a, "not-a-uuid")).statusCode).toBe(400);
  }, 180_000);
  it("STORY-180 r7 · the PDF unit is reserved under http:<actor>:<Idempotency-Key>, so another user's key (or scheduled-report:<id>) can never collide with it", async () => {
    const { a, p } = await seeded();
    const key = `ns-${uuidV7()}`;
    expect((await exportReport(a, p, body(), key)).statusCode).toBe(201);
    const held = (await harness.db().query(`SELECT job_id, state FROM usage_reservations WHERE workspace_id = $1`, [a.workspaceId])).rows;
    expect(held).toEqual([{ job_id: `http:${a.userId}:${key}`, state: "committed" }]);
    // A second user presenting the SAME key reserves (and consumes) a unit of their own: no replay across actors.
    const other = await member(a.workspaceId, "manager", [p]);
    expect((await exportReport(other, p, body(), key)).statusCode).toBe(201);
    expect(await usage(a.workspaceId)).toEqual({ used: 2, reserved: 0 });
  }, 180_000);

  it("STORY-180 r7 · a rate-limited export (429) leaves reserved_value at 0: RateLimitGuard runs before QuotaGuard", async () => {
    const { a, p } = await seeded();
    const limiter = harness.app().get(RateLimitBuckets, { strict: false });
    vi.spyOn(limiter, "check").mockResolvedValue({ allowed: false, applied: false, limit: 0, remaining: 0, resetAfterMs: 1000 });
    const res = await exportReport(a, p, body());
    expect(res.statusCode, res.body).toBe(429);
    expect(errorOf(res).code).toBe("rate_limited");
    const counter = await usage(a.workspaceId);
    expect(counter?.reserved ?? 0).toBe(0);
    expect(counter?.used ?? 0).toBe(0);
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM usage_reservations WHERE workspace_id = $1`, [a.workspaceId])).rows[0] as { n: number }).n).toBe(0);
  }, 120_000);

  const auditRows = async (workspaceId: string, exportId: string) =>
    (
      await harness.db().query(
        `SELECT action, actor_type, actor_id::text, support_grant_id::text, request_id, host(actor_ip) AS ip, actor_ua FROM audit_log WHERE workspace_id = $1 AND resource_id = $2 ORDER BY seq`,
        [workspaceId, exportId],
      )
    ).rows as Array<{ action: string; actor_type: string; actor_id: string; support_grant_id: string | null; request_id: string; ip: string | null; actor_ua: string | null }>;

  it("STORY-180 r7 · over HTTP the outcome row (report.exported) names the same actor, request id and user agent as the interceptor's report.export_attempted row", async () => {
    const { a, p } = await seeded();
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/projects/${p}/reports/export`),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json", "idempotency-key": `ua-${uuidV7()}`, "user-agent": "nominara-test/7" },
      payload: body({ format: "csv" }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const rows = await auditRows(a.workspaceId, data<Exported>(res).export_id);
    expect(rows.map((r) => r.action)).toEqual(["report.export_attempted", "report.exported"]);
    expect(rows[1]).toEqual(rows[0] === undefined ? undefined : { ...rows[0], action: "report.exported" });
    expect(rows[1]!.actor_type).toBe("user");
    expect(rows[1]!.request_id).not.toBe("");
    expect(rows[1]!.actor_ua).toBe("nominara-test/7");
    expect(rows[1]!.ip).not.toBeNull();
  }, 120_000);

  // No production route sets `req.supportGrant` or `authMethod: "apiKey"` on this route yet, so these two drive the controller the way the
  // global chain would (TenantContextInterceptor's order: transaction, COMMIT, release, then the afterTransaction tasks), with the request
  // shape AuditInterceptor.writeAuditRow reads.
  async function exportAs(a: Actor, p: string, req: Record<string, unknown>): Promise<string> {
    const controller = harness.app().get(ReportsController, { strict: false });
    const tasks: AfterTransactionTask[] = [];
    const client = await pool.connect();
    let result: Exported;
    try {
      result = await collectAfterTransactionTasks(tasks, () =>
        withTenantContext(client, { workspaceId: a.workspaceId, actorId: a.userId }, () => controller.export(p, body({ format: "csv" }) as never, undefined, req as never)),
      );
    } finally {
      client.release();
    }
    for (const task of tasks) await task();
    return result.export_id;
  }

  it("STORY-180 r7 · an API-key export's outcome row is audited as api_key with the request's id, ip and user agent", async () => {
    const { a, p } = await seeded();
    const id = await exportAs(a, p, { authMethod: "apiKey", id: "req-apikey-1", ip: "203.0.113.7", headers: { "user-agent": "sdk/1.0" } });
    const rows = await auditRows(a.workspaceId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "report.exported", actor_type: "api_key", actor_id: a.userId, support_grant_id: null, request_id: "req-apikey-1", ip: "203.0.113.7", actor_ua: "sdk/1.0" });
  }, 120_000);

  it("STORY-180 r7 · a support-grant export's outcome row is audited as support, naming the grant", async () => {
    const { a, p } = await seeded();
    const grant = uuidV7();
    const id = await exportAs(a, p, { authMethod: "session", supportGrant: { id: grant }, id: "req-support-1", ip: "198.51.100.4", headers: { "user-agent": "support-console/2" } });
    const rows = await auditRows(a.workspaceId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "report.exported", actor_type: "support", support_grant_id: grant, request_id: "req-support-1", ip: "198.51.100.4", actor_ua: "support-console/2" });
  }, 120_000);
});
