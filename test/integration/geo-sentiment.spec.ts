import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoAnalysisSchema, geoSentimentDetailSchema } from "../../contracts/analytics/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { refreshProjectGeo } from "../../src/lib/rollup/refresh-project-geo.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-061 — A6 sentiment drivers over stored mention_facts + citation_facts,
// against a real database.

const AS_OF = new Date("2026-10-01T12:00:00Z"); // 30d window = 2026-09-02 .. 2026-10-01
const IN_WINDOW = "2026-09-20T10:00:00Z";
const OUTSIDE = "2026-06-01T10:00:00Z";
const TEXT = "Acme is clunky and the pricing is steep [thread](https://reddit.com/r/crm/1) today.";

describe("STORY-061 · A6 sentiment drivers (persisted, read)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE geo_analyses, citation_facts, mention_facts, answer_captures, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    projectId = randomUUID();
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://acme.com','acme.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  interface Mention {
    engine?: string;
    at?: string;
    label?: "positive" | "neutral" | "negative";
    reasons?: string[];
    span?: [number, number] | null;
    cite?: string | null;
    demo?: boolean;
    entity?: "brand" | "competitor";
  }
  async function mention(a: Mention = {}): Promise<string> {
    const id = randomUUID();
    const at = a.at ?? IN_WINDOW;
    const engine = a.engine ?? "gemini";
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'api','v1',$8,'\\x00',$9::jsonb,'parsed')`,
      [id, workspaceId, projectId, randomUUID(), randomUUID(), engine, at, a.demo === true ? "demo-seed" : "v1", JSON.stringify({ format: "markdown", text: TEXT })],
    );
    const span = a.span === undefined ? [0, 41] : a.span;
    await db.query(
      `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
         occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,
         evidence_start,evidence_end,negative_reasons,position_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Acme','Acme',0,0,4,0,0.5,$8,0,0.5,'lexicon',$9,$10,$11::text[],'neutral_list')`,
      [workspaceId, projectId, id, randomUUID(), engine, at, a.entity ?? "brand", a.label ?? "negative", span?.[0] ?? null, span?.[1] ?? null, a.reasons ?? ["complaint_thread_cited"]],
    );
    if (a.cite !== null) {
      const url = a.cite ?? "https://reddit.com/r/crm/1";
      await db.query(
        `INSERT INTO citation_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,slot_index,raw_url,normalized_url,url_hash,domain,position_weight)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7::text,$7::text,sha256(convert_to($7::text,'UTF8')),$8,1)`,
        [workspaceId, projectId, id, randomUUID(), engine, at, url, new URL(url).hostname],
      );
    }
    return id;
  }
  const many = async (n: number, a: Mention = {}) => {
    for (let i = 0; i < n; i++) await mention(a);
  };

  const ctx = <T>(fn: (s: GeoService) => Promise<T>) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => fn(new GeoService(new TasksService(new NoopRealtimePublisher())))) as Promise<T>;
  const refresh = () => withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => refreshProjectGeo(tx, projectId, { asOf: AS_OF }));
  const rows = async () => (await db.query("SELECT * FROM geo_analyses WHERE analysis = 'sentiment' ORDER BY window_days")).rows;
  const read = () => ctx((s) => s.analysis(projectId, "sentiment", { timeframe: "30d" }));

  it("#10 · negative mentions across two engines citing one thread are one cluster, read back from the stored row", async () => {
    await many(30, { label: "positive", cite: null });
    await many(2, { engine: "gemini" });
    await mention({ engine: "claude", demo: true });
    await refresh();
    const [r] = (await rows()).filter((x) => x.window_days === 30);
    expect(r).toMatchObject({ sufficient: true, score: null, evidence_cells: 33 });
    const a = await read();
    expect(geoAnalysisSchema.safeParse(a).success).toBe(true);
    const d = geoSentimentDetailSchema.parse(a.detail);
    expect(d.non_positive_mentions).toBe(3);
    expect(d.clusters).toEqual([expect.objectContaining({ domain: "reddit.com", mention_count: 3, engine_count: 2 })]);
    expect(d.data_source).toBe("mixed");
    expect(d.mentions[0]).toMatchObject({ evidence_start: 0, evidence_end: 41, evidence_text: TEXT.slice(0, 41), factual_error: false });
    expect(a.summary).toMatchObject({ status: "ready", verdict: "action", score: null });
  });

  it("#11 · one action per distinct reason class, a title and no task id", async () => {
    await many(30, { label: "positive", cite: null });
    await many(2, { reasons: ["pricing_objection"] });
    await mention({ reasons: ["missing_feature"] });
    await refresh();
    const a = await read();
    expect(a.actions).toHaveLength(2);
    expect(a.actions.every((x) => x.task_id === null && typeof x.task_title === "string" && x.task_title.length > 0)).toBe(true);
  });

  it("only non-positive BRAND mentions with a span, in the window, are drivers; positive, competitor, unevidenced and outside-window are not", async () => {
    await many(30, { label: "positive", cite: null });
    await mention({ entity: "competitor" });
    await mention({ span: null });
    await mention({ at: OUTSIDE });
    await mention({ label: "neutral", reasons: [] });
    await refresh();
    const d = geoSentimentDetailSchema.parse((await read()).detail);
    expect(d.non_positive_mentions).toBe(1);
    expect(d.mentions[0]!.label).toBe("neutral");
    expect(d.brand_mentions).toBe(32); // 30 positive + the unevidenced + the neutral; competitor and outside-window do not count
  });

  it("#13 · below 30 brand mentions the row is persisted insufficient with its reason and the read has no detail", async () => {
    await many(29, { label: "positive", cite: null });
    await refresh();
    const a = await read();
    expect(a.summary).toMatchObject({ status: "insufficient", score: null });
    expect(a.detail).toBeNull();
    expect((await rows()).find((x) => x.window_days === 30)).toMatchObject({ sufficient: false, evidence_cells: 29 });
  });

  it("a READ never recomputes: facts changed after the rollup do not change the detail until the next rollup", async () => {
    await many(30, { label: "positive", cite: null });
    await many(2);
    await refresh();
    const before = (await read()).detail;
    await many(5, { engine: "claude" });
    await db.query("UPDATE mention_facts SET sentiment_label = 'positive'");
    expect((await read()).detail).toEqual(before);
    await refresh();
    expect(geoSentimentDetailSchema.parse((await read()).detail).non_positive_mentions).toBe(0);
  });

  it("a recompute of the same window replaces rather than accumulates", async () => {
    await many(30, { label: "positive", cite: null });
    await refresh();
    await refresh();
    expect((await rows()).filter((x) => x.window_days === 30)).toHaveLength(1);
  });

  it("an empty window is persisted as insufficient with zero cells, not skipped", async () => {
    await refresh();
    expect((await rows()).find((x) => x.window_days === 30)).toMatchObject({ sufficient: false, evidence_cells: 0 });
  });

  it("#14 · free and unmetered: no credit ledger entry", async () => {
    await many(30, { label: "positive", cite: null });
    await refresh();
    await read();
    expect(Number((await db.query("SELECT count(*) FROM credit_ledger")).rows[0].count)).toBe(0);
  });
});
