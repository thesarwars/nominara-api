import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoEntityDetailSchema } from "../../contracts/analytics/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { normalize } from "../../src/lib/parser/normalize.js";
import { writeEntityNodes, type EntityCheck } from "../../src/lib/geo/entity.js";
import { refreshProjectGeo } from "../../src/lib/rollup/refresh-project-geo.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-060 — A2 entity readiness over stored rows, against a real database. The window is anchored by `asOf`.

const AS_OF = new Date("2026-10-01T12:00:00Z");
const IN_WINDOW = "2026-09-20T10:00:00Z";

const ALL_PRESENT: EntityCheck[] = [
  { node: "wikidata", url: "https://www.wikidata.org/wiki/Q1", missingFields: [] },
  { node: "wikipedia", url: "https://en.wikipedia.org/wiki/Acme", missingFields: ["founded", "headquarters"] },
  { node: "g2", url: "https://www.g2.com/products/acme", missingFields: [] },
  { node: "crunchbase", url: "https://www.crunchbase.com/organization/acme", missingFields: [] },
  { node: "linkedin", url: "https://www.linkedin.com/company/acme", missingFields: [] },
  { node: "github", url: null, missingFields: [] },
  { node: "category_directory", url: "https://directory.example/acme", missingFields: [] },
];
const SAMEAS = ["https://www.wikidata.org/wiki/Q1", "https://linkedin.com/company/acme/"];

describe("STORY-060 · A2 entity readiness (persisted, read)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE geo_analyses, entity_nodes, corpus_passages, answer_captures, mention_facts, competitors, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain,category_slug)
       VALUES ($1,$2,'Notion',$3,'https://notion.so','notion.so','crm')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  const inTx = <T>(fn: (tx: Client) => Promise<T>) => withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => fn(tx as unknown as Client)) as Promise<T>;
  const refresh = () => inTx((tx) => refreshProjectGeo(tx, projectId, { asOf: AS_OF }));
  const read = () => withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new GeoService(new TasksService(new NoopRealtimePublisher())).analysis(projectId, "entity", { timeframe: "30d" }));
  const row = async () => (await db.query("SELECT * FROM geo_analyses WHERE project_id = $1 AND analysis = 'entity' AND window_days = 30", [projectId])).rows[0];

  /**
   * `n` brand name matches. `raw` is the adapter text as stored; offsets are computed against `normalize(raw)`, as the
   * parser does, from the first occurrence of `span` (case-sensitive) in it.
   */
  async function matchesIn(n: number, raw: string, span: string): Promise<void> {
    const start = normalize(raw).indexOf(span);
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
         VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00',$7::jsonb,'parsed')`,
        [id, workspaceId, projectId, randomUUID(), randomUUID(), IN_WINDOW, JSON.stringify({ format: "markdown", text: raw })],
      );
      await db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,position_class,answer_form)
         VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Notion','notion',0,$6,$7,0,0.5,'neutral',0,0.5,'lexicon','recommendation','narrative')`,
        [workspaceId, projectId, id, randomUUID(), IN_WINDOW, start, start + span.length],
      );
    }
  }
  const matches = (n: number, span: string) => matchesIn(n, `We looked at ${span} for teams.`, span);

  it("#5/#6 · with NO profile check recorded, risk is still measured and a high one surfaces the alias task (the score waits)", async () => {
    await matches(26, "Notion");
    await matches(7, "notion"); // 7 of 33 = 21.2%
    await refresh();
    const stored = await row();
    expect(stored).toMatchObject({ sufficient: true, score: null });
    expect(stored.suppression_reason).toMatch(/disambiguation risk is high/iu);
    expect(Number((await db.query("SELECT count(*) FROM entity_nodes")).rows[0].count)).toBe(0);
    const a = await read();
    const detail = geoEntityDetailSchema.parse(a.detail);
    expect(detail.disambiguation).toMatchObject({ level: "high", name_matches: 33, not_about_brand: 7 });
    expect(detail.nodes.every((n) => n.status === "unchecked")).toBe(true);
    expect(detail.authority).toMatchObject({ score: null, suppressed: true });
    expect(a.actions.some((x) => /aliases/iu.test(x.label))).toBe(true);
  });

  it("hazard · raw CRLF, a triple blank line, a zero-width and an astral character before a capitalised mention do not shift its span into a false positive", async () => {
    const raw = "\u{1F680} Launch week\r\n\n\n\u200B\u{1F680}\u{1F680} We like Notion a lot.";
    await matchesIn(30, raw, "Notion");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.disambiguation).toMatchObject({ level: "low", risk: 0, name_matches: 30, not_about_brand: 0 });
  });

  const dropCaptures = (n: number, like: string) =>
    db.query("DELETE FROM answer_captures WHERE id IN (SELECT id FROM answer_captures WHERE project_id = $1 AND payload ->> 'text' LIKE $2 LIMIT $3)", [projectId, like, n]);

  it("a mention whose capture row is gone is still a name match (never a false positive), reported as unjudged and out of the risk denominator", async () => {
    await matches(35, "Notion");
    await dropCaptures(5, "%Notion%");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.disambiguation).toMatchObject({ level: "low", name_matches: 35, unjudged: 5, not_about_brand: 0 });
  });

  it("the 30-match minimum is on JUDGED matches: 30 matches of which 5 are unreadable is unmeasured, never low", async () => {
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await matches(30, "Notion");
    await dropCaptures(5, "%Notion%");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.disambiguation).toMatchObject({ level: "unmeasured", risk: null, name_matches: 30, unjudged: 5 });
  });

  it("hazard · 20 unreadable + 30 readable mentions with 10 false positives is HIGH (10/30), not 0.20 medium over all 50", async () => {
    await matches(10, "notion");
    await matches(20, "Notion");
    await matchesIn(20, "We looked at Notiom for teams.", "Notiom");
    await dropCaptures(20, "%Notiom%");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.disambiguation).toMatchObject({ level: "high", name_matches: 50, unjudged: 20, not_about_brand: 10 });
    expect(detail.disambiguation.risk).toBeCloseTo(1 / 3, 3);
  });

  /** `n` L2-reused capture rows: payload `{}` and a source_result_id, exactly as record-suppressed writes them; the text lives on the source row. */
  async function reusedMatches(n: number, sourceRaw: string, span: string): Promise<void> {
    const sourceId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
       VALUES ($1,$2,$3,$4,$5,'gemini','2026-08-01T10:00:00Z','api','v1','v1','\\x00',$6::jsonb,'parsed')`,
      [sourceId, workspaceId, projectId, randomUUID(), randomUUID(), JSON.stringify({ format: "markdown", text: sourceRaw })],
    );
    const start = normalize(sourceRaw).indexOf(span);
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status,cache_layer,source_result_id)
         VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00','{}'::jsonb,'parsed','l2',$7)`,
        [id, workspaceId, projectId, randomUUID(), randomUUID(), IN_WINDOW, sourceId],
      );
      await db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,position_class,answer_form)
         VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Notion','notion',0,$6,$7,0,0.5,'neutral',0,0.5,'lexicon','recommendation','narrative')`,
        [workspaceId, projectId, id, randomUUID(), IN_WINDOW, start, start + span.length],
      );
    }
  }

  it("hazard · an L2-reused row reads its text from the source row: lowercase 'notion' spans there count as not_about_brand", async () => {
    await matches(20, "Notion");
    await matches(5, "notion");
    await reusedMatches(10, "We looked at notion for teams.", "notion");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.disambiguation).toMatchObject({ name_matches: 35, unjudged: 0, not_about_brand: 15, level: "high" });
  });

  it("hazard · an L2 row whose source_result_id points into ANOTHER project of the same workspace reads no text: its mentions are unjudged, not judged against foreign text", async () => {
    const other = randomUUID();
    await db.query(`INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Other',$3,'https://o.example','o.example')`, [other, workspaceId, `o-${randomUUID().slice(0, 8)}`]);
    const foreign = randomUUID();
    const raw = "We looked at notion for teams.";
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
       VALUES ($1,$2,$3,$4,$5,'gemini','2026-08-01T10:00:00Z','api','v1','v1','\\x00',$6::jsonb,'parsed')`,
      [foreign, workspaceId, other, randomUUID(), randomUUID(), JSON.stringify({ format: "markdown", text: raw })],
    );
    const start = normalize(raw).indexOf("notion");
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status,cache_layer,source_result_id)
         VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00','{}'::jsonb,'parsed','l2',$7)`,
        [id, workspaceId, projectId, randomUUID(), randomUUID(), IN_WINDOW, foreign],
      );
      await db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,position_class,answer_form)
         VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Notion','notion',0,$6,$7,0,0.5,'neutral',0,0.5,'lexicon','recommendation','narrative')`,
        [workspaceId, projectId, id, randomUUID(), IN_WINDOW, start, start + 6],
      );
    }
    await matches(30, "Notion");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await db.query("SELECT findings FROM geo_analyses WHERE project_id=$1 AND analysis='entity' AND window_days=30", [projectId])).rows[0].findings[0].entity);
    expect(detail.disambiguation).toMatchObject({ name_matches: 35, unjudged: 5, not_about_brand: 0 });
  });

  it("no profile check recorded: persisted as insufficient with its reason, and the read has no detail", async () => {
    await refresh();
    expect(await row()).toMatchObject({ sufficient: false, score: null });
    const a = await read();
    expect(a.detail).toBeNull();
    expect(a.summary.status).toBe("insufficient");
  });

  it("#1/#3 · checked nodes are persisted and read back with presence, completeness and the link gap; risk is separate", async () => {
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await matches(30, "Notion");
    await refresh();
    const stored = await row();
    expect(stored.sufficient).toBe(true);
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.nodes.find((n) => n.node === "wikipedia")).toMatchObject({ status: "thin", link_gap: true });
    expect(detail.nodes.find((n) => n.node === "github")).toMatchObject({ status: "absent", presence: 0 });
    expect(detail.nodes.find((n) => n.node === "linkedin")).toMatchObject({ in_brand_sameas: true, link_gap: false });
    expect(detail.disambiguation).toMatchObject({ level: "low", risk: 0 });
    expect(detail.authority.score).toBe(Number(stored.score));
  });

  it("#4 · a high disambiguation risk persists a NULL score and an alias-tuning finding; the read says why", async () => {
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await matches(10, "Notion");
    await matches(20, "notion");
    await refresh();
    const stored = await row();
    expect(stored.score).toBeNull();
    expect(stored.suppression_reason).toMatch(/disambiguation risk is high/iu);
    const a = await read();
    const detail = geoEntityDetailSchema.parse(a.detail);
    expect(detail.authority).toMatchObject({ score: null, suppressed: true });
    expect(a.actions.some((x) => /aliases/iu.test(x.label))).toBe(true);
  });

  it("a recompute replaces the row and a re-check replaces the node (no duplicates)", async () => {
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await refresh();
    await inTx((tx) => writeEntityNodes(tx, projectId, [{ node: "github", url: "https://github.com/acme", missingFields: [] }], SAMEAS));
    await refresh();
    expect(Number((await db.query("SELECT count(*) FROM geo_analyses WHERE project_id=$1 AND analysis='entity' AND window_days=30", [projectId])).rows[0].count)).toBe(1);
    expect(Number((await db.query("SELECT count(*) FROM entity_nodes WHERE project_id=$1", [projectId])).rows[0].count)).toBe(7);
    expect((await db.query("SELECT present FROM entity_nodes WHERE project_id=$1 AND node='github'", [projectId])).rows[0].present).toBe(true);
  });

  it("co-occurrence: counted against the unexpired cited corpus, brand and competitor", async () => {
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await db.query("INSERT INTO competitors (workspace_id,project_id,name,root_domain,aliases) VALUES ($1,$2,'Rival','rival.com','{}')", [workspaceId, projectId]);
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO corpus_passages (workspace_id,project_id,citation_url_hash,url,domain,passage_index,text,token_count,content_hash,embedding_model,expires_at)
         VALUES ($1,$2,$3,'https://x.example/'||$4,'x.example',0,$5,10,$3,'stub',now()+interval '30 days')`,
        [workspaceId, projectId, Buffer.from(`h${i}`), String(i), i < 2 ? "The best CRM is Notion." : i < 8 ? "Rival is a CRM." : "A CRM guide."],
      );
    }
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.cooccurrence).toMatchObject({ sufficient: true, category_passages: 10 });
    expect(detail.cooccurrence.entities.find((e) => e.is_brand)).toMatchObject({ passages: 2, rate: 0.2 });
    expect(detail.cooccurrence.entities.find((e) => e.name === "Rival")).toMatchObject({ passages: 6, rate: 0.6 });
  });

  it("hazard · co-occurrence matches a capitalised alias case-sensitively: the common word 'notion' in a CRM passage is not the brand", async () => {
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO corpus_passages (workspace_id,project_id,citation_url_hash,url,domain,passage_index,text,token_count,content_hash,embedding_model,expires_at)
         VALUES ($1,$2,$3,'https://x.example/'||$4,'x.example',0,$5,10,$3,'stub',now()+interval '30 days')`,
        [workspaceId, projectId, Buffer.from(`c${i}`), String(i), i < 2 ? "The best CRM is Notion." : i < 8 ? "A CRM built on the notion of pipelines." : "A CRM guide."],
      );
    }
    await matches(30, "Notion");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.cooccurrence.entities.find((e) => e.is_brand)).toMatchObject({ passages: 2, rate: 0.2 });
  });

  const passage = (i: number, text: string, expires = "now()+interval '30 days'") =>
    db.query(
      `INSERT INTO corpus_passages (workspace_id,project_id,citation_url_hash,url,domain,passage_index,text,token_count,content_hash,embedding_model,expires_at)
       VALUES ($1,$2,$3,'https://x.example/'||$4,'x.example',0,$5,10,$3,'stub',${expires})`,
      [workspaceId, projectId, Buffer.from(`k${i}-${randomUUID()}`), String(i), text],
    );

  it("hazard · a project whose name is 'Notion' and whose alias list ALSO holds 'notion' keeps the cased spelling: 15 lowercase of 35 matches is HIGH, score withheld", async () => {
    await db.query("UPDATE projects SET brand_aliases = '{notion}' WHERE id = $1", [projectId]);
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await matches(20, "Notion");
    await matches(15, "notion");
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail);
    expect(detail.disambiguation).toMatchObject({ level: "high", name_matches: 35, not_about_brand: 15 });
    expect(detail.authority).toMatchObject({ score: null, suppressed: true });
    expect((await row()).score).toBeNull();
  });

  it("hazard · co-occurrence keeps the casing variants a cased alias is written in (all-caps, title-case) and still excludes the lowercase common word", async () => {
    await db.query("UPDATE projects SET brand_aliases = '{HubSpot}' WHERE id = $1", [projectId]);
    await db.query("INSERT INTO competitors (workspace_id,project_id,name,root_domain,aliases) VALUES ($1,$2,'Salesforce','sf.example','{}')", [workspaceId, projectId]);
    const texts = [
      "SALESFORCE leads the CRM market.", "SALESFORCE CRM pricing.", "Salesforce is a CRM.", // 3 competitor passages (caps, caps, exact)
      "The salesforce of a CRM team.", // lowercase common word: not the competitor
      "HUBSPOT CRM.", "Hubspot CRM.", // 2 brand passages (caps, title-case); HubSpot spelling not present
      "A CRM guide.", "A CRM guide.", "A CRM guide.", "A CRM guide.",
    ];
    for (const [i, t] of texts.entries()) await passage(i, t);
    await refresh();
    const detail = geoEntityDetailSchema.parse((await db.query("SELECT findings FROM geo_analyses WHERE project_id=$1 AND analysis='entity' AND window_days=30", [projectId])).rows[0].findings[0].entity);
    expect(detail.cooccurrence.entities.find((e) => e.name === "Salesforce")?.passages).toBe(3);
    expect(detail.cooccurrence.entities.find((e) => e.is_brand)?.passages).toBe(2);
  });

  it("hazard · the unexpired corpus is read AS OF the transaction: a passage that expires mid-refresh is still counted, so a recompute of one instant is reproducible", async () => {
    await inTx(async (tx) => {
      for (let i = 0; i < 10; i++) await db.query(`INSERT INTO corpus_passages (workspace_id,project_id,citation_url_hash,url,domain,passage_index,text,token_count,content_hash,embedding_model,expires_at)
         VALUES ($1,$2,$3,'https://x.example/'||$4,'x.example',0,'A CRM guide.',10,$3,'stub',now()+interval '1 second')`, [workspaceId, projectId, Buffer.from(`e${i}`), String(i)]);
      await tx.query("SELECT pg_sleep(1.6)");
      await refreshProjectGeo(tx, projectId, { asOf: AS_OF });
    });
    const detail = geoEntityDetailSchema.parse((await read()).detail ?? (await row()).findings[0].entity);
    expect(detail.cooccurrence.category_passages).toBe(10);
  });

  it("#11 · free and unmetered: no credit ledger entry", async () => {
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await refresh();
    await read();
    expect(Number((await db.query("SELECT count(*) FROM credit_ledger")).rows[0].count)).toBe(0);
  });

  it("a project that does not exist is a not_found on a node write", async () => {
    await expect(inTx((tx) => writeEntityNodes(tx, randomUUID(), ALL_PRESENT, SAMEAS))).rejects.toMatchObject({ code: "not_found" });
  });

  it("hazard · non-ASCII brand alias, competitor, vertical and symbol-edged aliases do not abort the refresh, and they match", async () => {
    await db.query("UPDATE projects SET brand_aliases = '{Café Müller,.NET Hub}', verticals = '{Ünïcode Küche,C++ tools}' WHERE id = $1", [projectId]);
    await db.query("INSERT INTO competitors (workspace_id,project_id,name,root_domain,aliases) VALUES ($1,$2,'Яндекс','ya.example','{東京 Ltd}')", [workspaceId, projectId]);
    const texts = ["Café Müller leads Ünïcode Küche.", "Яндекс and 東京 Ltd are rivals in Ünïcode Küche.", "Try .NET Hub for C++ tools.", "ASP.NET Hub is unrelated to C++ tools."];
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO corpus_passages (workspace_id,project_id,citation_url_hash,url,domain,passage_index,text,token_count,content_hash,embedding_model,expires_at)
         VALUES ($1,$2,$3,'https://x.example/'||$4,'x.example',0,$5,10,$3,'stub',now()+interval '30 days')`,
        [workspaceId, projectId, Buffer.from(`u${i}`), String(i), texts[i % 4]],
      );
    }
    await refresh();
    const detail = geoEntityDetailSchema.parse((await read()).detail ?? (await row()).findings[0].entity);
    expect(detail.cooccurrence.category_passages).toBe(10);
    // Brand: "Café Müller" in passages 0,4,8 and ".NET Hub" in 2,6 (not inside "ASP.NET Hub" at 3,7) = 5.
    expect(detail.cooccurrence.entities.find((e) => e.is_brand)?.passages).toBe(5);
    expect(detail.cooccurrence.entities.find((e) => e.name === "Яндекс")?.passages).toBe(3);
  });
});
