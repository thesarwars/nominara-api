import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// AUXLIVE-3 (STORY-194) - POST /projects/{id}/aux-audits through the REAL HTTP pipeline: the permission guard, the idempotency interceptor, the
// rate-limit class and the contract validation are all in the composition root, so a service-level test cannot see them. The queue and the cache are
// the spec's own containers (never the developer's Valkey).

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("AUXLIVE-3 · POST /projects/{id}/aux-audits over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  // As the runtime role (RLS live): the cross-workspace scenario would pass for the wrong reason through the superuser.
  const harness = useApiHarness({
    runAsAppRole: true,
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
    vi.restoreAllMocks();
    await pool.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly userId: string;
    readonly cookie: string;
    readonly csrf: string;
  }

  async function owner(plan: "free" | "starter" | "growth" | "business"): Promise<Actor> {
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    const tokens = await sessions.createSession(userId);
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
        applyPlanChange(tx, workspaceId, planKeyOnly(plan as "starter"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    // The entitlement version the workspace is at NOW: a plan change bumps it, and a session claiming a stale one is refused (401 entitlement_stale).
    const version = Number((await harness.db().query("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0].entitlement_version);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const headers = (a: Actor, key: string | null = randomUUID(), confirmed: string | null = "10"): Record<string, string> => ({
    cookie: a.cookie,
    [CSRF_HEADER_NAME]: a.csrf,
    "content-type": "application/json",
    ...(key === null ? {} : { "idempotency-key": key }),
    // Owner decision 39: the figure the operator was shown. Every priced POST carries it; a test of the header itself passes null or another figure.
    ...(confirmed === null ? {} : { "x-nominara-confirmed-credits": confirmed }),
  });
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;
  async function project(a: Actor): Promise<string> {
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence) VALUES ($1,$2,'P',$3,'https://e.test','e.test','active','weekly')`,
      [id, a.workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    return id;
  }
  async function fund(a: Actor, credits = 100): Promise<void> {
    await harness.db().query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
       VALUES ($1,$2,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)
       ON CONFLICT (workspace_id) DO UPDATE SET included_balance = $2`,
      [a.workspaceId, credits],
    );
  }
  const post = (a: Actor, projectId: string, payload: unknown = {}, key: string | null = randomUUID(), confirmed: string | null = "10") =>
    harness.app().inject({ method: "POST", url: apiUrl(`/projects/${projectId}/aux-audits`), headers: headers(a, key, confirmed), payload: payload as object });
  const preview = (a: Actor, projectId: string, payload: unknown = {}) =>
    harness.app().inject({ method: "POST", url: apiUrl(`/projects/${projectId}/aux-audits/preview`), headers: headers(a, null, null), payload: payload as object });
  const debits = async (a: Actor): Promise<number> =>
    (await harness.db().query("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [a.workspaceId])).rows[0].n;
  const auditRows = async (a: Actor): Promise<number> =>
    (await harness.db().query("SELECT count(*)::int AS n FROM aux_audits WHERE workspace_id = $1", [a.workspaceId])).rows[0].n;

  it("AUXLIVE-3 H1 · 202 with the audit id, the price and its breakdown; the wallet, the ledger, the audit row and the queued job all agree", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const enqueue = vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob");

    const res = await post(a, projectId);
    expect(res.statusCode, res.body).toBe(202);
    const body = (res.json() as { data: { audit_id: string; credits_charged: number; pricing: unknown; status: string; trigger: string } }).data;
    expect(body).toMatchObject({ status: "queued", trigger: "manual", credits_charged: 10, pricing: { pages_priced: 25, base_credits: 10, base_page_band: 25, extra_page_credits: 1 } });

    expect((await harness.db().query("SELECT included_balance::int AS b FROM credit_wallets WHERE workspace_id = $1", [a.workspaceId])).rows[0].b).toBe(90);
    const ledger = (await harness.db().query("SELECT reference_type, reference_id, action_code FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [a.workspaceId])).rows;
    expect(ledger).toEqual([{ reference_type: "aux_audit", reference_id: body.audit_id, action_code: "aux_manual" }]);
    const row = (await harness.db().query("SELECT trigger, status, triggered_by FROM aux_audits WHERE id = $1", [body.audit_id])).rows[0];
    expect(row).toEqual({ trigger: "manual", status: "queued", triggered_by: a.userId });
    const crawl = enqueue.mock.calls.filter((c) => c[0] === "crawl.audit");
    expect(crawl).toHaveLength(1);
    expect(crawl[0]![2]).toMatchObject({ projectId, auditId: body.audit_id, trigger: "manual", scope: "key_pages" });
    expect(crawl[0]![3]).toEqual({ idempotencyKey: `aux:${projectId}:${body.audit_id}` });

    // and the audit is readable at once, as queued with no score (null, not 0)
    const read = await harness.app().inject({ method: "GET", url: apiUrl(`/aux-audits/${body.audit_id}`), headers: headers(a, null) });
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as { data: Record<string, unknown> }).data).toMatchObject({ audit_id: body.audit_id, status: "queued", trigger: "manual", aux_score: null });
  }, 90_000);

  it("AUXLIVE-3 H2 · no Idempotency-Key is refused (400) before anything is charged or written", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const res = await post(a, projectId, {}, null);
    expect(res.statusCode, res.body).toBe(400);
    expect(await debits(a)).toBe(0);
    expect(await auditRows(a)).toBe(0);
  }, 90_000);

  it("AUXLIVE-3 H3 · the same key and body replays the first answer and charges once; the same key with a different body is 409 idempotency_conflict", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const key = randomUUID();
    const first = await post(a, projectId, {}, key);
    const second = await post(a, projectId, {}, key);
    expect(first.statusCode, first.body).toBe(202);
    expect(second.statusCode, second.body).toBe(202);
    expect((second.json() as { data: { audit_id: string } }).data.audit_id).toBe((first.json() as { data: { audit_id: string } }).data.audit_id);
    expect(await debits(a)).toBe(1);
    expect(await auditRows(a)).toBe(1);

    const different = await post(a, projectId, { scope: "sitemap_sample" }, key);
    expect(different.statusCode, different.body).toBe(409);
    expect(errorOf(different).code).toBe("idempotency_conflict");
    expect(await debits(a)).toBe(1);
  }, 90_000);

  it("AUXLIVE-3 H4 · rate limited as api-specification.md section 12 states: burst 3, the fourth in a row is 429 rate_limited and charges nothing", async () => {
    const a = await owner("starter");
    await fund(a, 1000);
    const projectId = await project(a);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post(a, projectId)).statusCode);
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect(await debits(a)).toBe(3);
    expect(await auditRows(a)).toBe(3);
  }, 90_000);

  it("AUXLIVE-3 H5 · 402 insufficient_credits when the wallet cannot cover 10: nothing charged, no audit, no job", async () => {
    const a = await owner("starter");
    await fund(a, 9);
    const projectId = await project(a);
    const enqueue = vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob");
    const res = await post(a, projectId);
    expect(res.statusCode, res.body).toBe(402);
    expect(errorOf(res).code).toBe("insufficient_credits");
    expect(await debits(a)).toBe(0);
    expect(await auditRows(a)).toBe(0);
    expect(enqueue.mock.calls.filter((c) => c[0] === "crawl.audit")).toHaveLength(0);
  }, 90_000);

  it("AUXLIVE-3 H6 · a plan with no AUX audits is 403 feature_not_in_plan", async () => {
    const a = await owner("free");
    await fund(a, 60);
    const projectId = await project(a);
    const res = await post(a, projectId);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).code).toBe("feature_not_in_plan");
    expect(await debits(a)).toBe(0);
  }, 90_000);

  it("AUXLIVE-3 H7 · the body is strict: an unknown key, a scope only verification may grant, or a single_url with no URL is 400 and charges nothing", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    // Three, not five: the rate limiter (burst 3) answers before validation does, so a fourth request would be a 429 for the wrong reason. The other
    // refusals (domain_root, a non-http URL, more than 50 URLs) are in contracts/aux/trigger-aux-audit.schema.spec.ts.
    for (const payload of [{ credits: 0 }, { scope: "public_surface" }, { scope: "single_url" }]) {
      const res = await post(a, projectId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await debits(a)).toBe(0);
    expect(await auditRows(a)).toBe(0);
  }, 90_000);

  it("AUXLIVE-3 H8 · a project in another workspace is refused and charges nothing", async () => {
    const a = await owner("starter");
    const b = await owner("starter");
    await fund(a);
    const theirs = await project(b);
    const res = await post(a, theirs);
    expect([403, 404], res.body).toContain(res.statusCode);
    expect(await debits(a)).toBe(0);
  }, 90_000);

  it("AUXLIVE-3 H9 · no X-Nominara-Confirmed-Credits is 400 validation_failed naming the header; nothing is charged, written or queued", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const enqueue = vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob");
    const res = await post(a, projectId, {}, randomUUID(), null);
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("validation_failed");
    expect(res.body).toContain("x-nominara-confirmed-credits");
    expect(await debits(a)).toBe(0);
    expect(await auditRows(a)).toBe(0);
    expect(enqueue.mock.calls.filter((c) => c[0] === "crawl.audit")).toHaveLength(0);
  }, 90_000);

  it("AUXLIVE-3 H10 · a figure that does not match the price is 409 price_changed with shown and recomputed; the same request with the matching figure is 202", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const wrong = await post(a, projectId, {}, randomUUID(), "35");
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(errorOf(wrong).code).toBe("price_changed");
    expect(errorOf(wrong).details).toMatchObject({ shown: 35, recomputed: 10 });
    expect(await debits(a)).toBe(0);
    expect(await auditRows(a)).toBe(0);
    const right = await post(a, projectId, {}, randomUUID(), "10");
    expect(right.statusCode, right.body).toBe(202);
    expect(await debits(a)).toBe(1);
  }, 90_000);

  it("AUXLIVE-3 H11 · POST .../aux-audits/preview quotes the credits and the pricing breakdown, needs no Idempotency-Key or confirmation, and changes nothing", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const enqueue = vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob");
    const res = await preview(a, projectId);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { data: unknown }).data).toEqual({ credits: 10, requested_scope: "key_pages", pricing: { pages_priced: 25, base_credits: 10, base_page_band: 25, extra_page_credits: 1 }, credits_charged: 0 });
    expect(await debits(a)).toBe(0);
    expect(await auditRows(a)).toBe(0);
    expect((await harness.db().query("SELECT included_balance::int AS b FROM credit_wallets WHERE workspace_id = $1", [a.workspaceId])).rows[0].b).toBe(100);
    expect(enqueue.mock.calls.filter((c) => c[0] === "crawl.audit")).toHaveLength(0);
  }, 90_000);

  it("AUXLIVE-3 H12 · the preview is the figure the POST accepts, and it needs aux:trigger: a plan with no AUX audits is 403 for both", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const quoted = ((await preview(a, projectId)).json() as { data: { credits: number } }).data.credits;
    expect((await post(a, projectId, {}, randomUUID(), String(quoted))).statusCode).toBe(202);
    const f = await owner("free");
    const freeProject = await project(f);
    const res = await preview(f, freeProject);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).code).toBe("feature_not_in_plan");
  }, 90_000);

  it("AUXLIVE-3 H13 · a replay after the cache LOST the idempotency record (eviction under memory pressure) still charges once and queues one audit: the database refuses it", async () => {
    const a = await owner("starter");
    await fund(a);
    const projectId = await project(a);
    const key = randomUUID();
    const first = await post(a, projectId, {}, key);
    expect(first.statusCode, first.body).toBe(202);
    const cache = new Redis(cacheValkey.url);
    try {
      await cache.flushall();
    } finally {
      cache.disconnect();
    }
    const second = await post(a, projectId, {}, key);
    expect(second.statusCode, second.body).toBe(202);
    expect((second.json() as { data: { audit_id: string } }).data.audit_id).toBe((first.json() as { data: { audit_id: string } }).data.audit_id);
    expect(await debits(a)).toBe(1);
    expect(await auditRows(a)).toBe(1);
    expect((await harness.db().query("SELECT included_balance::int AS b FROM credit_wallets WHERE workspace_id = $1", [a.workspaceId])).rows[0].b).toBe(90);
  }, 90_000);
});
