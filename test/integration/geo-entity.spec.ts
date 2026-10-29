import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoEntityDetailSchema } from "../../contracts/analytics/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
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

  /** `n` brand name matches whose stored span is `span`. */
  async function matches(n: number, span: string): Promise<void> {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const text = `We looked at ${span} for teams.`;
      await db.query(
        `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
         VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00',$7::jsonb,'parsed')`,
        [id, workspaceId, projectId, randomUUID(), randomUUID(), IN_WINDOW, JSON.stringify({ format: "markdown", text })],
      );
      await db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,position_class,answer_form)
         VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Notion','notion',0,13,$6,0,0.5,'neutral',0,0.5,'lexicon','recommendation','narrative')`,
        [workspaceId, projectId, id, randomUUID(), IN_WINDOW, 13 + span.length],
      );
    }
  }

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

  it("#11 · free and unmetered: no credit ledger entry", async () => {
    await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, SAMEAS));
    await refresh();
    await read();
    expect(Number((await db.query("SELECT count(*) FROM credit_ledger")).rows[0].count)).toBe(0);
  });

  it("a project that does not exist is a not_found on a node write", async () => {
    await expect(inTx((tx) => writeEntityNodes(tx, randomUUID(), ALL_PRESENT, SAMEAS))).rejects.toMatchObject({ code: "not_found" });
  });
});
