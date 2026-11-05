import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-180 AC5 - with object storage NOT configured the export answers 503 `degraded`. There is no silent inline fallback: no
// `data:` URL comes back and no artifact row is written. (No STORAGE_* key is set by this file; the harness applies none.)

describe("STORY-180 AC5 · export with storage not configured", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({ env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }) });
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

  it("is 503 degraded for a CSV and a PDF, returns no data: URL, and writes no artifact row", async () => {
    expect(process.env.STORAGE_BUCKET_REPORTS).toBeUndefined();
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    const tokens = await sessions.createSession(userId, new Date(), "email_otp");
    const cookie = `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${CSRF_COOKIE_NAME}=${tokens.csrfToken}`;
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie, [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    const entry = `${ACCESS_COOKIE_NAME}=${entered.accessToken}; ${CSRF_COOKIE_NAME}=${entered.csrfToken}`;
    const projectId = uuidV7();
    await harness.db().query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://acme.test','acme.test')`, [projectId, workspaceId, `p-${projectId.slice(-12)}`]);

    for (const format of ["csv", "pdf"]) {
      const res = await harness.app().inject({
        method: "POST",
        url: apiUrl(`/projects/${projectId}/reports/export`),
        headers: { cookie: entry, [CSRF_HEADER_NAME]: entered.csrfToken, "content-type": "application/json", "idempotency-key": `k-${format}-${uuidV7()}` },
        payload: { format, sections: ["overview"], timeframe: "30d", hide_competitors: false, hide_costs: true },
      });
      expect(res.statusCode, res.body).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe("degraded");
      expect(res.body).not.toContain("data:");
    }
    const rows = (await harness.db().query(`SELECT count(*)::int AS n FROM report_artifacts WHERE workspace_id = $1`, [workspaceId])).rows[0] as { n: number };
    expect(rows.n).toBe(0);
    // STORY-180 r6: the readiness refusal comes BEFORE QuotaGuard, so the PDF never reserved a unit (reserved AND used are both 0).
    const counter = (await harness.db().query(`SELECT used_value::int AS used, reserved_value::int AS reserved FROM usage_counters WHERE workspace_id = $1 AND metric = 'pdf_exports'`, [workspaceId])).rows as Array<{ used: number; reserved: number }>;
    // Asserted as a COUNT as well as with `every`, which is vacuously true over no rows: the guard never provisioned a counter at all.
    expect(counter).toHaveLength(0);
    expect(counter.every((c) => c.used === 0 && c.reserved === 0)).toBe(true);
    expect(((await harness.db().query(`SELECT count(*)::int AS n FROM usage_reservations WHERE workspace_id = $1`, [workspaceId])).rows[0] as { n: number }).n).toBe(0);
  }, 180_000);
});
