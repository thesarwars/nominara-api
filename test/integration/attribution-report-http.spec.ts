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
    await db().query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://shop.example.com','shop.example.com')", [id, workspaceId, `p-${id}`]);
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
  interface Fig { current: number; prior: number; delta: number; delta_pct: number | null }
  interface Totals {
    ai_sessions: Fig;
    conversions: Fig;
    conversion_rate: number | null;
    conversion_rate_prior: number | null;
    by_engine: Array<{ referrer_class: string; sessions: Fig; conversions: Fig }>;
    unattributed: { sessions: Fig; conversions: Fig };
  }
  interface Report { window_days: number; window_start: string | null; gsc_connected: boolean; substitution_candidates: number; measured_floor_note: string; rows: Row[]; totals: Totals | null }

  async function seed(a: Actor, path: string, over: Record<string, unknown> = {}, windowStart = "2026-10-15", windowDays = 30): Promise<void> {
    const landing = `https://shop.example.com${path}`;
    const r = { citations: 3, citations_prior: 3, ai_sessions: 50, ai_sessions_prior: 50, conversions: 5, cvr: 0.1, gsc_ai_impressions: null, organic_clicks: null, pattern: "dual_visibility", ...over };
    await db().query(
      `INSERT INTO attribution_url_rollup (workspace_id, project_id, window_start, window_days, landing_url_hash, landing_url, citations, citations_prior, ai_sessions, ai_sessions_prior, conversions, cvr, gsc_ai_impressions, organic_clicks, pattern)
       VALUES ($1,$2,$3,$4,sha256(convert_to($5::text,'UTF8')),$5::text,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [a.workspaceId, a.projectId, windowStart, windowDays, landing, r.citations, r.citations_prior, r.ai_sessions, r.ai_sessions_prior, r.conversions, r.cvr, r.gsc_ai_impressions, r.organic_clicks, r.pattern],
    );
  }


  async function daily(a: Actor, date: string, referrerClass: string, sessions: number, conversions = 0, path = "/p", project = a.projectId): Promise<void> {
    const landing = `https://shop.example.com${path}`;
    await db().query(
      `INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, sessions, conversions, country, device)
       VALUES ($1,$2,$3,sha256(convert_to($4::text,'UTF8')),$4::text,$5,$6,$7,'ZZ','desktop')`,
      [a.workspaceId, project, date, landing, referrerClass, sessions, conversions],
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
  // STORY-116 F1 / F2 - window 2026-10-15 for 30 days: current 10-15..11-13, prior 09-15..10-14.
  it("STORY-116 F1 - totals, deltas, conversion rate and the per-engine breakdown are the measured counts of the window and its prior", async () => {
    const a = await owner();
    await seed(a, "/p");
    await daily(a, "2026-10-20", "chatgpt", 60, 6);
    await daily(a, "2026-10-21", "chatgpt", 40, 4, "/q");
    await daily(a, "2026-11-13", "perplexity", 20, 0);
    await daily(a, "2026-09-15", "chatgpt", 50, 5);
    await daily(a, "2026-10-14", "other_ai", 50, 0);
    const totals = data<Report>(await get(a)).totals!;
    expect(totals.ai_sessions).toEqual({ current: 120, prior: 100, delta: 20, delta_pct: 0.2 });
    expect(totals.conversions).toEqual({ current: 10, prior: 5, delta: 5, delta_pct: 1 });
    expect(totals.conversion_rate).toBeCloseTo(10 / 120, 6);
    expect(totals.conversion_rate_prior).toBeCloseTo(5 / 100, 6);
    expect(totals.by_engine.map((e) => e.referrer_class)).toEqual(["chatgpt", "perplexity", "gemini", "claude", "copilot", "meta_ai", "other_ai"]);
    const by = new Map(totals.by_engine.map((e) => [e.referrer_class, e]));
    expect(by.get("chatgpt")).toMatchObject({ sessions: { current: 100, prior: 50 }, conversions: { current: 10, prior: 5 } });
    expect(by.get("perplexity")!.sessions).toEqual({ current: 20, prior: 0, delta: 20, delta_pct: null });
    expect(by.get("other_ai")!.sessions).toEqual({ current: 0, prior: 50, delta: -50, delta_pct: -1 });
    expect(by.get("gemini")!.sessions).toEqual({ current: 0, prior: 0, delta: 0, delta_pct: null });
  }, 120_000);

  it("STORY-116 F2 - the unattributed class is displayed beside the AI figures and never added into them", async () => {
    const a = await owner();
    await seed(a, "/p");
    await daily(a, "2026-10-20", "chatgpt", 30, 3);
    await daily(a, "2026-10-20", "unattributed_direct", 500, 25);
    await daily(a, "2026-10-01", "unattributed_direct", 400, 10);
    const totals = data<Report>(await get(a)).totals!;
    expect(totals.ai_sessions.current).toBe(30);
    expect(totals.conversions.current).toBe(3);
    expect(totals.unattributed.sessions).toEqual({ current: 500, prior: 400, delta: 100, delta_pct: 0.25 });
    expect(totals.unattributed.conversions).toEqual({ current: 25, prior: 10, delta: 15, delta_pct: 1.5 });
    expect(totals.by_engine.map((e) => e.referrer_class)).not.toContain("unattributed_direct");
    expect(data<Report>(await get(a)).measured_floor_note).toBe(MEASURED_FLOOR_COPY);
  }, 120_000);

  it("STORY-116 F1 - null stays null: no computed window means no totals, zero sessions means no rate, a zero prior means no percentage", async () => {
    const a = await owner();
    await daily(a, "2026-10-20", "chatgpt", 10, 1);
    expect(data<Report>(await get(a)).totals).toBeNull();
    await seed(a, "/p");
    const none = await owner();
    await seed(none, "/p");
    const empty = data<Report>(await get(none)).totals!;
    expect(empty.ai_sessions).toEqual({ current: 0, prior: 0, delta: 0, delta_pct: null });
    expect(empty.conversion_rate).toBeNull();
    expect(empty.conversion_rate_prior).toBeNull();
    expect(empty.unattributed.sessions).toEqual({ current: 0, prior: 0, delta: 0, delta_pct: null });
    const sessionsButNoConversions = await owner();
    await seed(sessionsButNoConversions, "/p");
    await daily(sessionsButNoConversions, "2026-10-20", "claude", 8, 0);
    expect(data<Report>(await get(sessionsButNoConversions)).totals!.conversion_rate).toBe(0);
  }, 120_000);

  it("STORY-116 F1 - totals cover the project's whole window, not the pattern filter, and never another project, workspace or window", async () => {
    const a = await owner();
    await seed(a, "/p", { pattern: "ai_only" });
    await daily(a, "2026-10-20", "chatgpt", 10);
    await daily(a, "2026-11-14", "chatgpt", 999);
    await daily(a, "2026-09-14", "chatgpt", 999);
    const other = await owner();
    await seed(other, "/p");
    await daily(other, "2026-10-20", "chatgpt", 777);
    const sibling = await project(a.workspaceId);
    await daily(a, "2026-10-20", "chatgpt", 555, 0, "/p", sibling);
    expect(data<Report>(await get(a, "?pattern=invisible_both")).totals!.ai_sessions).toEqual({ current: 10, prior: 0, delta: 10, delta_pct: null });
    expect(data<Report>(await get(a, "?timeframe=7d")).totals).toBeNull();
  }, 120_000);
});
