import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PortalCookiePayload } from "../../contracts/portal/index.js";
import { portalSourcesCostsHiddenSchema, portalSourcesCostsVisibleSchema } from "../../contracts/portal/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { loadPortalCookieKey, PORTAL_COOKIE_NAME, sealPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// Decision 83 (c) — GET /v1/portal/sources through the REAL ApiModule chain on the REAL nominara_portal pool, so the new
// source_domains portal policy (a join through project_source_index to the token's scope) is what the database enforces here.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const KEY = loadPortalCookieKey(COOKIE_KEY_B64);
const RIVAL = "Globex Rival Industries";

describe("decision 83 (c) · GET /portal/sources", () => {
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

  interface World { ws: string; p1: string; p2: string; user: string }

  async function addDomain(w: World, project: string, domain: string, o: { sourceClass?: string; days?: number; engine?: string; citations?: number; prompts?: number; present?: boolean | null; severity?: string | null; competitorOwned?: boolean; verified?: boolean } = {}) {
    const db = harness.db();
    const existing = await db.query<{ id: string }>("SELECT id FROM source_domains WHERE workspace_id = $1 AND domain = $2", [w.ws, domain]);
    const id = existing.rows[0]?.id ?? (await db.query<{ id: string }>("INSERT INTO source_domains (workspace_id, domain, source_class, is_seedable) VALUES ($1,$2,$3,true) RETURNING id", [w.ws, domain, o.sourceClass ?? "community_forum"])).rows[0]!.id;
    await db.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, citation_count, distinct_prompts, context_weight, rank_position, brand_present_on_domain, gap_severity, top_urls, is_competitor_owned, verified_at)
       VALUES ($1,$2,$3,$4,(CURRENT_DATE - $5::int),$5,$6,$7,0.5,1,$8,$9,$10::jsonb,$11,$12)`,
      [
        w.ws, project, id, o.engine ?? "all", o.days ?? 30, o.citations ?? 12, o.prompts ?? 5,
        o.present === undefined ? null : o.present, o.severity === undefined ? null : o.severity,
        JSON.stringify([{ url: `https://${domain}/page`, count: 3, last_seen: "2026-11-01" }]), o.competitorOwned ?? false, o.verified ? new Date() : null,
      ],
    );
    return id;
  }

  async function world(): Promise<World> {
    const db = harness.db();
    const [ws, p1, p2, user, rival] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Agency One',$2,'growth','UTC')", [ws, `w-${ws.slice(0, 8)}`]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    for (const [id, name] of [[p1, "Client One"], [p2, "Client Two"]] as const) {
      await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,$3,$4,'https://a.test','a.test')", [id, ws, name, `p-${id.slice(0, 8)}`]);
    }
    await db.query("INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source) VALUES ($1,$2,$3,$4,'globex.test',ARRAY[]::text[],'user')", [rival, ws, p1, RIVAL]);
    await db.query("UPDATE projects SET source_coverage = 42.5 WHERE id = $1", [p1]);
    const w = { ws, p1, p2, user };
    await addDomain(w, p1, "reddit.com", { verified: true, present: true, severity: "none" });
    await addDomain(w, p1, "globex.test", { sourceClass: "vendor_owned", competitorOwned: true, citations: 7 });
    await addDomain(w, p1, "quora.com", { sourceClass: "other", citations: 0, prompts: 0 });
    await addDomain(w, p2, "only-in-client-two.example", { citations: 99 });
    return w;
  }

  interface TokenOpts { scope: string[]; tabs?: string[]; hideCompetitors?: boolean; hideCosts?: boolean; lock?: string | null }
  async function token(w: World, o: TokenOpts): Promise<{ id: string; cookie: string }> {
    const id = randomUUID();
    const tabs = o.tabs ?? ["overview", "sources"];
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, scope_tabs, hide_competitors, hide_costs, timeframe_lock, created_by)
       VALUES ($1,$2,'Client link',$3,'abcdefgh',false,$4::uuid[],$5::text[],$6,$7,$8,$9)`,
      [id, w.ws, randomBytes(32), o.scope, tabs, o.hideCompetitors ?? false, o.hideCosts ?? false, o.lock ?? null, w.user],
    );
    const payload: PortalCookiePayload = { token_id: id, workspace_id: w.ws, scope_project_ids: o.scope, scope_tabs: tabs as PortalCookiePayload["scope_tabs"], theme_id: null };
    const { value } = await sealPortalCookie(payload, KEY);
    return { id, cookie: `${PORTAL_COOKIE_NAME}=${value}` };
  }

  const get = (cookie: string | null, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), headers: cookie === null ? {} : { cookie } });
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error;
  const dataOf = (res: { json(): unknown }) => (res.json() as { data: { window: { from: string; to: string }; source_coverage: number | null; domains: Array<Record<string, unknown>> } }).data;

  it("D83C-1 serves the scoped project's domains, conforms to the contract, and nothing of a project outside the scope (the database narrows it too)", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const res = await get(t.cookie, `/portal/sources?project=${w.p1}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = portalSourcesCostsVisibleSchema.parse(dataOf(res));
    expect(body.domains.map((d) => d.domain).sort()).toEqual(["globex.test", "quora.com", "reddit.com"]);
    expect(body.source_coverage).toBe(42.5);
    expect(res.body).not.toContain("only-in-client-two.example");
    expect(res.body).not.toContain(w.p2);
  });

  it("D83C-2 null stays null and 0 stays 0: an unverified domain has null presence and severity; zero citations is 0; class `other` is servable", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const byDomain = new Map(dataOf(await get(t.cookie, `/portal/sources?project=${w.p1}`)).domains.map((d) => [d.domain as string, d]));
    expect(byDomain.get("quora.com")).toMatchObject({ brand_present: null, gap_severity: null, verified_at: null, citations: 0, prompts: 0, source_class: "other" });
    expect(byDomain.get("reddit.com")).toMatchObject({ brand_present: true, gap_severity: "none" });
    expect(byDomain.get("reddit.com")!.verified_at).not.toBeNull();
  });

  it("D83C-3 a project outside the token's scope is 403 project_out_of_scope; a tab outside scope_tabs is too; no cookie is 401", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const out = await get(t.cookie, `/portal/sources?project=${w.p2}`);
    expect(out.statusCode).toBe(403);
    expect(errorOf(out).code).toBe("project_out_of_scope");
    const noTab = await token(w, { scope: [w.p1], tabs: ["overview"] });
    expect((await get(noTab.cookie, `/portal/sources?project=${w.p1}`)).statusCode).toBe(403);
    expect((await get(null, `/portal/sources?project=${w.p1}`)).statusCode).toBe(401);
  });

  it("D83C-4 the query is strict: an unknown key, a missing project, 24h and a malformed project are all 400", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    for (const q of [`project=${w.p1}&workspace_id=${w.ws}`, "", `project=${w.p1}&timeframe=24h`, `project=${w.p1}&timeframe=bogus`, "project=not-a-uuid"]) {
      expect((await get(t.cookie, `/portal/sources?${q}`)).statusCode, q).toBe(400);
    }
  });

  it("D83C-5 hide_costs: the citations and prompts counts (and per-url counts) are absent on the wire; with costs visible they are present", async () => {
    const w = await world();
    const hidden = await get((await token(w, { scope: [w.p1], hideCosts: true })).cookie, `/portal/sources?project=${w.p1}`);
    expect(hidden.statusCode, hidden.body).toBe(200);
    portalSourcesCostsHiddenSchema.parse(dataOf(hidden));
    expect(hidden.body).not.toMatch(/"citations"|"prompts"/);
    const open = await get((await token(w, { scope: [w.p1] })).cookie, `/portal/sources?project=${w.p1}`);
    expect(open.body).toMatch(/"citations"/);
    expect(open.body).toMatch(/"prompts"/);
  });

  it("D83C-6 hide_competitors: a competitor's own domain and name are absent everywhere; competitors visible: both are served", async () => {
    const w = await world();
    const hidden = await get((await token(w, { scope: [w.p1], hideCompetitors: true })).cookie, `/portal/sources?project=${w.p1}`);
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.body).not.toMatch(/globex/i);
    expect(dataOf(hidden).domains.map((d) => d.domain).sort()).toEqual(["quora.com", "reddit.com"]);
    const open = await get((await token(w, { scope: [w.p1] })).cookie, `/portal/sources?project=${w.p1}`);
    expect(open.body).toContain(RIVAL);
    expect(open.body).toContain("globex.test");
  });

  it("D83C-7 the timeframe picks the window (7d/30d/90d) and a locked link cannot be widened; a 24h lock has no source window and is refused, never widened", async () => {
    const w = await world();
    await addDomain(w, w.p1, "news.example", { days: 7, citations: 4 });
    const t = await token(w, { scope: [w.p1] });
    const seven = dataOf(await get(t.cookie, `/portal/sources?project=${w.p1}&timeframe=7d`));
    expect(seven.domains.map((d) => d.domain)).toEqual(["news.example"]);
    const thirty = dataOf(await get(t.cookie, `/portal/sources?project=${w.p1}`));
    expect(thirty.domains.map((d) => d.domain)).not.toContain("news.example");
    const locked = await token(w, { scope: [w.p1], lock: "7d" });
    expect((await get(locked.cookie, `/portal/sources?project=${w.p1}&timeframe=30d`)).statusCode).toBe(400);
    expect(dataOf(await get(locked.cookie, `/portal/sources?project=${w.p1}`)).domains.map((d) => d.domain)).toEqual(["news.example"]);
    const day = await token(w, { scope: [w.p1], lock: "24h" });
    expect((await get(day.cookie, `/portal/sources?project=${w.p1}`)).statusCode).toBe(400);
  });

  it("D83C-8 two tokens on the same project never share a cache entry: hide_costs and open each get their own shape, in either order", async () => {
    const w = await world();
    const open = await token(w, { scope: [w.p1] });
    const hidden = await token(w, { scope: [w.p1], hideCosts: true });
    for (const first of [open, hidden, open, hidden]) {
      const res = await get(first.cookie, `/portal/sources?project=${w.p1}`);
      expect(/"citations"/.test(res.body), first.id === open.id ? "open" : "hidden").toBe(first.id === open.id);
    }
  });

  it("D83C-9 every mutating verb on /portal/sources is refused, and the response is private and non-cacheable", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await harness.app().inject({ method, url: apiUrl(`/portal/sources?project=${w.p1}`), headers: { cookie: t.cookie } });
      expect([404, 405], method).toContain(res.statusCode);
    }
    const ok = await get(t.cookie, `/portal/sources?project=${w.p1}`);
    expect(String(ok.headers["cache-control"])).toMatch(/no-store|private/);
  });
});
