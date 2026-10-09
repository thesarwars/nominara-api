import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalCookiePayload } from "../../contracts/portal/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { loadPortalCookieKey, PORTAL_COOKIE_NAME, sealPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-E-099b AC2 / STORY-099 s14 — "Portal queries touch no fact tables (answer_captures, mention_facts, citation_facts),
// asserted by a query trace." The trace is taken where every statement of the request passes: pg's Client.prototype.query,
// in-process, so it sees the portal pool AND the app pool, and a separate fact-table statement cannot hide behind a
// co-filter. (An earlier version of this check used pg_stat_statements, which no test container loads: it passed vacuously.)
//
// EXEMPTIONS (a closed, named list; each is matched by the statement's own shape, so any other fact-table read still fails):
//   - engine_data_sources: owner decision 2026-10-08 (NEW-E-100a), the rollup has no such column.
//   - owner decision 2026-10-09 #1 (week 1 only; rollup-only portal projection is week 2): the portal overview, matrix and
//     growth-map reads, namely ScorecardsService.engineConfig (the `measured` CTE and the `last_capture` lateral, one
//     statement), aggregateRange's `day_cells` statement, and GrowthMapService.failureDays.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const KEY = loadPortalCookieKey(COOKIE_KEY_B64);

describe("NEW-E-099b · portal reads touch no fact tables", () => {
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


  const FACT_TABLES = /\b(answer_captures|mention_facts|citation_facts)\b/i;
  const EXEMPT_READS: ReadonlyArray<{ name: string; shape: RegExp }> = [
    { name: "engineDataSourcesForDates (NEW-E-100a)", shape: /count\(\*\) FILTER \(WHERE c\.normalizer_version/ },
    { name: "ScorecardsService.engineConfig (2026-10-09 #1)", shape: /^\s*WITH measured AS \(\s*SELECT DISTINCT c\.engine_key\s+FROM answer_captures c\b/ },
    { name: "aggregateRange day_cells (2026-10-09 #1)", shape: /^\s*WITH day_cells AS \(\s*SELECT c\.id, c\.engine_key, c\.status, c\.cache_layer, c\.brand_present, c\.sov,/ },
    { name: "GrowthMapService.failureDays (2026-10-09 #1)", shape: /^\s*SELECT DISTINCT to_char\(\(captured_at AT TIME ZONE \$4\)::date, 'YYYY-MM-DD'\) AS metric_date, engine_key\s+FROM answer_captures\b/ },
  ];
  const isExempt = (sql: string): boolean => EXEMPT_READS.some((e) => e.shape.test(sql));

  async function factStatementsFor(cookie: string, path: string): Promise<string[]> {
    const seen: string[] = [];
    const original = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0];
      seen.push(typeof first === "string" ? first : typeof first === "object" && first !== null && "text" in first ? String((first as { text: unknown }).text) : "");
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      const res = await get(cookie, path);
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      spy.mockRestore();
    }
    expect(seen.length, "the trace must have seen the request's statements").toBeGreaterThan(0);
    return seen.filter((sql) => FACT_TABLES.test(sql) && !isExempt(sql));
  }

  for (const route of ["overview", "growth-map", "matrix"] as const) {
    it(`NEW-E-099b AC2 / STORY-099 s14 · GET /portal/${route} issues no statement against answer_captures, mention_facts or citation_facts (query trace)`, async () => {
      const w = await world();
      const t = await token(w, { scope: [w.p1] });
      const offenders = await factStatementsFor(t.cookie, route === "overview" ? "/portal/overview" : `/portal/${route}?project=${w.p1}`);
      expect(offenders.map((sql) => sql.replace(/\s+/g, " ").slice(0, 160))).toEqual([]);
    });
  }

  it("NEW-E-099b AC2 · the trace is real: a statement that names a fact table is caught (control)", async () => {
    const w = await world();
    const t = await token(w, { scope: [w.p1] });
    const seen: string[] = [];
    const original = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      seen.push(String(args[0]));
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      await get(t.cookie, "/portal/overview");
      await harness.db().query("SELECT count(*) FROM answer_captures");
    } finally {
      spy.mockRestore();
    }
    expect(seen.some((sql) => FACT_TABLES.test(sql))).toBe(true);
  });

  it("NEW-E-099b AC2 · the exemption is narrow: it names exactly four reads, and a look-alike or any other fact-table statement is NOT exempt", () => {
    expect(EXEMPT_READS).toHaveLength(4);
    for (const other of [
      "SELECT count(*) FROM answer_captures",
      "SELECT * FROM mention_facts",
      "SELECT * FROM citation_facts WHERE project_id = $1",
      // the competitor panel's own day_cells CTE (same table, different statement) is not the aggregateRange read
      "WITH day_cells AS (\n SELECT c.id, c.engine_key, (c.captured_at AT TIME ZONE $4)::date AS day FROM answer_captures c) SELECT 1",
      // an exempt shape that does not START the statement
      "SELECT 1 FROM mention_facts; WITH measured AS ( SELECT DISTINCT c.engine_key FROM answer_captures c )",
      "SELECT DISTINCT engine_key FROM answer_captures WHERE project_id = $1",
    ]) {
      expect(FACT_TABLES.test(other) && !isExempt(other), other).toBe(true);
    }
  });
});
