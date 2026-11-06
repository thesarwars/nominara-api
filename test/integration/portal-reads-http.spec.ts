import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PortalCookiePayload } from "../../contracts/portal/index.js";
import { portalGrowthMapResponseSchema, portalMatrixResponseSchema, portalOverviewResponseSchema } from "../../contracts/portal/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { findCostFields } from "../../src/lib/portal/portal-view.js";
import { loadPortalCookieKey, PORTAL_COOKIE_NAME, sealPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-E-099a — GET /v1/portal/{overview,growth-map,matrix} through the REAL ApiModule chain, on the REAL
// nominara_portal pool (so scope is enforced by the database as well as the service). STORY-098 s10-14 and s22,
// STORY-099 s3, s4, s8, s10, s15, s16.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const KEY = loadPortalCookieKey(COOKIE_KEY_B64);

describe("NEW-E-099a · portal read endpoints", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    env: () => {
      const u = new URL(process.env.DATABASE_URL!);
      u.username = "nominara_portal";
      u.password = resolvePassword("nominara_portal", {});
      return { VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString, PORTAL_COOKIE_KEY: COOKIE_KEY_B64, DATABASE_URL_PORTAL: u.toString() };
    },
  });

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(async () => {
    await harness.db().query(`ALTER ROLE nominara_portal PASSWORD '${resolvePassword("nominara_portal", {})}'`);
  });

  const RIVAL = "Globex Rival Industries";
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error;
  const dayAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  interface World { ws: string; p1: string; p2: string; rival: string; user: string; theme: string }

  async function world(): Promise<World> {
    const db = harness.db();
    const [ws, p1, p2, rival, user, theme] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Agency One',$2,'growth','UTC')", [ws, `w-${ws.slice(0, 8)}`]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    for (const [id, name] of [[p1, "Client One"], [p2, "Client Two"]] as const) {
      await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,$3,$4,'https://a.test','a.test')", [id, ws, name, `p-${id.slice(0, 8)}`]);
    }
    await db.query("INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source) VALUES ($1,$2,$3,$4,'globex.test',ARRAY[]::text[],'user')", [rival, ws, p1, RIVAL]);
    await db.query("INSERT INTO brand_themes (id, workspace_id, name, is_default, hide_nominara_brand) VALUES ($1,$2,'Agency',true,true)", [theme, ws]);
    for (const d of [1, 2, 3]) {
      for (const [type, id, score] of [["brand", p1, 40 + d], ["competitor", rival, 30 + d]] as const) {
        await db.query(
          `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, cells_total, visibility_score, sov, scoring_version)
           VALUES ($1,$2,'all',$3,$4,$5::date,12,$6,0.2,'v1')`,
          [ws, p1, type, id, dayAgo(d), score],
        );
      }
    }
    await db.query("INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, visible_in_portal) VALUES ($1,$2,now() - interval '1 day','annotation','Shown milestone',true)", [ws, p1]);
    await db.query("INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, visible_in_portal) VALUES ($1,$2,now() - interval '1 day','engine_model_change','Hidden engine model change',false)", [ws, p1]);
    await db.query("INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, visible_in_portal) VALUES ($1,$2,now() - interval '1 day','competitor_added',$3,true)", [ws, p1, `Added competitor ${RIVAL}`]);
    return { ws, p1, p2, rival, user, theme };
  }

  interface TokenOpts { scope: string[]; tabs?: string[]; hideCompetitors?: boolean; hideCosts?: boolean; lock?: string | null; themeId?: string | null; label?: string }

  async function token(w: World, o: TokenOpts): Promise<{ id: string; cookie: string }> {
    const id = randomUUID();
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, scope_tabs, hide_competitors, hide_costs, timeframe_lock, theme_id, created_by)
       VALUES ($1,$2,$3,$4,'abcdefgh',false,$5::uuid[],$6::text[],$7,$8,$9,$10,$11)`,
      [id, w.ws, o.label ?? "Client link", randomBytes(32), o.scope, o.tabs ?? ["overview", "growth_map", "matrix"], o.hideCompetitors ?? false, o.hideCosts ?? false, o.lock ?? null, o.themeId ?? null, w.user],
    );
    const payload: PortalCookiePayload = { token_id: id, workspace_id: w.ws, scope_project_ids: o.scope, scope_tabs: (o.tabs ?? ["overview", "growth_map", "matrix"]) as PortalCookiePayload["scope_tabs"], theme_id: o.themeId ?? null };
    const { value } = await sealPortalCookie(payload, KEY);
    return { id, cookie: `${PORTAL_COOKIE_NAME}=${value}` };
  }

  const get = (cookie: string | null, path: string, headers: Record<string, string> = {}) =>
    harness.app().inject({ method: "GET", url: apiUrl(path), headers: { ...(cookie === null ? {} : { cookie }), ...headers } });

  it("STORY-099 s8 · overview lists only the token's scoped projects, applies the pinned theme with its settings, and conforms to the contract", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1], themeId: w.theme, label: "Q3 client report" });
    const res = await get(t.cookie, "/portal/overview");
    expect(res.statusCode, res.body).toBe(200);
    const body = portalOverviewResponseSchema.parse((res.json() as { data: unknown }).data);
    expect(body.projects.map((p) => p.id)).toEqual([w.p1]);
    expect(body.projects[0]!.name).toBe("Client One");
    expect(body.agency).toBe("Agency One");
    expect(body.label).toBe("Q3 client report");
    expect(body.theme.theme_id).toBe(w.theme);
    expect(body.hide_competitors).toBe(false);
    expect(body.timeframe).toBe("30d");
    expect(body.timeframe_locked).toBe(false);
    expect(res.body).not.toContain(w.p2);
  });

  it("STORY-100 AC10 · the agency's Reply-To and display name are never part of what a portal viewer is sent", async () => {
    const w = await world();
    await harness.db().query("UPDATE brand_themes SET email_from_name = 'Secret Agency Name', email_reply_to = 'private-inbox@agency.example' WHERE id = $1", [w.theme]);
    const t = await token(w, { scope: [w.p1], themeId: w.theme });
    const res = await get(t.cookie, "/portal/overview");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("private-inbox@agency.example");
    expect(res.body).not.toContain("Secret Agency Name");
    expect(res.body).not.toContain("email_reply_to");
  });

  it("STORY-097 · the pinned theme's stored style override reaches the portal; the email footer never does", async () => {
    const w = await world();
    await harness.db().query("UPDATE brand_themes SET custom_css = '.nm-card{color:var(--nm-color-fg)}', email_footer_html = '<p>Footer only for mail</p>' WHERE id = $1", [w.theme]);
    const t = await token(w, { scope: [w.p1], themeId: w.theme });
    const res = await get(t.cookie, "/portal/overview");
    expect(res.statusCode, res.body).toBe(200);
    expect(portalOverviewResponseSchema.parse((res.json() as { data: unknown }).data).theme.custom_css).toBe(".nm-card{color:var(--nm-color-fg)}");
    expect(res.body).not.toContain("Footer only for mail");
    expect(res.body).not.toContain("email_footer_html");
  });

  it("STORY-097 · a stored override that bypassed the save path (raw SQL) is re-sanitised before it reaches the portal", async () => {
    const w = await world();
    // A fresh token per read: the overview is cached per token, and this test is about what the read does, not the cache.
    const served = async (): Promise<string | null> => {
      const t = await token(w, { scope: [w.p1], themeId: w.theme });
      const res = await get(t.cookie, "/portal/overview");
      expect(res.statusCode, res.body).toBe(200);
      return portalOverviewResponseSchema.parse((res.json() as { data: unknown }).data).theme.custom_css;
    };
    await harness.db().query("UPDATE brand_themes SET custom_css = '.nm-card{color:url(x)} body{}' WHERE id = $1", [w.theme]);
    expect(await served()).toBeNull();
    await harness.db().query("UPDATE brand_themes SET custom_css = '.nm-card{color:#ffffff;background-color:#ffffff;margin:4px}' WHERE id = $1", [w.theme]);
    expect(await served()).toBe(".nm-card{margin:4px}");
  });

  it("STORY-097 scenario 5 (content scan) · with hide_nominara_brand on, the portal overview carries no platform name, asset or link", async () => {
    const w = await world();
    await harness.db().query("UPDATE brand_themes SET hide_nominara_brand = true WHERE id = $1", [w.theme]);
    const t = await token(w, { scope: [w.p1], themeId: w.theme });
    const res = await get(t.cookie, "/portal/overview");
    expect(res.statusCode, res.body).toBe(200);
    const data = (res.json() as { data: unknown }).data;
    expect(portalOverviewResponseSchema.parse(data).theme.hide_nominara_brand).toBe(true);
    // The contract's own key `hide_nominara_brand` is machine vocabulary, not content a viewer sees; every VALUE is scanned.
    expect(JSON.stringify(data).replaceAll('"hide_nominara_brand"', '"flag"')).not.toMatch(/nominara/i);
  });

  it("STORY-099 s8 · a workspace with no stored theme gets the platform default (null colours), not an error", async () => {
    const w = await world();
    await harness.db().query("DELETE FROM brand_themes WHERE workspace_id = $1", [w.ws]);
    const t = await token(w, { scope: [w.p1] });
    const res = await get(t.cookie, "/portal/overview");
    expect(res.statusCode, res.body).toBe(200);
    const body = portalOverviewResponseSchema.parse((res.json() as { data: unknown }).data);
    expect(body.theme.color_primary).toBeNull();
    expect(body.theme.hide_nominara_brand).toBe(false);
  });

  it("STORY-099 s10 · the methodology footer is on every overview project, and a theme that hides the platform brand cannot remove it", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1], themeId: w.theme });
    const body = portalOverviewResponseSchema.parse(((await get(t.cookie, "/portal/overview")).json() as { data: unknown }).data);
    const footer = body.projects[0]!.footer;
    expect(footer.note.length).toBeGreaterThan(0);
    expect(footer.data_through).not.toBeNull();
    expect(footer.scoring_version).toBe("v1");
    expect(footer.timeframe).toBe("30d");
  });

  it("STORY-098 s10 · an out-of-scope project, and a tab outside scope_tabs, are 403 project_out_of_scope on every endpoint", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1], tabs: ["overview", "growth_map"] });
    for (const path of [`/portal/growth-map?project=${w.p2}`, `/portal/matrix?project=${w.p1}`, `/portal/matrix?project=${w.p2}`]) {
      const res = await get(t.cookie, path);
      expect(res.statusCode, path).toBe(403);
      expect(errorOf(res).code, path).toBe("project_out_of_scope");
    }
    const noOverview = await token(w, { scope: [w.p1], tabs: ["matrix"] });
    expect((await get(noOverview.cookie, "/portal/overview")).statusCode).toBe(403);
  });

  it("STORY-098 s11 · hide_competitors: series are Competitor A/B/C, no real name or id anywhere, competitor milestones dropped", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1], hideCompetitors: true });
    const res = await get(t.cookie, `/portal/growth-map?project=${w.p1}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = portalGrowthMapResponseSchema.parse((res.json() as { data: unknown }).data);
    expect(body.series.filter((s) => s.entity_type === "competitor").map((s) => s.label)).toEqual(["Competitor A"]);
    expect(res.body).not.toContain("Globex");
    expect(res.body).not.toContain(w.rival);
    expect(body.milestones.map((m) => m.title)).toEqual(["Shown milestone"]);
  });

  it("STORY-098 s11 · hide_competitors: a task_completed milestone of a displacement-born task is as hidden on growth-map as the task is on tasks (the two tabs agree)", async () => {
    const w = await world();
    const title = "Beat Globex on pricing";
    const [task, milestone] = [randomUUID(), randomUUID()];
    await harness.db().query(
      "INSERT INTO milestones (id, workspace_id, project_id, occurred_at, kind, title, source_type, source_id, visible_in_portal) VALUES ($1,$2,$3,now() - interval '1 day','task_completed',$4,'task',$5,true)",
      [milestone, w.ws, w.p1, title, task],
    );
    await harness.db().query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, title, description, status, impact_score, dedupe_fingerprint, completed_at, milestone_id, source_displacement_id)
       VALUES ($1,$2,$3,$4,'content',$5,'d','done',0,$6,now(),$7,$8)`,
      [task, w.ws, w.p1, `T-${task.slice(0, 6)}`, title, randomBytes(16), milestone, randomUUID()],
    );
    const hidden = await token(w, { scope: [w.p1], tabs: ["overview", "tasks", "growth_map"], hideCompetitors: true });
    const tasks = await get(hidden.cookie, `/portal/tasks?project=${w.p1}`);
    const map = await get(hidden.cookie, `/portal/growth-map?project=${w.p1}`);
    expect(tasks.statusCode, tasks.body).toBe(200);
    expect(map.statusCode, map.body).toBe(200);
    expect(tasks.body).not.toContain("Globex");
    expect(map.body).not.toContain("Globex");
    expect(portalGrowthMapResponseSchema.parse((map.json() as { data: unknown }).data).milestones.map((m) => m.title)).toEqual(["Shown milestone"]);
    // The control: the same pair is served when competitors are not hidden.
    const open = await token(w, { scope: [w.p1], tabs: ["overview", "tasks", "growth_map"] });
    expect((await get(open.cookie, `/portal/growth-map?project=${w.p1}`)).body).toContain(title);
  });

  it("STORY-098 s11 · competitors visible: the real label shows (the control for the case above)", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const body = portalGrowthMapResponseSchema.parse(((await get(t.cookie, `/portal/growth-map?project=${w.p1}`)).json() as { data: unknown }).data);
    expect(body.series.map((s) => s.label)).toContain(RIVAL);
  });

  it("STORY-098 s12 · hide_costs: a key scan of every portal payload finds no quota, credit, cost or capture-count field", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1], hideCosts: true });
    for (const path of ["/portal/overview", `/portal/growth-map?project=${w.p1}`, `/portal/matrix?project=${w.p1}`]) {
      const res = await get(t.cookie, path);
      expect(res.statusCode, path).toBe(200);
      expect(findCostFields((res.json() as { data: unknown }).data), path).toEqual([]);
    }
  });

  it("NEW-E-099a owner decision 2026-10-08 · hide_costs: the methodology footer carries no sample_size on the wire; with costs visible it does", async () => {
    const w = await world();
    const hidden = await token(w, { scope: [w.p1], hideCosts: true });
    const hiddenRes = await get(hidden.cookie, "/portal/overview");
    expect(hiddenRes.statusCode, hiddenRes.body).toBe(200);
    expect(hiddenRes.body).not.toContain("sample_size");
    const hiddenFooter = portalOverviewResponseSchema.parse((hiddenRes.json() as { data: unknown }).data).projects[0]!.footer;
    expect(hiddenFooter.note.length).toBeGreaterThan(0);
    expect(hiddenFooter.live_capture_ratio).not.toBeUndefined();
    const open = await token(w, { scope: [w.p1] });
    const openFooter = portalOverviewResponseSchema.parse(((await get(open.cookie, "/portal/overview")).json() as { data: unknown }).data).projects[0]!.footer;
    // The world seeds no per-engine rows, so the value is 0; what matters is that it is PRESENT (0, not absent).
    expect(openFooter.sample_size).toBe(0);
  });

  it("STORY-098 s13 · a locked timeframe cannot be widened by ?timeframe=; the lock is what is served and reported", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1], lock: "7d" });
    const widened = await get(t.cookie, "/portal/overview?timeframe=90d");
    expect(widened.statusCode).toBe(400);
    expect(errorOf(widened).code).toBe("validation_failed");
    const widenedMap = await get(t.cookie, `/portal/growth-map?project=${w.p1}&timeframe=30d`);
    expect(widenedMap.statusCode).toBe(400);
    const ok = portalOverviewResponseSchema.parse(((await get(t.cookie, "/portal/overview")).json() as { data: unknown }).data);
    expect(ok.timeframe).toBe("7d");
    expect(ok.timeframe_locked).toBe(true);
    expect(ok.projects[0]!.footer.timeframe).toBe("7d");
    const map = portalGrowthMapResponseSchema.parse(((await get(t.cookie, `/portal/growth-map?project=${w.p1}`)).json() as { data: unknown }).data);
    expect(map.series[0]!.points).toHaveLength(7);
  });

  it("STORY-098 s14 · a milestone with visible_in_portal=false is absent from the payload (filtered in SQL, not hidden in the view)", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const res = await get(t.cookie, `/portal/growth-map?project=${w.p1}`);
    expect(res.body).not.toContain("Hidden engine model change");
    expect(res.body).toContain("Shown milestone");
  });

  it("STORY-098 s22 / STORY-099 s15 · two tokens on the same path never share a cache entry: each gets its own settings, in either order", async () => {
    const w = await world();
    const open = await token(w, { scope: [w.p1] });
    const hidden = await token(w, { scope: [w.p1], hideCompetitors: true });
    for (let i = 0; i < 2; i++) {
      const a = await get(open.cookie, `/portal/growth-map?project=${w.p1}`);
      const b = await get(hidden.cookie, `/portal/growth-map?project=${w.p1}`);
      expect(a.body).toContain(RIVAL);
      expect(b.body).not.toContain(RIVAL);
    }
  });

  it("STORY-099 s3 · every mutating verb on /portal/* is refused, and nothing is written", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const before = (await harness.db().query("SELECT count(*)::int AS n FROM projects")).rows[0].n as number;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const path of ["/portal/overview", `/portal/growth-map?project=${w.p1}`, `/portal/matrix?project=${w.p1}`]) {
        const res = await harness.app().inject({ method, url: apiUrl(path), headers: { cookie: t.cookie, "content-type": "application/json" }, payload: "{}" });
        expect(res.statusCode, `${method} ${path}`).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, `${method} ${path}`).toBeLessThan(500);
      }
    }
    expect((await harness.db().query("SELECT count(*)::int AS n FROM projects")).rows[0].n).toBe(before);
  });

  it("STORY-099 s4 · scope supplied in the request is ignored or refused: an unknown query key is 400, a scope header changes nothing", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    expect((await get(t.cookie, `/portal/overview?scope=${w.p2}`)).statusCode).toBe(400);
    expect((await get(t.cookie, `/portal/overview?workspace_id=${w.ws}`)).statusCode).toBe(400);
    const res = await get(t.cookie, "/portal/overview", { "x-portal-scope": `${w.p1},${w.p2}`, "x-project-id": w.p2 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(w.p2);
  });

  it("STORY-099 s16 · every portal read is private, non-cacheable and search-excluded; the refusal too", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    for (const res of [await get(t.cookie, "/portal/overview"), await get(t.cookie, `/portal/matrix?project=${w.p1}`), await get(null, "/portal/overview")]) {
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(String(res.headers["x-robots-tag"])).toContain("noindex");
    }
  });

  it("matrix · an engine with nothing measured has null metrics and a null data_source, never 0 or 'demo'; the payload conforms", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const res = await get(t.cookie, `/portal/matrix?project=${w.p1}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = portalMatrixResponseSchema.parse((res.json() as { data: unknown }).data);
    for (const e of body.engines) {
      if (e.data_source === null) {
        expect(e.visibility_score).toBeNull();
        expect(e.presence_rate).toBeNull();
        expect(e.share_of_voice).toBeNull();
      }
    }
  });

  it("STORY-098 s9 · no cookie is 401 with no data on all three endpoints", async () => {
    const w = await world();
    for (const path of ["/portal/overview", `/portal/growth-map?project=${w.p1}`, `/portal/matrix?project=${w.p1}`]) {
      const res = await get(null, path);
      expect(res.statusCode, path).toBe(401);
      expect(res.body).not.toContain(w.p1);
    }
  });
});
