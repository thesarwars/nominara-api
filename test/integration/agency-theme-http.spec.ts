import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { PLATFORM_DEFAULT_THEME_ID } from "../../src/modules/agency/agency.service.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-097 — GET/PUT /v1/agency/theme through the REAL ApiModule: RbacGuard,
// the tenant transaction (RLS), the audit interceptor, the problem filter.
// Scenario numbers are the story's Test scenarios table. Scenarios 9-15
// (assets, custom_css, email identity) are deferred to week 2.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

describe("STORY-097 · agency theme over HTTP", () => {
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

  /** An owner of a fresh workspace on `plan`. */
  async function owner(plan: "growth" | "business"): Promise<Actor & { userId: string }> {
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

  async function member(workspaceId: string, role: "manager" | "viewer"): Promise<Actor> {
    const userId = await newUser();
    await harness.db().query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,'active')`,
      [uuidV7(), workspaceId, userId, role],
    );
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, role, null, 2);
    return { workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const get = (a: Actor) => harness.app().inject({ method: "GET", url: apiUrl("/agency/theme"), headers: { cookie: a.cookie } });
  const put = (a: Actor, payload: unknown) =>
    harness.app().inject({
      method: "PUT",
      url: apiUrl("/agency/theme"),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
      payload: payload as object,
    });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;

  it("STORY-097 · GET with no stored theme returns the unsaved platform default with null colours and persists nothing", async () => {
    const a = await owner("growth");
    const res = await get(a);
    expect(res.statusCode, res.body).toBe(200);
    const themes = data<Array<Record<string, unknown>>>(res);
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      theme_id: PLATFORM_DEFAULT_THEME_ID,
      is_default: true,
      color_primary: null,
      color_accent: null,
      color_bg: null,
      color_fg: null,
      hide_nominara_brand: false,
    });
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM brand_themes WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-097 · saving the shown platform default creates the first theme as the default, and GET then lists exactly one default", async () => {
    const a = await owner("growth");
    const saved = await put(a, { theme_id: PLATFORM_DEFAULT_THEME_ID, name: "Acme", color_primary: "#0f5132" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(data<{ is_default: boolean; color_primary: string }>(saved)).toMatchObject({ is_default: true, color_primary: "#0f5132" });
    const second = await put(a, { name: "Dark client" });
    expect(second.statusCode, second.body).toBe(200);
    expect(data<{ is_default: boolean }>(second).is_default).toBe(false);

    const list = data<Array<{ is_default: boolean; name: string }>>(await get(a));
    expect(list).toHaveLength(2);
    expect(list.filter((t) => t.is_default)).toHaveLength(1);
    expect(list[0]!.name).toBe("Acme");
  });

  it("CP1 first-theme race · two concurrent first saves both succeed and leave exactly one default (no raw 23505, no 500)", async () => {
    const a = await owner("growth");
    // A trigger holds every INSERT open for 400 ms AFTER the service has decided "no default exists yet", so both
    // requests are guaranteed to be past that decision before either row lands. Without serialisation the second
    // insert dies on ux_brand_themes_default.
    await harness.db().query(`CREATE FUNCTION public.cp1_slow_theme_insert() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $f$`);
    await harness.db().query(`CREATE TRIGGER cp1_slow_theme_insert BEFORE INSERT ON brand_themes FOR EACH ROW EXECUTE FUNCTION public.cp1_slow_theme_insert()`);
    try {
      const results = await Promise.all([put(a, { name: "Alpha" }), put(a, { name: "Beta" })]);
      expect(results.map((r) => r.statusCode), results.map((r) => r.body).join(" | ")).toEqual([200, 200]);
    } finally {
      await harness.db().query(`DROP TRIGGER cp1_slow_theme_insert ON brand_themes`);
      await harness.db().query(`DROP FUNCTION public.cp1_slow_theme_insert()`);
    }
    const list = data<Array<{ is_default: boolean }>>(await get(a));
    expect(list).toHaveLength(2);
    expect(list.filter((t) => t.is_default)).toHaveLength(1);
  }, 60_000);

  it("STORY-097 · making another theme the default demotes the old one in the same write", async () => {
    const a = await owner("growth");
    await put(a, { name: "One" });
    const two = data<{ theme_id: string }>(await put(a, { name: "Two" }));
    const res = await put(a, { theme_id: two.theme_id, is_default: true });
    expect(res.statusCode, res.body).toBe(200);
    const list = data<Array<{ is_default: boolean; name: string }>>(await get(a));
    expect(list.filter((t) => t.is_default).map((t) => t.name)).toEqual(["Two"]);
  });

  it("STORY-097 · unsetting the only default directly is refused (validation_failed)", async () => {
    const a = await owner("growth");
    const one = data<{ theme_id: string }>(await put(a, { name: "One" }));
    const res = await put(a, { theme_id: one.theme_id, is_default: false });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("STORY-097 scenario 6 · a failing fg/bg pair is 400 validation_failed with the measured ratio and a passing suggestion", async () => {
    const a = await owner("growth");
    const res = await put(a, { color_bg: "#ffffff", color_fg: "#aaaaaa" });
    expect(res.statusCode, res.body).toBe(400);
    const error = (res.json() as { error: { code: string; details: Record<string, unknown> } }).error;
    expect(error.code).toBe("validation_failed");
    expect(error.details).toMatchObject({ token: "color_fg_on_bg", threshold: 4.5, issues: [{ path: ["color_fg"] }] });
    expect(error.details.measured_ratio).toBeLessThan(4.5);
    expect(error.details.suggestion).toMatch(/^#[0-9a-f]{6}$/);
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM brand_themes WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n, "a rejected theme stores nothing").toBe(0);
  });

  it("STORY-097 scenario 7 · a pair failing ONLY the 3:1 graph-stroke threshold is rejected", async () => {
    const a = await owner("growth");
    const res = await put(a, { color_bg: "#ffffff", color_primary: "#b0b0b0" });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: { details: { token: string; threshold: number } } }).error.details).toMatchObject({
      token: "color_primary_on_bg",
      threshold: 3,
    });
  });

  it("STORY-097 scenario 8 · the check is in the service: a direct PUT is rejected, and so is a failing change to an EXISTING passing theme", async () => {
    const a = await owner("growth");
    const ok = data<{ theme_id: string }>(await put(a, { color_bg: "#ffffff", color_fg: "#111111" }));
    // the body names only bg; the stored fg (#111111) now sits on a dark bg and must fail
    const res = await put(a, { theme_id: ok.theme_id, color_bg: "#222222" });
    expect(res.statusCode, res.body).toBe(400);
    const stored = await harness.db().query(`SELECT color_bg FROM brand_themes WHERE id = $1`, [ok.theme_id]);
    expect((stored.rows[0] as { color_bg: string }).color_bg).toBe("#ffffff");
  });

  it("STORY-097 · custom_css and *_key fields are rejected with validation_failed, not silently dropped", async () => {
    const a = await owner("growth");
    for (const payload of [{ custom_css: ".a{color:red}" }, { logo_light_key: "k" }, { workspace_id: uuidV7() }]) {
      const res = await put(a, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    }
  });

  it("STORY-097 scenario 14 · a font outside the curated self-hosted set is refused", async () => {
    const a = await owner("growth");
    const res = await put(a, { font_family: "Comic Sans MS" });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: { details: { issues: Array<{ path: string[] }> } } }).error.details.issues[0]!.path).toEqual(["font_family"]);
    expect((await put(a, { font_family: "Geist" })).statusCode).toBe(200);
  });

  it("STORY-100 AC10 · the Reply-To and display name round-trip, an absent field keeps them, null clears them, and the default shows both null", async () => {
    const a = await owner("growth");
    const first = data<Array<Record<string, unknown>>>(await get(a));
    expect(first[0]).toMatchObject({ email_from_name: null, email_reply_to: null });

    const saved = await put(a, { name: "Acme", email_from_name: "Acme Agency", email_reply_to: "team@acme.example" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(data(saved)).toMatchObject({ email_from_name: "Acme Agency", email_reply_to: "team@acme.example" });
    const themeId = data<{ theme_id: string }>(saved).theme_id;

    const kept = await put(a, { theme_id: themeId, color_primary: "#0f5132" });
    expect(data(kept)).toMatchObject({ email_from_name: "Acme Agency", email_reply_to: "team@acme.example" });

    const cleared = await put(a, { theme_id: themeId, email_reply_to: null });
    expect(data(cleared)).toMatchObject({ email_from_name: "Acme Agency", email_reply_to: null });
    const stored = await harness.db().query(`SELECT email_reply_to FROM brand_themes WHERE workspace_id = $1`, [a.workspaceId]);
    expect((stored.rows[0] as { email_reply_to: string | null }).email_reply_to).toBeNull();
  });

  it("STORY-100 AC10 · a Reply-To or display name that could break out of a mail header is 400 and stores nothing", async () => {
    const a = await owner("growth");
    for (const payload of [
      { email_reply_to: "a@acme.example\r\nBcc: x@evil.example" },
      { email_reply_to: "not an address" },
      { email_reply_to: "Name <a@acme.example>" },
      { email_from_name: "Acme\r\nBcc: x@evil.example" },
      { email_from_name: "Acme <evil@evil.example>" },
      { email_from_name: "" },
    ]) {
      const res = await put(a, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM brand_themes WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-097 scenario 4 · hide_nominara_brand without whitelabel.remove_branding is 403 feature_not_in_plan", async () => {
    const a = await owner("growth");
    const res = await put(a, { hide_nominara_brand: true });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { error: { code: string; details: Record<string, unknown> } }).error).toMatchObject({
      code: "feature_not_in_plan",
      details: { key: "whitelabel.remove_branding", min_plan: "business" },
    });
    const rows = await harness.db().query(`SELECT count(*)::int AS n FROM brand_themes WHERE workspace_id = $1`, [a.workspaceId]);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("STORY-097 scenario 5 (storage half) · with the entitlement, hide_nominara_brand is stored", async () => {
    const a = await owner("business");
    const res = await put(a, { hide_nominara_brand: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ hide_nominara_brand: boolean }>(res).hide_nominara_brand).toBe(true);
  });

  it("STORY-097 scenario 16 · every theme write produces an audit row naming the actor and the theme; a refused write produces none", async () => {
    const a = await owner("growth");
    const saved = data<{ theme_id: string }>(await put(a, { name: "Audited" }));
    await put(a, { color_bg: "#ffffff", color_fg: "#aaaaaa" });
    const rows = await harness.db().query(
      `SELECT action, resource_type, resource_id, actor_id FROM audit_log WHERE workspace_id = $1 AND action LIKE 'agency.theme%'`,
      [a.workspaceId],
    );
    expect(rows.rows).toEqual([
      { action: "agency.theme_updated", resource_type: "theme", resource_id: saved.theme_id, actor_id: (a as { userId?: string }).userId },
    ]);
  });

  it("STORY-097 · a manager or viewer is 403 forbidden naming agency:branding, on read and write alike", async () => {
    const a = await owner("growth");
    for (const role of ["manager", "viewer"] as const) {
      const m = await member(a.workspaceId, role);
      for (const res of [await get(m), await put(m, { name: "x" })]) {
        expect(res.statusCode, `${role}: ${res.body}`).toBe(403);
        expect(res.body).toContain("agency:branding");
      }
    }
  });

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

  it("NEW-E-7 checkpoint-6 · listAgencyThemes pages by keyset: default first, a created_at tie at the page boundary is neither skipped nor repeated, cursor_next null on the last", async () => {
    const a = await owner("growth");
    await harness.db().query(`INSERT INTO brand_themes (workspace_id, name, is_default, created_at) VALUES ($1,'D',true,'2026-10-01T10:00:00.000001Z')`, [a.workspaceId]);
    await harness.db().query(
      `INSERT INTO brand_themes (workspace_id, name, is_default, created_at) SELECT $1, 'T' || g, false, '2026-10-01T10:00:00.000001Z' FROM generate_series(1,4) g`,
      [a.workspaceId],
    );
    const expected = (
      await harness.db().query<{ id: string }>(`SELECT id FROM brand_themes WHERE workspace_id = $1 ORDER BY is_default DESC, created_at, id`, [a.workspaceId])
    ).rows.map((r) => r.id);
    const pages = await walk(a, "/agency/theme", (r) => r.theme_id as string);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(expected);
    expect(new Set(pages.flat()).size).toBe(5);
  });

  it("NEW-E-7 checkpoint-6 · listAgencyThemes: the unsaved platform default is still the single item of an empty first page, with the envelope", async () => {
    const a = await owner("growth");
    const res = await get(a);
    const body = res.json() as { data: unknown[]; pagination: { cursor_next: string | null; has_more: boolean } };
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toMatchObject({ cursor_next: null, has_more: false });
  });

  it("NEW-E-7 checkpoint-6 · listAgencyThemes: a malformed or foreign cursor and an offset are 400, not a silent first page", async () => {
    const a = await owner("growth");
    const foreign = Buffer.from(JSON.stringify({ v: 1, k: ["x"] })).toString("base64url");
    await rejectsBadCursors(a, "/agency/theme", foreign);
  });

});
