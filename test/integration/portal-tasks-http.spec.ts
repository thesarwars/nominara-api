import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalCookiePayload } from "../../contracts/portal/index.js";
import { portalTasksResponseSchema } from "../../contracts/portal/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { findCostFields } from "../../src/lib/portal/portal-view.js";
import { hashShareSecret } from "../../src/modules/agency/share-tokens.service.js";
import { loadPortalCookieKey, PORTAL_COOKIE_NAME, sealPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-E-099b — GET /v1/portal/tasks and the first-view notification, through the REAL ApiModule chain on the REAL
// nominara_portal pool (reads) and the app pool (the session mint). STORY-099 s3, s8, s14, s15; FR-AGY-01o.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const KEY = loadPortalCookieKey(COOKIE_KEY_B64);

describe("NEW-E-099b · portal tasks and first-view notification", () => {
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

  async function task(w: World, project: string, o: { title: string; status: string; impact?: number; completedDaysAgo?: number; milestone?: { visible: boolean; impact: object | null }; displacement?: boolean; deleted?: boolean }): Promise<string> {
    const db = harness.db();
    const id = randomUUID();
    let milestoneId: string | null = null;
    if (o.milestone !== undefined) {
      milestoneId = randomUUID();
      await db.query(
        `INSERT INTO milestones (id, workspace_id, project_id, occurred_at, kind, title, visible_in_portal, measured_impact)
         VALUES ($1,$2,$3,now(),'task_completed',$4,$5,$6::jsonb)`,
        [milestoneId, w.ws, project, `M ${o.title}`, o.milestone.visible, o.milestone.impact === null ? null : JSON.stringify(o.milestone.impact)],
      );
    }
    await db.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, title, description, status, impact_score, dedupe_fingerprint, completed_at, milestone_id, source_displacement_id, deleted_at)
       VALUES ($1,$2,$3,$4,'content',$5,'d',$6,$7,$8, CASE WHEN $9::int IS NULL THEN NULL ELSE now() - ($9::int || ' days')::interval END, $10, $11, CASE WHEN $12 THEN now() END)`,
      [id, w.ws, project, `T-${id.slice(0, 6)}`, o.title, o.status, o.impact ?? 0, randomBytes(16), o.completedDaysAgo ?? null, milestoneId, o.displacement === true ? randomUUID() : null, o.deleted === true],
    );
    return id;
  }

  async function world(): Promise<World> {
    const db = harness.db();
    const [ws, p1, p2, user] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Agency One',$2,'growth','UTC')", [ws, `w-${ws.slice(0, 8)}`]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    for (const [id, name] of [[p1, "Client One"], [p2, "Client Two"]] as const) {
      await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,$3,$4,'https://a.test','a.test')", [id, ws, name, `p-${id.slice(0, 8)}`]);
    }
    return { ws, p1, p2, user };
  }

  interface TokenOpts { scope: string[]; tabs?: string[]; hideCompetitors?: boolean; hideCosts?: boolean; lock?: string | null }
  const TABS = ["overview", "tasks"];

  async function token(w: World, o: TokenOpts, secret?: string): Promise<{ id: string; cookie: string }> {
    const id = randomUUID();
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, scope_tabs, hide_competitors, hide_costs, timeframe_lock, created_by)
       VALUES ($1,$2,'Client link',$3,'abcdefgh',false,$4::uuid[],$5::text[],$6,$7,$8,$9)`,
      [id, w.ws, secret === undefined ? randomBytes(32) : hashShareSecret(secret), o.scope, o.tabs ?? TABS, o.hideCompetitors ?? false, o.hideCosts ?? false, o.lock ?? null, w.user],
    );
    const payload: PortalCookiePayload = { token_id: id, workspace_id: w.ws, scope_project_ids: o.scope, scope_tabs: (o.tabs ?? TABS) as PortalCookiePayload["scope_tabs"], theme_id: null };
    const { value } = await sealPortalCookie(payload, KEY);
    return { id, cookie: `${PORTAL_COOKIE_NAME}=${value}` };
  }

  const get = (cookie: string | null, path: string) =>
    harness.app().inject({ method: "GET", url: apiUrl(path), headers: cookie === null ? {} : { cookie } });
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error;
  const impact = { visibility_before: 40, visibility_after_14d: 44.2, delta: 4.2, window_days: 14, confidence: "medium", method: "before_after", caveat: "Observational; concurrent changes are not controlled for." };

  it("STORY-099 s8 · completed work (title, completed_at, measured) newest first; open work by impact; dismissed, deleted and other projects absent; conforms to the contract", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Done old", status: "done", completedDaysAgo: 20, milestone: { visible: true, impact } });
    await task(w, w.p1, { title: "Done new", status: "done", completedDaysAgo: 2 });
    await task(w, w.p1, { title: "Open low", status: "todo", impact: 10 });
    await task(w, w.p1, { title: "Open high", status: "in_progress", impact: 90 });
    await task(w, w.p1, { title: "Dismissed", status: "dismissed", impact: 99 });
    await task(w, w.p1, { title: "Deleted", status: "todo", impact: 99, deleted: true });
    await task(w, w.p2, { title: "Other project", status: "todo", impact: 99 });
    const t = await token(w, { scope: [w.p1] });
    const res = await get(t.cookie, `/portal/tasks?project=${w.p1}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = portalTasksResponseSchema.parse((res.json() as { data: unknown }).data);
    expect(body.completed.map((c) => c.title)).toEqual(["Done new", "Done old"]);
    expect(body.completed[1]!.measured).toEqual({ delta: 4.2, confidence: "medium", window_days: 14, caveat: impact.caveat });
    expect(body.completed[0]!.measured).toBeNull();
    expect(body.open.map((o) => o.title)).toEqual(["Open high", "Open low"]);
    for (const hidden of ["Dismissed", "Deleted", "Other project"]) expect(res.body).not.toContain(hidden);
  });

  it("STORY-099 s8 · a milestone hidden from the portal contributes no measurement (null), though the task is shown", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Hidden impact", status: "done", completedDaysAgo: 1, milestone: { visible: false, impact } });
    const res = await get((await token(w, { scope: [w.p1] })).cookie, `/portal/tasks?project=${w.p1}`);
    const body = portalTasksResponseSchema.parse((res.json() as { data: unknown }).data);
    expect(body.completed).toHaveLength(1);
    expect(body.completed[0]!.measured).toBeNull();
  });

  it("STORY-099 s8 · a project with no tasks returns two empty lists", async () => {
    const w = await world();
    const res = await get((await token(w, { scope: [w.p1] })).cookie, `/portal/tasks?project=${w.p1}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown }).data).toEqual({ completed: [], open: [] });
  });

  it("STORY-098 s10 · an out-of-scope project, and a token without the tasks tab, are 403 project_out_of_scope", async () => {
    const w = await world();
    await task(w, w.p2, { title: "Secret", status: "todo" });
    const t = await token(w, { scope: [w.p1] });
    const out = await get(t.cookie, `/portal/tasks?project=${w.p2}`);
    expect(out.statusCode).toBe(403);
    expect(errorOf(out).code).toBe("project_out_of_scope");
    expect(out.body).not.toContain("Secret");
    const noTab = await token(w, { scope: [w.p1], tabs: ["overview"] });
    expect((await get(noTab.cookie, `/portal/tasks?project=${w.p1}`)).statusCode).toBe(403);
  });

  it("STORY-098 s12 · hide_costs: a key scan of the tasks payload finds no quota, credit, cost or capture-count field", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Done", status: "done", completedDaysAgo: 1, milestone: { visible: true, impact } });
    await task(w, w.p1, { title: "Open", status: "todo", impact: 5 });
    const res = await get((await token(w, { scope: [w.p1], hideCosts: true })).cookie, `/portal/tasks?project=${w.p1}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(findCostFields((res.json() as { data: unknown }).data)).toEqual([]);
  });

  it("STORY-098 s11 · hide_competitors: a task born of a displacement event is absent; with competitors visible it is present (control)", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Beat Globex on pricing", status: "todo", impact: 50, displacement: true });
    await task(w, w.p1, { title: "Plain task", status: "todo", impact: 40 });
    const hidden = await get((await token(w, { scope: [w.p1], hideCompetitors: true })).cookie, `/portal/tasks?project=${w.p1}`);
    expect(hidden.body).not.toContain("Globex");
    expect(hidden.body).toContain("Plain task");
    const open = await get((await token(w, { scope: [w.p1] })).cookie, `/portal/tasks?project=${w.p1}`);
    expect(open.body).toContain("Globex");
  });

  it("STORY-098 s13 · a timeframe lock bounds completed work to the lock; older completions are absent", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Within lock", status: "done", completedDaysAgo: 3 });
    await task(w, w.p1, { title: "Before lock", status: "done", completedDaysAgo: 30 });
    const res = await get((await token(w, { scope: [w.p1], lock: "7d" })).cookie, `/portal/tasks?project=${w.p1}`);
    expect(res.body).toContain("Within lock");
    expect(res.body).not.toContain("Before lock");
  });

  it("STORY-099 s14 · the portal role cannot read a fact table at all through this path: the tasks read issues no statement against one (query trace)", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Open", status: "todo" });
    const t = await token(w, { scope: [w.p1] });
    // The trace is pg's Client.prototype.query, in-process: every statement of the request, on any pool. (The earlier
    // pg_stat_statements version passed vacuously: no test container preloads the extension, and a co-filter on `tasks`
    // would have missed a separate fact-table statement.)
    const seen: string[] = [];
    const original = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0];
      seen.push(typeof first === "string" ? first : typeof first === "object" && first !== null && "text" in first ? String((first as { text: unknown }).text) : "");
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    let res;
    try {
      res = await get(t.cookie, `/portal/tasks?project=${w.p1}`);
    } finally {
      spy.mockRestore();
    }
    expect(res.statusCode, res.body).toBe(200);
    expect(seen.length, "the trace must have seen the request's statements").toBeGreaterThan(0);
    expect(seen.filter((sql) => /\b(answer_captures|mention_facts|citation_facts)\b/i.test(sql))).toEqual([]);
  });

  it("STORY-099 s15 · two tokens on the same path never share a cache entry", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Beat Globex", status: "todo", displacement: true });
    const open = await token(w, { scope: [w.p1] });
    const hidden = await token(w, { scope: [w.p1], hideCompetitors: true });
    for (let i = 0; i < 2; i++) {
      expect((await get(open.cookie, `/portal/tasks?project=${w.p1}`)).body).toContain("Globex");
      expect((await get(hidden.cookie, `/portal/tasks?project=${w.p1}`)).body).not.toContain("Globex");
    }
  });

  it("STORY-099 s3 · every mutating verb on /portal/tasks is refused, and no task changes", async () => {
    const w = await world();
    const id = await task(w, w.p1, { title: "Untouched", status: "todo" });
    const t = await token(w, { scope: [w.p1] });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await harness.app().inject({ method, url: apiUrl(`/portal/tasks?project=${w.p1}`), headers: { cookie: t.cookie, "content-type": "application/json" }, payload: "{}" });
      expect(res.statusCode, method).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, method).toBeLessThan(500);
    }
    expect((await harness.db().query("SELECT status, title FROM tasks WHERE id = $1", [id])).rows[0]).toEqual({ status: "todo", title: "Untouched" });
  });

  it("STORY-099 s4 · an unknown query key is 400; no cookie is 401 with no data", async () => {
    const w = await world();
    await task(w, w.p1, { title: "Visible only with a cookie", status: "todo" });
    const t = await token(w, { scope: [w.p1] });
    expect((await get(t.cookie, `/portal/tasks?project=${w.p1}&workspace_id=${w.ws}`)).statusCode).toBe(400);
    const anon = await get(null, `/portal/tasks?project=${w.p1}`);
    expect(anon.statusCode).toBe(401);
    expect(anon.body).not.toContain("Visible only");
  });

  it("FR-AGY-01o · the first session mint for a token writes one in-app notification for the workspace; the second writes none", async () => {
    const w = await world();
    const secret = randomBytes(32).toString("base64url");
    const t = await token(w, { scope: [w.p1] }, secret);
    const mint = () => harness.app().inject({ method: "POST", url: apiUrl("/portal/session"), headers: { "content-type": "application/json" }, payload: JSON.stringify({ secret }) });
    expect((await mint()).statusCode).toBe(200);
    const rows = async () => (await harness.db().query("SELECT workspace_id, user_id, kind, channels, payload FROM notifications WHERE workspace_id = $1 AND kind = 'portal.first_view'", [w.ws])).rows;
    const first = await rows();
    expect(first).toHaveLength(1);
    expect(first[0].user_id).toBeNull();
    expect(first[0].channels).toEqual(["in_app", "email"]);
    expect(JSON.stringify(first[0].payload)).toContain(t.id);
    expect((await mint()).statusCode).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("STORY-098 (review fix) · the portal mint, under the real portal role and RLS, records one notification_emails row per INTENDED recipient: an owner and a manager who sees the token's project; not a manager scoped elsewhere, an analyst, nor a second mint", async () => {
    const w = await world();
    const db = harness.db();
    const addMember = async (role: string, scope: string[] | null, cadence: string | null = null): Promise<string> => {
      const user = randomUUID();
      await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
      await db.query("INSERT INTO workspace_members (id, workspace_id, user_id, role, project_scope, status, digest_cadence) VALUES ($1,$2,$3,$4,$5,'active',$6)", [randomUUID(), w.ws, user, role, scope, cadence]);
      return user;
    };
    const owner = await addMember("owner", null, "off"); // digest off: still emailed, an immediate notice is not a digest
    const inScope = await addMember("manager", [w.p1]);
    await addMember("manager", [w.p2]);
    await addMember("analyst", null);
    const secret = randomBytes(32).toString("base64url");
    await token(w, { scope: [w.p1] }, secret);
    const mint = () => harness.app().inject({ method: "POST", url: apiUrl("/portal/session"), headers: { "content-type": "application/json" }, payload: JSON.stringify({ secret }) });
    expect((await mint()).statusCode).toBe(200);
    const emails = async () => (await db.query("SELECT user_id, kind, status FROM notification_emails WHERE workspace_id = $1 ORDER BY user_id", [w.ws])).rows as Array<{ user_id: string; kind: string; status: string }>;
    const rows = await emails();
    expect(rows.map((r) => r.user_id).sort()).toEqual([owner, inScope].sort());
    for (const r of rows) expect(r).toMatchObject({ kind: "immediate", status: "pending" });
    expect((await mint()).statusCode).toBe(200);
    expect(await emails()).toHaveLength(2);
  });

  it("FR-AGY-01o · two parallel first mints produce exactly one notification", async () => {
    const w = await world();
    const secret = randomBytes(32).toString("base64url");
    await token(w, { scope: [w.p1] }, secret);
    const mint = () => harness.app().inject({ method: "POST", url: apiUrl("/portal/session"), headers: { "content-type": "application/json" }, payload: JSON.stringify({ secret }) });
    await Promise.all([mint(), mint()]);
    const n = (await harness.db().query("SELECT count(*)::int AS n FROM notifications WHERE workspace_id = $1 AND kind = 'portal.first_view'", [w.ws])).rows[0].n as number;
    expect(n).toBe(1);
  });

  it("FR-AGY-01o · a refused mint (wrong secret) writes no notification", async () => {
    const w = await world();
    await token(w, { scope: [w.p1] }, randomBytes(32).toString("base64url"));
    const res = await harness.app().inject({ method: "POST", url: apiUrl("/portal/session"), headers: { "content-type": "application/json" }, payload: JSON.stringify({ secret: randomBytes(32).toString("base64url") }) });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM notifications WHERE workspace_id = $1", [w.ws])).rows[0].n).toBe(0);
  });
});
