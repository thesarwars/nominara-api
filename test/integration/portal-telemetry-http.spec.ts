import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PortalCookiePayload } from "../../contracts/portal/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { loadPortalCookieKey, PORTAL_COOKIE_NAME, sealPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { generateShareSecret, hashShareSecret } from "../../src/modules/agency/share-tokens.service.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-098 scenario 19 · owner decision 71 (c) — POST /portal/telemetry: pages and duration recorded against the view the cookie names.
// The portal reads run on the nominara_portal pool; the beat writes on the app pool (run here as the real nominara_app role).
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const KEY = loadPortalCookieKey(COOKIE_KEY_B64);

describe("STORY-098 s19 · portal telemetry (pages and duration through a view id)", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    runAsAppRole: true,
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

  interface World { ws: string; p1: string; user: string }
  async function world(): Promise<World> {
    const db = harness.db();
    const [ws, p1, user] = [randomUUID(), randomUUID(), randomUUID()];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Agency One',$2,'growth','UTC')", [ws, `w-${ws.slice(0, 8)}`]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'Client One',$3,'https://a.test','a.test')", [p1, ws, `p-${p1.slice(0, 8)}`]);
    return { ws, p1, user };
  }

  /** A real session: a passwordless token minted through POST /portal/session, so the cookie is the one production issues. */
  async function session(w: World, tabs = ["overview", "tasks"]): Promise<{ id: string; cookie: string; viewId: string }> {
    const id = randomUUID();
    const secret = generateShareSecret();
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, scope_tabs, created_by)
       VALUES ($1,$2,'Client link',$3,'abcdefgh',false,$4::uuid[],$5::text[],$6)`,
      [id, w.ws, hashShareSecret(secret), [w.p1], tabs, w.user],
    );
    const res = await harness.app().inject({
      method: "POST", url: apiUrl("/portal/session"), headers: { "content-type": "application/json" }, payload: { secret },
      remoteAddress: `10.9.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const raw = res.headers["set-cookie"];
    const line = String(Array.isArray(raw) ? raw.find((c) => String(c).startsWith(PORTAL_COOKIE_NAME)) : raw);
    const cookie = line.split(";")[0]!;
    const view = (await harness.db().query<{ id: string }>("SELECT id FROM share_token_views WHERE share_token_id = $1", [id])).rows[0]!;
    return { id, cookie, viewId: view.id };
  }

  const beat = (cookie: string | null, payload: unknown) =>
    harness.app().inject({ method: "POST", url: apiUrl("/portal/telemetry"), headers: { "content-type": "application/json", ...(cookie === null ? {} : { cookie }) }, payload: payload as object });
  const viewRow = async (id: string) =>
    (await harness.db().query<{ pages_viewed: string[]; duration_ms: number | null; viewed_at: Date }>("SELECT pages_viewed, duration_ms, viewed_at FROM share_token_views WHERE id = $1", [id])).rows[0]!;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error;

  it("STORY-098 s19 · a beat records the tab and a server-measured duration against the view the cookie names, and the agency reads them back as pages and duration_s (null, not 0, before any beat)", async () => {
    const w = await world();
    const s = await session(w);
    expect(await viewRow(s.viewId)).toMatchObject({ pages_viewed: [], duration_ms: null });
    await harness.db().query("UPDATE share_token_views SET viewed_at = now() - interval '90 seconds' WHERE id = $1", [s.viewId]);
    const res = await beat(s.cookie, { tab: "overview" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { data: unknown }).data).toEqual({ recorded: true });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const row = await viewRow(s.viewId);
    expect(row.pages_viewed).toEqual(["overview"]);
    expect(row.duration_ms!).toBeGreaterThanOrEqual(89_000);
    expect(row.duration_ms!).toBeLessThan(120_000);
    // A second tab is added; the same tab twice is one page.
    await harness.db().query("UPDATE share_token_views SET viewed_at = now() - interval '200 seconds' WHERE id = $1", [s.viewId]);
    expect((await beat(s.cookie, { tab: "tasks" })).statusCode).toBe(200);
    expect((await viewRow(s.viewId)).pages_viewed).toEqual(["overview", "tasks"]);
    expect((await viewRow(s.viewId)).duration_ms!).toBeGreaterThanOrEqual(199_000);
    expect((await beat(s.cookie, { tab: "tasks" })).statusCode).toBe(200);
    expect((await viewRow(s.viewId)).pages_viewed).toEqual(["overview", "tasks"]);
  });

  it("STORY-098 s19 · the agency's views list shows pages and duration_s for the view once beats arrive", async () => {
    const w = await world();
    const s = await session(w);
    await harness.db().query("UPDATE share_token_views SET viewed_at = now() - interval '60 seconds' WHERE id = $1", [s.viewId]);
    await beat(s.cookie, { tab: "overview" });
    const r = await harness.db().query<{ pages: number; duration_s: number }>(
      "SELECT NULLIF(cardinality(pages_viewed),0) AS pages, duration_ms::float8/1000 AS duration_s FROM share_token_views WHERE id = $1", [s.viewId]);
    expect(r.rows[0]!.pages).toBe(1);
    expect(r.rows[0]!.duration_s).toBeGreaterThanOrEqual(59);
  });

  it("STORY-098 s19 · beats within 5 seconds of the last recorded one write nothing (recorded:false) unless they add a new tab", async () => {
    const w = await world();
    const s = await session(w);
    await harness.db().query("UPDATE share_token_views SET viewed_at = now() - interval '60 seconds' WHERE id = $1", [s.viewId]);
    expect((await beat(s.cookie, { tab: "overview" })).statusCode).toBe(200);
    const first = await viewRow(s.viewId);
    await harness.db().query("UPDATE share_token_views SET viewed_at = viewed_at - interval '2 seconds' WHERE id = $1", [s.viewId]);
    const quick = await beat(s.cookie, { tab: "overview" });
    expect((quick.json() as { data: { recorded: boolean } }).data.recorded).toBe(false);
    expect((await viewRow(s.viewId)).duration_ms).toBe(first.duration_ms);
    const newTab = await beat(s.cookie, { tab: "tasks" });
    expect((newTab.json() as { data: { recorded: boolean } }).data.recorded).toBe(true);
  });

  it("STORY-098 s19 · the view is the cookie's, never the request's: a body naming a view (or anything else) is 400, and a cookie whose view belongs to ANOTHER token writes nothing to it", async () => {
    const w = await world();
    const a = await session(w);
    const b = await session(w);
    for (const payload of [{ tab: "overview", view_id: a.viewId }, { tab: "overview", token_id: a.id }, { tab: "overview", duration_ms: 99999999 }, {}, { tab: "billing" }]) {
      expect((await beat(b.cookie, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await viewRow(a.viewId)).pages_viewed).toEqual([]);
    // A cookie that is validly ours but carries a view of token A while naming token B.
    const forged: PortalCookiePayload = { token_id: b.id, workspace_id: w.ws, scope_project_ids: [w.p1], scope_tabs: ["overview", "tasks"], theme_id: null, view_id: a.viewId };
    const cookie = `${PORTAL_COOKIE_NAME}=${(await sealPortalCookie(forged, KEY)).value}`;
    const res = await beat(cookie, { tab: "overview" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { recorded: boolean } }).data.recorded).toBe(false);
    expect((await viewRow(a.viewId)).pages_viewed, "another token's view is untouched").toEqual([]);
    expect((await viewRow(b.viewId)).pages_viewed).toEqual([]);
  });

  it("ISO-09 / STORY-098 s19 · a view in ANOTHER workspace cannot be written even by a cookie that names it", async () => {
    const w1 = await world();
    const w2 = await world();
    const mine = await session(w1);
    const theirs = await session(w2);
    const forged: PortalCookiePayload = { token_id: mine.id, workspace_id: w1.ws, scope_project_ids: [w1.p1], scope_tabs: ["overview"], theme_id: null, view_id: theirs.viewId };
    const res = await beat(`${PORTAL_COOKIE_NAME}=${(await sealPortalCookie(forged, KEY)).value}`, { tab: "overview" });
    expect((res.json() as { data: { recorded: boolean } }).data.recorded).toBe(false);
    expect((await viewRow(theirs.viewId)).pages_viewed).toEqual([]);
  });

  it("STORY-098 s19 · a tab outside the token's scope is refused 403, and records nothing", async () => {
    const w = await world();
    const s = await session(w, ["overview"]);
    const res = await beat(s.cookie, { tab: "tasks" });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe("project_out_of_scope");
    expect((await viewRow(s.viewId)).pages_viewed).toEqual([]);
  });

  it("STORY-098 s19 · a session from before view ids (no view in the cookie) is served and records nothing: recorded:false", async () => {
    const w = await world();
    const s = await session(w);
    const legacy: PortalCookiePayload = { token_id: s.id, workspace_id: w.ws, scope_project_ids: [w.p1], scope_tabs: ["overview", "tasks"], theme_id: null };
    const res = await beat(`${PORTAL_COOKIE_NAME}=${(await sealPortalCookie(legacy, KEY)).value}`, { tab: "overview" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { recorded: boolean } }).data.recorded).toBe(false);
    expect((await viewRow(s.viewId)).pages_viewed).toEqual([]);
  });

  it("STORY-098 s17 / s19 · no cookie is 401 with no data; a revoked link fails the very next beat and nothing is recorded; a duration never exceeds the session's 4 hours", async () => {
    const w = await world();
    expect((await beat(null, { tab: "overview" })).statusCode).toBe(401);
    const s = await session(w);
    await harness.db().query("UPDATE share_token_views SET viewed_at = now() - interval '30 hours' WHERE id = $1", [s.viewId]);
    expect((await beat(s.cookie, { tab: "overview" })).statusCode).toBe(200);
    expect((await viewRow(s.viewId)).duration_ms).toBe(4 * 60 * 60 * 1000);
    await harness.db().query("UPDATE share_tokens SET revoked_at = now() WHERE id = $1", [s.id]);
    const res = await beat(s.cookie, { tab: "tasks" });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe("token_revoked");
    expect((await viewRow(s.viewId)).pages_viewed).toEqual(["overview"]);
  });
});
