import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { MEASURED_FLOOR_COPY, SUBSTITUTION_CO_MOVEMENT_COPY } from "../../contracts/attribution/index.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-114 - the attribution report read, through the REAL ApiModule on a real
// Postgres with the application running as nominara_app (NOBYPASSRLS), so a missing tenant context fails here rather than in
// production. Scenario numbers are the story's Test scenarios table.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-114 - GET /projects/{id}/attribution", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
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
    readonly projectId: string;
    readonly cookie: string;
    readonly csrf: string;
  }
  const db = (): Client => harness.db();

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    return userId;
  }

  async function project(workspaceId: string): Promise<string> {
    const id = uuidV7();
    await db().query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://shop.example.com','shop.example.com')", [id, workspaceId, `p-${id.slice(0, 8)}`]);
    return id;
  }

  async function owner(opts: { stepUp?: boolean } = {}): Promise<Actor> {
    const userId = await newUser();
    const tokens = await sessions.createSession(userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    // A plan change bumps the entitlement version the session is minted against (as every workspace-owning spec does).
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    if (opts.stepUp !== false) await sessions.recordStrongAuth(tokens.sid, "webauthn");
    return { workspaceId, projectId: await project(workspaceId), cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function viewer(workspaceId: string): Promise<Actor> {
    const userId = await newUser();
    await db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')`, [uuidV7(), workspaceId, userId]);
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "viewer", null, 2);
    return { workspaceId, projectId: "", cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const url = (a: Actor, query = ""): string => apiUrl(`/projects/${a.projectId}/attribution${query}`);
  const get = (a: Actor, query = "") => harness.app().inject({ method: "GET", url: url(a, query), headers: { cookie: a.cookie } });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  interface Row { url: string; pattern: string; flagged: boolean; note: string | null; conversion_rate: number | null; gsc_ai_impressions: number | null; organic_clicks: number | null; ai_sessions: number }
  interface Report { window_days: number; window_start: string | null; gsc_connected: boolean; substitution_candidates: number; measured_floor_note: string; rows: Row[] }

  async function seed(a: Actor, path: string, over: Record<string, unknown> = {}, windowStart = "2026-10-15", windowDays = 30): Promise<void> {
    const landing = `https://shop.example.com${path}`;
    const r = { citations: 3, citations_prior: 3, ai_sessions: 50, ai_sessions_prior: 50, conversions: 5, cvr: 0.1, gsc_ai_impressions: null, organic_clicks: null, pattern: "dual_visibility", ...over };
    await db().query(
      `INSERT INTO attribution_url_rollup (workspace_id, project_id, window_start, window_days, landing_url_hash, landing_url, citations, citations_prior, ai_sessions, ai_sessions_prior, conversions, cvr, gsc_ai_impressions, organic_clicks, pattern)
       VALUES ($1,$2,$3,$4,sha256(convert_to($5::text,'UTF8')),$5::text,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [a.workspaceId, a.projectId, windowStart, windowDays, landing, r.citations, r.citations_prior, r.ai_sessions, r.ai_sessions_prior, r.conversions, r.cvr, r.gsc_ai_impressions, r.organic_clicks, r.pattern],
    );
  }

  it("STORY-114 - with nothing computed yet the section answers an empty report, not an error", async () => {
    const a = await owner();
    const res = await get(a);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<Report>(res)).toMatchObject({ window_days: 30, window_start: null, gsc_connected: false, substitution_candidates: 0, rows: [], measured_floor_note: MEASURED_FLOOR_COPY });
  }, 120_000);

  it("STORY-114 S12 / S13 - substitution candidates lead the list, flagged, carrying the shared co-movement copy; other rows carry no note", async () => {
    const a = await owner();
    await seed(a, "/busy", { ai_sessions: 900 });
    await seed(a, "/falling", { pattern: "ai_substitution_candidate", ai_sessions: 60, ai_sessions_prior: 100, citations: 9, citations_prior: 5 });
    const rows = data<Report>(await get(a)).rows;
    expect(rows.map((r) => r.url)).toEqual(["https://shop.example.com/falling", "https://shop.example.com/busy"]);
    expect(rows[0]).toMatchObject({ flagged: true, note: SUBSTITUTION_CO_MOVEMENT_COPY });
    expect(rows[1]).toMatchObject({ flagged: false, note: null });
    expect(data<Report>(await get(a)).substitution_candidates).toBe(1);
  }, 120_000);

  it("STORY-114 S6 / S16 - a null conversion rate and null Search Console columns stay null on the wire, never zero", async () => {
    const a = await owner();
    await seed(a, "/nosessions", { ai_sessions: 0, ai_sessions_prior: 0, conversions: 0, cvr: null, pattern: "insufficient_data" });
    await seed(a, "/zero", { ai_sessions: 40, conversions: 0, cvr: 0, gsc_ai_impressions: 0, organic_clicks: 0, pattern: "ai_only" });
    const byUrl = new Map(data<Report>(await get(a)).rows.map((r) => [r.url, r]));
    expect(byUrl.get("https://shop.example.com/nosessions")).toMatchObject({ conversion_rate: null, gsc_ai_impressions: null, organic_clicks: null });
    expect(byUrl.get("https://shop.example.com/zero")).toMatchObject({ conversion_rate: 0, gsc_ai_impressions: 0, organic_clicks: 0 });
  }, 120_000);

  it("STORY-114 - reads the newest window of the requested length, filters by pattern, and never mixes projects or lengths", async () => {
    const a = await owner();
    await seed(a, "/old", {}, "2026-09-01", 30);
    await seed(a, "/new", {}, "2026-10-15", 30);
    await seed(a, "/week", {}, "2026-10-20", 7);
    await seed(a, "/gap", { pattern: "invisible_both", ai_sessions: 0, citations: 0, cvr: null, conversions: 0 }, "2026-10-15", 30);
    const month = data<Report>(await get(a, "?timeframe=30d"));
    expect(month.window_start).toBe("2026-10-15");
    expect(month.rows.map((r) => r.url).sort()).toEqual(["https://shop.example.com/gap", "https://shop.example.com/new"]);
    expect(data<Report>(await get(a, "?timeframe=7d")).rows.map((r) => r.url)).toEqual(["https://shop.example.com/week"]);
    expect(data<Report>(await get(a, "?timeframe=30d&pattern=invisible_both")).rows.map((r) => r.url)).toEqual(["https://shop.example.com/gap"]);
    const other = await owner();
    expect(data<Report>(await get(other)).rows).toEqual([]);
  }, 120_000);

  it("STORY-114 - a strict query: an unknown key, a bad timeframe and a bad pattern are each a 400", async () => {
    const a = await owner();
    for (const q of ["?bogus=1", "?timeframe=14d", "?pattern=causes_decline"]) expect((await get(a, q)).statusCode, q).toBe(400);
  }, 120_000);

  it("STORY-114 - tracking:read is what reads it (a viewer holds it), and a missing session is a 401", async () => {
    const a = await owner();
    const v = await viewer(a.workspaceId);
    expect((await get({ ...v, projectId: a.projectId })).statusCode).toBe(200);
    expect((await harness.app().inject({ method: "GET", url: url(a) })).statusCode).toBe(401);
  }, 120_000);

  it("STORY-114 - a project that is not this workspace's is a 404", async () => {
    const a = await owner();
    const b = await owner();
    expect((await get({ ...a, projectId: b.projectId })).statusCode).toBe(404);
  }, 120_000);
});
