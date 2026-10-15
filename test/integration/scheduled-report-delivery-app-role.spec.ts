import { Pool } from "pg";
import { scheduledReportDeliverySchema, scheduledReportSchema } from "../../contracts/reports/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { ScheduledReportsService } from "../../src/modules/reports/scheduled-reports.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// Group C review round 5 — the post-commit finalisation of a scheduled-report delivery runs as the real `nominara_app` role
// (NOBYPASSRLS), under FORCE ROW LEVEL SECURITY. The superuser used by the default harness bypasses RLS, so a finalise that
// was wrong about its tenant context would pass there for the wrong reason.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("Group C · scheduled-report delivery finalise under the app role (RLS)", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    runAsAppRole: true,
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }),
  });
  /** Superuser pool for fixtures only: the application under test runs as nominara_app. */
  let admin: Pool;
  let sessions: SessionService;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(() => {
    const c = harness.db();
    admin = new Pool({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database });
    sessions = new SessionService(admin, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
  });
  afterEach(async () => {
    await admin.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly cookie: string;
    readonly csrf: string;
  }

  async function owner(): Promise<Actor> {
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    const tokens = await sessions.createSession(userId, new Date(), "email_otp");
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    const client = await admin.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const version = ((await harness.db().query(`SELECT entitlement_version AS v FROM workspaces WHERE id = $1`, [workspaceId])).rows[0] as { v: number }).v;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function seeded(recipients: string[]) {
    const a = await owner();
    const projectId = uuidV7();
    await harness.db().query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://acme.test','acme.test')`, [projectId, a.workspaceId, `p-${projectId.slice(-12)}`]);
    for (const engine of ["gemini", "all"]) {
      await harness.db().query(
        `INSERT INTO metric_daily (workspace_id,project_id,engine_key,entity_type,entity_id,metric_date,cells_total,cells_present,presence_rate,visibility_score,live_capture_ratio)
         VALUES ($1,$2,$3,'brand',$2,(now() - interval '2 days')::date,40,20,0.5,70.000,1)`,
        [a.workspaceId, projectId, engine],
      );
    }
    const call = (method: "GET" | "POST", path: string, payload?: unknown) =>
      harness.app().inject({ method, url: apiUrl(path), headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const made = await call("POST", "/scheduled-reports", {
      label: "R", project_ids: [projectId], sections: ["overview"], cadence: "monthly", day: 15, hour: 8, format: "pdf", recipients,
    });
    expect(made.statusCode, made.body).toBe(201);
    const report = scheduledReportSchema.parse((made.json() as { data: unknown }).data);
    return { a, report, call };
  }

  const service = () => harness.app().get(ScheduledReportsService) as unknown as { email: unknown; startDelivery: (...args: unknown[]) => void };
  const deliveryRow = async (workspaceId: string) =>
    (await harness.db().query(`SELECT status, reason, recipient_count FROM scheduled_report_deliveries WHERE workspace_id = $1 ORDER BY attempted_at DESC LIMIT 1`, [workspaceId])).rows[0] as
      | { status: string; reason: string | null; recipient_count: number }
      | undefined;

  it("the app role really is NOBYPASSRLS here (so the cases below are not passing for the wrong reason)", async () => {
    const r = (await harness.db().query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'nominara_app'`)).rows[0];
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
    expect(new URL(process.env.DATABASE_URL!).username).toBe("nominara_app");
  });

  it("(a) send-now finishes `delivered` as the app role", async () => {
    const { a, report, call } = await seeded(["ok@example.test"]);
    const svc = harness.app().get(ScheduledReportsService);
    service().email = { delivers: true, send: async () => undefined };
    const res = await call("POST", `/scheduled-reports/${report.id}/send-now`);
    expect(res.statusCode, res.body).toBe(200);
    expect(scheduledReportDeliverySchema.parse((res.json() as { data: unknown }).data).status).toBe("sending");
    await svc.settled();
    expect(await deliveryRow(a.workspaceId)).toEqual({ status: "delivered", reason: null, recipient_count: 1 });
    const r = (await harness.db().query(`SELECT last_sent_at, last_error FROM scheduled_reports WHERE id = $1`, [report.id])).rows[0] as { last_sent_at: Date | null; last_error: string | null };
    expect(r.last_sent_at).not.toBeNull();
  }, 180_000);

  it("(a) a partial failure finishes `failed` (N of M, last_error) as the app role", async () => {
    const { a, report, call } = await seeded(["ok@example.test", "bad@example.test"]);
    service().email = { delivers: true, send: async (m: { to: string }) => { if (m.to.startsWith("bad")) throw new Error("provider down"); } };
    expect((await call("POST", `/scheduled-reports/${report.id}/send-now`)).statusCode).toBe(200);
    await harness.app().get(ScheduledReportsService).settled();
    expect(await deliveryRow(a.workspaceId)).toEqual({ status: "failed", reason: "1 of 2 recipients could not be sent", recipient_count: 1 });
    expect(((await harness.db().query(`SELECT last_error FROM scheduled_reports WHERE id = $1`, [report.id])).rows[0] as { last_error: string }).last_error).toBe("1 of 2 recipients could not be sent");
  }, 180_000);

  it("(b) a finalise carrying ANOTHER workspace's context updates nothing: RLS hides the row, which stays `sending`", async () => {
    const { a, report, call } = await seeded(["ok@example.test"]);
    const other = await owner();
    const svc = service();
    svc.email = { delivers: true, send: async () => undefined };
    const original = svc.startDelivery.bind(svc);
    svc.startDelivery = (context: unknown, ...rest: unknown[]) => original({ ...(context as object), workspaceId: other.workspaceId }, ...rest);
    expect((await call("POST", `/scheduled-reports/${report.id}/send-now`)).statusCode).toBe(200);
    await harness.app().get(ScheduledReportsService).settled();
    expect((await deliveryRow(a.workspaceId))?.status).toBe("sending");
    const r = (await harness.db().query(`SELECT last_sent_at FROM scheduled_reports WHERE id = $1`, [report.id])).rows[0] as { last_sent_at: Date | null };
    expect(r.last_sent_at).toBeNull();
  }, 180_000);
});
