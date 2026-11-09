import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { SUBSTITUTION_CO_MOVEMENT_COPY } from "../../contracts/attribution/index.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createAttributionRollupHandler } from "../../src/lib/queue/handlers/attribution-rollup.handler.js";
import { QUEUE_HANDLERS } from "../../src/lib/queue/handlers.js";
import { URL_NORMALISATION_VERSION } from "../../src/lib/attribution/url-normalisation.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-114 - the `attribution.rollup` job, on a real Postgres. Scenario numbers are the story's Test scenarios table.
// Window layout for START = 2026-10-15, 7 days: current 2026-10-15..21, prior 2026-10-08..14.

const START = "2026-10-15";
const PAGE = "https://shop.example.com/guide";

describe("STORY-114 - attribution rollup", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db, MIGRATIONS_DIR);
  }, 300_000);
  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE notification_emails, notifications, attribution_url_rollup, attribution_daily, gsc_daily, gsc_connections, citation_facts, projects, workspace_members, users, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    otherWorkspaceId = randomUUID();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [id, `w-${id.slice(0, 8)}`]);
    }
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Shop',$3,'https://shop.example.com','shop.example.com')", [projectId, workspaceId, `p-${projectId.slice(0, 8)}`]);
  });

  const day = (date: string, offset: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

  async function cite(url: string, date: string, n = 1, owned = true): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await db.query(
        `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain, is_owned, position_weight)
         VALUES ($1,$2,$3,$4,'gemini',$5,$6,$7::text,$7::text,sha256(convert_to($7::text,'UTF8')),'shop.example.com',$8,1)`,
        [workspaceId, projectId, uuidV7(), uuidV7(), `${date}T10:00:00Z`, i, url, owned],
      );
    }
  }
  async function sessions(url: string, date: string, count: number, opts: { conversions?: number; referrer?: string } = {}): Promise<void> {
    await db.query(
      `INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, sessions, conversions, country, device)
       VALUES ($1,$2,$3,sha256(convert_to($4::text,'UTF8')),$4::text,$5,$6,$7,'ZZ','desktop')`,
      [workspaceId, projectId, date, url, opts.referrer ?? "chatgpt", count, opts.conversions ?? 0],
    );
  }
  async function connectSearchConsole(): Promise<void> {
    await db.query("INSERT INTO gsc_connections (workspace_id, project_id, property_url, property_type, credentials_enc, dek_id, scopes) VALUES ($1,$2,'sc-domain:shop.example.com','domain','x','k',ARRAY['readonly'])", [workspaceId, projectId]);
  }
  async function search(report: "ai_surface" | "classic", url: string, date: string, figures: { impressions?: number; clicks?: number }): Promise<void> {
    await db.query(
      `INSERT INTO gsc_daily (workspace_id, project_id, metric_date, report, dimension, page_url, page_url_hash, query_hash, impressions, clicks, country, device)
       VALUES ($1,$2,$3,$4,'page',$5::text,sha256(convert_to($5::text,'UTF8')),'\\x','${String(figures.impressions ?? 0)}','${String(figures.clicks ?? 0)}','ZZ','desktop')`,
      [workspaceId, projectId, date, report, url],
    );
  }

  const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
  const job = (payload: Record<string, unknown>): Job => ({ id: randomUUID(), data: { payload: { workspaceId, kid: "test-kid", projectId, ...payload } } }) as unknown as Job;
  async function run(payload: Record<string, unknown> = { windowStart: START, windowDays: 7 }): Promise<void> {
    const handler = createAttributionRollupHandler(context);
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job(payload)));
    await new Promise((resolve) => setImmediate(resolve));
  }
  const rollup = async (windowStart = START, windowDays = 7) =>
    (await db.query("SELECT * FROM attribution_url_rollup WHERE project_id = $1 AND window_start = $2 AND window_days = $3 ORDER BY landing_url", [projectId, windowStart, windowDays])).rows as Array<Record<string, unknown>>;

  it("STORY-114 S1 - joins citations, sessions, conversions, impressions and clicks per URL per window", async () => {
    await connectSearchConsole();
    await cite(PAGE, day(START, 1), 6);
    await cite(PAGE, day(START, -3), 4);
    await cite("https://other.example.org/x", day(START, 1), 9, false); // not owned: not a citation of this brand's page
    await sessions(PAGE, day(START, 2), 100, { conversions: 5 });
    await sessions(PAGE, day(START, 3), 20, { conversions: 1 });
    await sessions(PAGE, day(START, 3), 500, { referrer: "unattributed_direct", conversions: 9 }); // the honest floor: not an AI session
    await search("ai_surface", PAGE, day(START, 2), { impressions: 900 });
    await search("classic", PAGE, day(START, 2), { clicks: 35 });
    await run();
    const rows = await rollup();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ citations: 6, citations_prior: 4, ai_sessions: 120, conversions: 6, gsc_ai_impressions: 900, organic_clicks: 35, pattern: "dual_visibility" });
    expect(Buffer.from(rows[0]!.landing_url_hash as Buffer).length).toBe(32);
  });

  it("STORY-114 S2 - trailing-slash, case, port, tracking and www variants on both sides join to one row", async () => {
    await cite("https://shop.example.com/guide/", day(START, 1), 2);
    await cite("https://SHOP.example.com:443/guide?utm_source=chatgpt.com", day(START, 1), 3);
    await sessions("https://www.shop.example.com/guide", day(START, 2), 70, { conversions: 3 });
    await sessions("https://shop.example.com/guide#a", day(START, 3), 50, { conversions: 3 });
    await run();
    const rows = await rollup();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ landing_url: PAGE, citations: 5, ai_sessions: 120, conversions: 6 });
  });

  it("STORY-114 S4 - a rebuild re-keys from the URL strings and removes rows built under an older key", async () => {
    expect(URL_NORMALISATION_VERSION).toBeGreaterThanOrEqual(1);
    await cite(PAGE, day(START, 1), 2);
    await run();
    // A row an earlier normalisation keyed differently, in a window the next ordinary run does not touch.
    await db.query(
      `INSERT INTO attribution_url_rollup (workspace_id, project_id, window_start, window_days, landing_url_hash, landing_url, pattern) VALUES ($1,$2,'2026-09-01',30,'\\xdeadbeef',$3,'insufficient_data')`,
      [workspaceId, projectId, `${PAGE}/`],
    );
    await run({ windowStart: START, windowDays: 7 });
    expect((await db.query("SELECT 1 FROM attribution_url_rollup WHERE landing_url_hash = '\\xdeadbeef'")).rowCount).toBe(1);
    await run({ rebuild: true, windowStart: START, windowDays: 7 });
    expect((await db.query("SELECT 1 FROM attribution_url_rollup WHERE landing_url_hash = '\\xdeadbeef'")).rowCount).toBe(0);
    expect(await rollup()).toHaveLength(1);
  });

  it("STORY-114 S5 - the prior window's citations and sessions sit in the same row", async () => {
    await cite(PAGE, day(START, 1), 2);
    await cite(PAGE, day(START, -2), 7);
    await sessions(PAGE, day(START, 1), 40);
    await sessions(PAGE, day(START, -2), 90);
    await run();
    expect((await rollup())[0]).toMatchObject({ citations: 2, citations_prior: 7, ai_sessions: 40, ai_sessions_prior: 90 });
  });

  it("STORY-114 S6 - conversion rate is null on zero sessions and a real zero on sessions without conversions", async () => {
    await cite(PAGE, day(START, 1), 2);
    await cite("https://shop.example.com/pricing", day(START, 1), 2);
    await sessions("https://shop.example.com/pricing", day(START, 1), 40, { conversions: 0 });
    await run();
    const byUrl = new Map((await rollup()).map((r) => [r.landing_url as string, r]));
    expect(byUrl.get(PAGE)!.cvr).toBeNull();
    expect(byUrl.get("https://shop.example.com/pricing")!.cvr).toBe(0);
  });

  it("STORY-114 S7 - with no window named, all three documented lengths are built in one job", async () => {
    // Windows default to the ones ending yesterday (the workspace is UTC), so the fixture is dated from the real clock.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await cite(PAGE, yesterday, 2);
    await run({});
    const lengths = (await db.query("SELECT DISTINCT window_days FROM attribution_url_rollup WHERE project_id = $1 ORDER BY window_days", [projectId])).rows.map((r) => r.window_days);
    expect(lengths).toEqual([7, 30, 90]);
  });

  it("STORY-114 S8 - recomputing twice leaves the same rows, keyed by project, window start, window length and URL", async () => {
    await cite(PAGE, day(START, 1), 3);
    await sessions(PAGE, day(START, 1), 50, { conversions: 2 });
    await run();
    const first = await rollup();
    await run();
    const second = await rollup();
    expect(second).toHaveLength(first.length);
    const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ computed_at: _c, ...rest }) => rest);
    expect(strip(second)).toEqual(strip(first));
    // A URL that vanished from the sources is gone on the next recompute rather than left behind.
    await db.query("DELETE FROM citation_facts WHERE project_id = $1", [projectId]);
    await db.query("DELETE FROM attribution_daily WHERE project_id = $1", [projectId]);
    await run();
    expect(await rollup()).toHaveLength(0);
  });

  it("STORY-114 S12 / S15 - citations up with sessions down is stored as the substitution candidate; a URL that went absent is a row classed invisible", async () => {
    await cite(PAGE, day(START, 1), 9);
    await cite(PAGE, day(START, -2), 5);
    await sessions(PAGE, day(START, 1), 60);
    await sessions(PAGE, day(START, -2), 100);
    await sessions("https://shop.example.com/old", day(START, -2), 5); // present last window, absent now
    await run();
    const byUrl = new Map((await rollup()).map((r) => [r.landing_url as string, r]));
    expect(byUrl.get(PAGE)!.pattern).toBe("ai_substitution_candidate");
    expect(byUrl.get("https://shop.example.com/old")).toMatchObject({ pattern: "invisible_both", citations: 0, ai_sessions: 0, ai_sessions_prior: 5 });
  });

  it("STORY-114 S16 - with Search Console unconnected the columns are null and no AI-only claim is made; connected-and-empty is a measured zero", async () => {
    await cite(PAGE, day(START, 1), 2);
    await sessions(PAGE, day(START, 1), 45);
    await run();
    expect((await rollup())[0]).toMatchObject({ gsc_ai_impressions: null, organic_clicks: null, pattern: "dual_visibility" });
    await connectSearchConsole();
    await run();
    expect((await rollup())[0]).toMatchObject({ gsc_ai_impressions: 0, organic_clicks: 0, pattern: "ai_only" });
  });

  it("STORY-114 S17 - every stored figure is a measured count; the prior window is never copied into the current one", async () => {
    await cite(PAGE, day(START, -2), 8);
    await sessions(PAGE, day(START, -2), 80, { conversions: 4 });
    await run();
    expect((await rollup())[0]).toMatchObject({ citations: 0, citations_prior: 8, ai_sessions: 0, ai_sessions_prior: 80, conversions: 0, cvr: null });
    const types = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'attribution_url_rollup' AND column_name IN ('citations','citations_prior','ai_sessions','ai_sessions_prior','conversions','gsc_ai_impressions','organic_clicks')`,
    );
    expect(types.rows.every((r) => r.data_type === "integer")).toBe(true);
  });

  it("STORY-114 - the job writes only the rollup and the alert, and reads no per-visitor data (there is none to read)", async () => {
    await cite(PAGE, day(START, 1), 2);
    await sessions(PAGE, day(START, 1), 45);
    const statements: string[] = [];
    const originalQuery = db.query.bind(db) as (...args: unknown[]) => Promise<unknown>;
    (db as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      statements.push(typeof first === "string" ? first : (first as { text: string }).text);
      return originalQuery(...args);
    };
    try {
      await run();
    } finally {
      (db as unknown as { query: unknown }).query = originalQuery;
    }
    const writes = statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));
    expect(writes.length).toBeGreaterThan(0);
    for (const sql of writes) expect(sql).toMatch(/attribution_url_rollup|notifications|notification_emails/);
    const reads = statements.join("\n");
    expect(reads).not.toMatch(/\b(visitor|session_id|cookie|ip_address|user_agent)\b/i);
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('attribution_daily','attribution_url_rollup')")).rows.map((r) => r.column_name as string);
    expect(columns.filter((c) => /visitor|cookie|fingerprint|ip|agent/i.test(c) && c !== "ingested_at")).toEqual([]);
  });

  it("STORY-114 S18 - only the rollup is portal-readable; the daily table is not", async () => {
    const policies = (await db.query("SELECT tablename, policyname, roles::text AS roles FROM pg_policies WHERE tablename IN ('attribution_url_rollup','attribution_daily','attribution_configs')")).rows;
    const portal = (table: string) => policies.filter((p) => p.tablename === table && /portal/.test(`${p.policyname as string}${p.roles as string}`));
    expect(portal("attribution_url_rollup").length).toBeGreaterThan(0);
    expect(portal("attribution_daily")).toEqual([]);
    expect(portal("attribution_configs")).toEqual([]);
  });

  describe("S19 - the substitution alert goes through the existing catalog", () => {
    /** Consecutive weeks: citations rise while AI sessions fall, so two windows in a row can be candidates. */
    async function decline(weeks: readonly { offsetDays: number; citations: number; sessions: number }[]): Promise<void> {
      for (const week of weeks) {
        await cite(PAGE, day(START, week.offsetDays + 1), week.citations);
        await sessions(PAGE, day(START, week.offsetDays + 1), week.sessions);
      }
    }
    const alerts = async () => (await db.query("SELECT * FROM notifications WHERE kind = 'alert.ai_substitution' ORDER BY created_at")).rows;

    it("a URL that is a candidate in 2 consecutive windows raises one warning alert from the catalog, with the co-movement copy and a link to the attribution section", async () => {
      await decline([{ offsetDays: -14, citations: 2, sessions: 200 }, { offsetDays: -7, citations: 5, sessions: 100 }, { offsetDays: 0, citations: 9, sessions: 60 }]);
      await run();
      const raised = await alerts();
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ severity: "warning", project_id: projectId });
      expect(raised[0]!.body).toBe(SUBSTITUTION_CO_MOVEMENT_COPY);
      expect(raised[0]!.payload.deep_link.path).toBe(`/p/${projectId}/attribution`);
      await run();
      expect(await alerts()).toHaveLength(1); // idempotent by event key and inside its 14-day cooldown
    });

    it("a single candidate window raises nothing", async () => {
      await decline([{ offsetDays: -7, citations: 5, sessions: 100 }, { offsetDays: 0, citations: 9, sessions: 60 }]);
      await run();
      expect((await rollup())[0]!.pattern).toBe("ai_substitution_candidate");
      expect(await alerts()).toHaveLength(0);
    });
  });

  it("STORY-114 - the queue has a handler, so the registrar no longer refuses it", () => {
    expect(QUEUE_HANDLERS["attribution.rollup"]).toBeDefined();
  });

  it("STORY-114 - another workspace's data never reaches this project's rollup", async () => {
    const foreignProject = randomUUID();
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'X',$3,'https://shop.example.com','shop.example.com')", [foreignProject, otherWorkspaceId, `p-${foreignProject.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, sessions, conversions, country, device) VALUES ($1,$2,$3,sha256(convert_to($4::text,'UTF8')),$4::text,'chatgpt',999,0,'ZZ','desktop')`,
      [otherWorkspaceId, foreignProject, day(START, 1), PAGE],
    );
    await cite(PAGE, day(START, 1), 1);
    await run();
    expect((await rollup())[0]).toMatchObject({ ai_sessions: 0 });
  });
});
