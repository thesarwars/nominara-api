import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { renderingQualityResponseSchema } from "../../contracts/analytics/index.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";
import { RenderingQualityService } from "../../src/modules/analytics/rendering-quality.service.js";
import { ScorecardsService } from "../../src/modules/analytics/scorecards.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// NEW-C-11 — rendering quality, real SQL as the real `nominara_app` role under
// RLS. Demo engines (seeded render_attrs) and gemini (real, attribute-free).
describe("NEW-C-11 · RenderingQualityService - real SQL under RLS", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let seq = 0;
  const service = new RenderingQualityService(new ScorecardsService());

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 300_000);
  afterAll(async () => { await container.stop(); });

  beforeEach(async () => {
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);
    seq = 0;
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await db.query(`ALTER ROLE ${role} PASSWORD ${db.escapeLiteral(resolvePassword(role, {}))}`);
    }
    for (const engine of ["google_ai_mode", "google_aio", "gemini"]) {
      await db.query(
        `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,cache_ttl_seconds,volatility_band,min_plan_key,status)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active') ON CONFLICT DO NOTHING`, [engine]);
    }
  });
  afterEach(async () => { await db.end(); });

  async function inTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(),
      user: "nominara_app", password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try { return await withTenantContext(app, context, fn); } finally { await app.end(); }
  }

  async function workspace(timezone = "UTC"): Promise<string> {
    seq += 1;
    return (await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key, timezone) VALUES ($1,$2,'growth',$3) RETURNING id",
      [`W${seq}`, `w-${seq}-${randomUUID()}`, timezone])).rows[0]!.id;
  }
  async function project(ws: string): Promise<{ id: string; prompt: string }> {
    seq += 1;
    const id = (await db.query<{ id: string }>(
      `INSERT INTO projects (workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,$3,'https://e.test','e.test') RETURNING id`,
      [ws, `P${seq}`, `p-${seq}-${randomUUID().slice(0, 6)}`])).rows[0]!.id;
    const prompt = (await db.query<{ id: string }>(
      `INSERT INTO tracked_prompts (workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,'q',sha256('q'::bytea),'recommendation','consideration',false,'active') RETURNING id`, [ws, id])).rows[0]!.id;
    for (const engine of ["google_ai_mode", "google_aio", "gemini"]) {
      await db.query(`INSERT INTO project_engines (workspace_id,project_id,engine_key,enabled,sample_count,weight) VALUES ($1,$2,$3,true,1,1)`, [ws, id, engine]);
    }
    return { id, prompt };
  }
  /** One captured answer with one brand mention carrying `attrs` and `score`. */
  async function mention(ws: string, p: { id: string; prompt: string }, engine: string, attrs: string[], score: number, normalizer = DEMO_SEED_MARKER, status = "parsed", entity = "brand", capturedAt: Date | null = null): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,$6, coalesce($10::timestamptz, now() - interval '2 hours'),'api','1.0.0',$7,$8,'{}'::jsonb,'{}','live',$9,true)`,
      [id, ws, p.id, uuidV7(), p.prompt, engine, normalizer, createHash("sha256").update(id).digest(), status, capturedAt]);
    await db.query(
      `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_id,entity_label,matched_alias,occurrence_index,
          char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_attrs,render_score)
       SELECT workspace_id,project_id,id,prompt_id,engine_key,captured_at,$2,NULL,'P','P',0,0,1,0,1,'positive',0.5,0.9,'lexicon',$3::text[],$4
         FROM answer_captures WHERE id = $1`, [id, entity, attrs, score]);
  }
  async function finding(ws: string, p: { id: string }, rule: string, status = "open", severity = "high"): Promise<string> {
    seq += 1;
    await db.query(
      `INSERT INTO aux_rule_catalog (code,category,title,description,rationale,severity_default,weight,rule_version)
       VALUES ($1,'structured_data','T','D','R','high',0.1,'v1') ON CONFLICT (code) DO NOTHING`, [rule]);
    const audit = (await db.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id,project_id,trigger,target_urls,rule_version,tokenizer,status,aux_score,score_breakdown)
       VALUES ($1,$2,'scheduled',ARRAY['https://e.test/'],'t','none','completed',50,'{}'::jsonb) RETURNING id`, [ws, p.id])).rows[0]!.id;
    return (await db.query<{ id: string }>(
      `INSERT INTO aux_findings (workspace_id,project_id,audit_id,rule_code,url,severity,status,fingerprint,title,evidence,rule_version)
       VALUES ($1,$2,$3,$4,'https://e.test/p',$5,$6,$7,'Offer data absent','{"selector":null,"snippet":null,"measured":null,"expected":null}'::jsonb,'t') RETURNING id`,
      [ws, p.id, audit, rule, severity, status, createHash("sha256").update(`f${seq}${randomUUID()}`).digest()])).rows[0]!.id;
  }
  const ctx = (ws: string): TenantContext => ({ workspaceId: ws, actorId: randomUUID() });
  const read = (ws: string, projectId: string) => inTenant(ctx(ws), () => service.renderingQuality(projectId, { timeframe: "30d" }));
  const find = <T extends { engine_key: string }>(list: T[], key: string) => list.find((e) => e.engine_key === key)!;
  type Cov = { attribute: string; coverage: number | null; cause: { finding_id: string } | null; surface_unavailable: boolean };
  const attr = (e: { attributes: Cov[] }, name: string): Cov => e.attributes.find((a) => a.attribute === name)!;

  it("[NEW-C-11 AC2/AC4] demo engines are computed from seeded render_attrs, gemini is excluded and live, and the response satisfies the contract", async () => {
    const ws = await workspace(); const p = await project(ws);
    await mention(ws, p, "google_ai_mode", ["price", "rating", "image"], 0.66);
    await mention(ws, p, "google_ai_mode", ["image"], 0.16);
    await mention(ws, p, "google_aio", ["image", "link"], 0.22);
    await mention(ws, p, "gemini", ["link"], 0.06, "n1");
    const out = await read(ws, p.id);
    expect(renderingQualityResponseSchema.safeParse(out).success).toBe(true);
    const mode = find(out.engines, "google_ai_mode");
    expect(mode.score).toBeCloseTo(41, 4); // render_score is float4 (real); (0.66 + 0.16) / 2 * 100
    expect(mode.data_source).toBe("demo");
    expect(attr(mode, "price").coverage).toBe(0.5);
    expect(attr(mode, "image").coverage).toBe(1);
    const gemini = find(out.engines, "gemini");
    expect(gemini).toMatchObject({ renders_attributes: false, score: null, mentions_counted: 0, data_source: "live" });
    expect(out.rich_rendering_engines.sort()).toEqual(["google_ai_mode", "google_aio"]);
    expect(out.blended.mentions_counted).toBe(3);
    expect(out.blended.score).toBeCloseTo(31.5, 4); // float4 storage; engine-weighted mean of 41 and 22 (equal weights), the scorecards blend
  });

  it("[NEW-C-11 AC2] a project with no mentions reads score null (not 0) and null coverage", async () => {
    const ws = await workspace(); const p = await project(ws);
    const out = await read(ws, p.id);
    expect(out.blended.score).toBeNull();
    for (const e of out.engines) { expect(e.score).toBeNull(); expect(e.attributes.every((a) => a.coverage === null)).toBe(true); }
  });

  it("[NEW-C-11 AC2] failed captures and competitor mentions are not counted", async () => {
    const ws = await workspace(); const p = await project(ws);
    await mention(ws, p, "google_ai_mode", ["price"], 0.28);
    await mention(ws, p, "google_ai_mode", [], 0, DEMO_SEED_MARKER, "failed");
    await mention(ws, p, "google_ai_mode", [], 0, DEMO_SEED_MARKER, "parsed", "competitor");
    const out = await read(ws, p.id);
    expect(find(out.engines, "google_ai_mode").mentions_counted).toBe(1);
    expect(attr(find(out.engines, "google_ai_mode"), "price").coverage).toBe(1);
  });

  it("[NEW-C-11 AC3] a missing price links to the open mapped finding; a resolved or off-map one does not", async () => {
    const ws = await workspace(); const p = await project(ws);
    await mention(ws, p, "google_ai_mode", [], 0.1); await mention(ws, p, "google_ai_mode", ["price"], 0.28);
    await finding(ws, p, "AUX-R-012", "resolved");
    await finding(ws, p, "AUX-R-008", "open");
    expect(attr(find((await read(ws, p.id)).engines, "google_ai_mode"), "price").cause).toBeNull();
    const open = await finding(ws, p, "AUX-R-012", "open");
    const out = await read(ws, p.id);
    expect(attr(find(out.engines, "google_ai_mode"), "price").cause?.finding_id).toBe(open);
    expect(attr(out.blended, "price").cause?.finding_id).toBe(open);
  });

  it("[NEW-C-11 AC1] tenant isolation as nominara_app: another workspace's project is a 404 and its findings never leak as a cause", async () => {
    const wsA = await workspace(); const wsB = await workspace();
    const a = await project(wsA); const b = await project(wsB);
    await mention(wsA, a, "google_ai_mode", [], 0.1);
    await finding(wsA, a, "AUX-R-012");
    await mention(wsB, b, "google_ai_mode", [], 0.1);
    await expect(read(wsB, a.id)).rejects.toBeInstanceOf(NotFoundError);
    const own = await read(wsB, b.id);
    expect(attr(find(own.engines, "google_ai_mode"), "price").cause).toBeNull();
  });

  // The test above passes on the project predicate alone (wsA's finding is on
  // project a, the read is for b). These rows carry wsB's project id but wsA's
  // workspace id, so the project predicate MATCHES and only RLS excludes them.
  // Planted as the owner (no composite workspace/project FK on these tables).
  it("[NEW-C-11 AC1] RLS alone hides another workspace's finding and mentions that carry this project's id", async () => {
    const wsA = await workspace(); const wsB = await workspace();
    const b = await project(wsB);
    await mention(wsB, b, "google_ai_mode", [], 0.1);
    await finding(wsA, b, "AUX-R-012"); // open, mapped to price, wsA-owned, project b
    await mention(wsA, b, "google_ai_mode", ["price"], 0.28); // wsA-owned, project b
    await mention(wsA, b, "google_ai_mode", ["price"], 0.28);
    const out = await read(wsB, b.id);
    const mode = find(out.engines, "google_ai_mode");
    expect(attr(mode, "price").cause).toBeNull();
    expect(attr(out.blended, "price").cause).toBeNull();
    expect(mode.mentions_counted).toBe(1);
    expect(attr(mode, "price").coverage).toBe(0);
    expect(mode.score).toBeCloseTo(10, 4);
  });

  // Cause link and mention counting are per PROJECT. The tests above put the
  // other project in another workspace, where RLS hides it whatever the
  // predicate says; these two projects share ONE workspace, so only the
  // project predicate separates them.
  it("[NEW-C-11 AC3] a sibling project's open mapped finding in the SAME workspace is never this project's cause", async () => {
    const ws = await workspace();
    const a = await project(ws); const b = await project(ws);
    await mention(ws, a, "google_ai_mode", [], 0.1); // price missing on A
    await finding(ws, b, "AUX-R-012", "open", "critical");
    const own = await read(ws, a.id);
    expect(attr(find(own.engines, "google_ai_mode"), "price").cause).toBeNull();
    expect(attr(own.blended, "price").cause).toBeNull();
    const mineId = await finding(ws, a, "AUX-R-012", "open", "low");
    const withOwn = await read(ws, a.id);
    expect(attr(find(withOwn.engines, "google_ai_mode"), "price").cause?.finding_id).toBe(mineId);
  });

  it("[NEW-C-11 AC2] a sibling project's mentions in the SAME workspace are not counted into this project's coverage", async () => {
    const ws = await workspace();
    const a = await project(ws); const b = await project(ws);
    await mention(ws, a, "google_ai_mode", [], 0.1);
    await mention(ws, b, "google_ai_mode", ["price"], 0.28);
    await mention(ws, b, "google_ai_mode", ["price"], 0.28);
    const mode = find((await read(ws, a.id)).engines, "google_ai_mode");
    expect(mode.mentions_counted).toBe(1);
    expect(attr(mode, "price").coverage).toBe(0);
  });

  it("[NEW-C-11 AC2] only mentions inside the window, in the window's timezone, are counted", async () => {
    const tz = "Pacific/Kiritimati"; // UTC+14: its calendar date runs ahead of UTC's
    const ws = await workspace(tz);
    const p = await project(ws);
    const first = await read(ws, p.id);
    const { from } = first.window;
    expect(first.window.timezone).toBe(tz);
    const at = async (sql: string) =>
      (await db.query<{ t: Date }>(`SELECT ${sql} AS t`, sql.includes("$1") ? [from, tz] : [])).rows[0]!.t;
    // Local 00:01 on the first day: inside by the window's timezone, but the
    // PREVIOUS calendar day in UTC.
    const firstDayLocal = await at("(($1::date)::timestamp + interval '1 minute') AT TIME ZONE $2");
    // Local 23:59 the day before the window: outside by any reading.
    const dayBefore = await at("(($1::date)::timestamp - interval '1 minute') AT TIME ZONE $2");
    const fortyDaysAgo = await at("now() - interval '40 days'");
    await mention(ws, p, "google_ai_mode", ["price"], 0.28, DEMO_SEED_MARKER, "parsed", "brand", firstDayLocal);
    await mention(ws, p, "google_ai_mode", [], 0.1, DEMO_SEED_MARKER, "parsed", "brand", dayBefore);
    await mention(ws, p, "google_ai_mode", [], 0.1, DEMO_SEED_MARKER, "parsed", "brand", fortyDaysAgo);
    const mode = find((await read(ws, p.id)).engines, "google_ai_mode");
    expect(mode.mentions_counted).toBe(1);
    expect(attr(mode, "price").coverage).toBe(1);
  });
});
