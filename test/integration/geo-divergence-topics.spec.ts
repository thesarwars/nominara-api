import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoAnalysisSchema, geoDivergenceDetailSchema, geoTopicsDetailSchema, geoSentimentDetailSchema } from "../../contracts/analytics/index.js";
import { taskGenerationConditionSchema } from "../../contracts/tasks/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { refreshProjectGeo } from "../../src/lib/rollup/refresh-project-geo.js";
import { generateTasksForProject } from "../../src/lib/taskgen/generate.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-061 - A4 divergence, A5 topical authority and the A6 threshold, persisted from stored facts and turned into tasks through the
// migration-0152 rules. Stand-in data: crafted position classes, citations, prominences and alignments (no embedding model is called).
// The connection is the owner role (RLS does not hide the seed); the second workspace proves a project's analysis reads only its own rows.

const AS_OF = new Date("2026-10-01T12:00:00Z"); // 30d window = 2026-09-02 .. 2026-10-01
const IN_WINDOW = "2026-09-20T10:00:00Z";
const METRIC_DATE = "2026-10-01";
const TEXT = "Acme is clunky and the pricing is steep [thread](https://reddit.com/r/crm/1) today.";

describe("STORY-061 - A4 divergence, A5 topics, A6 threshold (persisted, read, tasks)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  const tasks = new TasksService(new NoopRealtimePublisher());

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

  async function seedWorkspace(): Promise<{ ws: string; project: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(`INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Acme',$3,'https://acme.com','acme.com')`, [project, ws, `p-${randomUUID().slice(0, 8)}`]);
    return { ws, project };
  }

  beforeEach(async () => {
    await db.query(
      "TRUNCATE tasks, ref_counters, geo_analyses, citation_facts, mention_facts, answer_captures, geo_alignments, semantic_nodes, project_source_index, source_domains, competitors, tracked_prompts, topic_clusters, credit_ledger, projects, workspaces CASCADE",
    );
    await db.query("UPDATE task_generation_rules SET enabled = false, enabled_since = NULL WHERE code IN ('TG-DIVERGENCE','TG-TOPIC-CONTENT','TG-SENTIMENT-REASON')");
    ({ ws: workspaceId, project: projectId } = await seedWorkspace());
  });

  const as = <T>(fn: (c: Client) => Promise<T>) => withTenantContext(db, { workspaceId, actorId: randomUUID() }, (c) => fn(c as unknown as Client)) as Promise<T>;
  const refresh = () => as((c) => refreshProjectGeo(c, projectId, { asOf: AS_OF }));
  const generate = () => as((c) => generateTasksForProject(c, tasks, { projectId, metricDate: METRIC_DATE }));
  const enable = (code: string) => db.query("UPDATE task_generation_rules SET enabled = true WHERE code = $1", [code]);
  const taskRows = async (rule: string) => (await db.query("SELECT * FROM tasks WHERE rule_code = $1 AND project_id = $2 ORDER BY title", [rule, projectId])).rows;
  const stored = async (analysis: string, days = 30) =>
    (await db.query("SELECT * FROM geo_analyses WHERE project_id = $1 AND analysis = $2 AND window_days = $3", [projectId, analysis, days])).rows[0];
  const read = (slug: "divergence" | "topics" | "sentiment") =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new GeoService(tasks).analysis(projectId, slug, { timeframe: "30d" }));

  async function addPrompt(over: { cluster?: string | null; stability?: number | null; ws?: string; project?: string } = {}): Promise<string> {
    const id = randomUUID();
    const text = `prompt ${id}`;
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, cluster_id, stability_score)
       VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration','active',$6,$7)`,
      [id, over.ws ?? workspaceId, over.project ?? projectId, text, Buffer.from(text, "utf8"), over.cluster ?? null, over.stability === undefined ? 1 : over.stability],
    );
    return id;
  }

  interface Capture {
    prompt: string;
    engine: string;
    demo?: boolean;
    at?: string;
    /** The brand's first-mention position class; null = the brand is not in the answer. */
    brand?: string | null;
    cites?: string[];
    /** Other entities in the answer, with prominence. */
    others?: { type: "competitor" | "other"; id?: string; label: string; prominence: number }[];
    brandProminence?: number;
    sentiment?: { label: "positive" | "neutral" | "negative"; reasons?: string[] };
    answerForm?: string;
    ws?: string;
    project?: string;
  }
  async function capture(a: Capture): Promise<string> {
    const id = randomUUID();
    const ws = a.ws ?? workspaceId;
    const project = a.project ?? projectId;
    const at = a.at ?? IN_WINDOW;
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'api','v1',$8,'\\x00',$9::jsonb,'parsed')`,
      [id, ws, project, randomUUID(), a.prompt, a.engine, at, a.demo === true ? "demo-seed" : "v1", JSON.stringify({ format: "markdown", text: TEXT })],
    );
    const mention = async (type: string, entityId: string | null, label: string, prominence: number, position: string, sentiment: string, reasons: string[], span: boolean, occurrence = 0) =>
      db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_id,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,
           evidence_start,evidence_end,negative_reasons,position_class,answer_form)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,0,4,0,$11,$12,0,0.5,'lexicon',$13,$14,$15::text[],$16,$17)`,
        [ws, project, id, a.prompt, a.engine, at, type, entityId, label, occurrence, prominence, sentiment, span ? 0 : null, span ? 41 : null, reasons, position, a.answerForm ?? null],
      );
    if (a.brand !== null && a.brand !== undefined) {
      const s = a.sentiment ?? { label: "neutral" as const };
      await mention("brand", null, "Acme", a.brandProminence ?? 0.5, a.brand, s.label, s.reasons ?? [], s.label !== "positive" && (s.reasons?.length ?? 0) > 0);
    }
    for (const [i, o] of (a.others ?? []).entries()) await mention(o.type, o.id ?? null, o.label, o.prominence, "ranked", "neutral", [], false, i + 1);
    for (const [slot, domain] of (a.cites ?? []).entries()) {
      const url = `https://${domain}/page`;
      await db.query(
        `INSERT INTO citation_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,slot_index,raw_url,normalized_url,url_hash,domain,source_class,position_weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text,$8::text,sha256(convert_to($8::text,'UTF8')),$9,$10,1)`,
        [ws, project, id, a.prompt, a.engine, at, slot + 1, url, domain, domain === "g2.com" ? "review_marketplace" : "vendor_owned"],
      );
    }
    return id;
  }

  /** n prompts where gemini recommends the brand citing docs.acme.com + g2.com and perplexity omits it, citing g2.com only. */
  async function divergentPrompts(n: number, over: { demo?: boolean; ws?: string; project?: string; stability?: number } = {}): Promise<void> {
    for (let i = 0; i < n; i++) {
      const prompt = await addPrompt({ ...over });
      await capture({ prompt, engine: "gemini", brand: "recommendation", cites: ["docs.acme.com", "g2.com"], ...over });
      await capture({ prompt, engine: "perplexity", brand: null, cites: ["g2.com"], ...over });
    }
  }

  async function weight(domain: string, w: number): Promise<void> {
    const id = randomUUID();
    await db.query("INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$2,$3)", [id, workspaceId, domain]);
    await db.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight, gap_severity)
       VALUES ($1,$2,$3,'all','2026-09-02',30,$4,'none')`,
      [workspaceId, projectId, id, w],
    );
  }

  // ------------------------------------------------------------------------------------------------ the rule rows

  it("[0152] seeds the three rules disabled with a condition the closed grammar accepts, and the retargeted ones keep their cooldowns", async () => {
    const rows = (await db.query("SELECT * FROM task_generation_rules WHERE code IN ('TG-DIVERGENCE','TG-TOPIC-CONTENT','TG-SENTIMENT-REASON','TG-SENTIMENT-NEGATIVE') ORDER BY code")).rows;
    expect(rows.map((r) => r.code)).toEqual(["TG-DIVERGENCE", "TG-SENTIMENT-NEGATIVE", "TG-SENTIMENT-REASON", "TG-TOPIC-CONTENT"]);
    for (const r of rows) {
      expect(r.enabled, r.code).toBe(false);
      expect(taskGenerationConditionSchema.safeParse(r.condition).success, r.code).toBe(true);
    }
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by["TG-DIVERGENCE"].condition).toEqual({ kind: "geo_finding", analysis: "divergence", finding_id_prefix: "divergence-" });
    expect(by["TG-DIVERGENCE"].cooldown_days).toBe(14);
    expect(by["TG-TOPIC-CONTENT"].condition).toEqual({ kind: "geo_finding", analysis: "topics", finding_id_prefix: "topic-gap-" });
    expect(by["TG-TOPIC-CONTENT"].cooldown_days).toBe(30);
    // The cell-rate alert rule is untouched: it still waits for its own evaluator.
    expect(by["TG-SENTIMENT-NEGATIVE"].condition).toEqual({ kind: "pending_analysis", analysis: "negative_cell_rate" });
  });

  // ------------------------------------------------------------------------------------------------ A4 divergence

  it("[#1/#4] ten prompts where one engine recommends and the other omits: persisted, the missing domain named and ranked, read back from the stored row", async () => {
    await weight("docs.acme.com", 0.9);
    await weight("g2.com", 0.4);
    await divergentPrompts(10);
    await refresh();
    expect(await stored("divergence")).toMatchObject({ sufficient: true, evidence_cells: 10 });
    const a = await read("divergence");
    expect(geoAnalysisSchema.safeParse(a).success).toBe(true);
    const d = geoDivergenceDetailSchema.parse(a.detail);
    expect(d.project_divergence).toBe(1);
    expect(d.prompts[0]).toMatchObject({ winning_engine: "gemini", losing_engine: "perplexity", missing_domains: [{ domain: "docs.acme.com", context_weight: expect.closeTo(0.9, 5) }] });
    expect(d.targets[0]).toMatchObject({ losing_engine: "perplexity", domain: "docs.acme.com", prompts: 10 });
    expect(a.summary.score).toBe(1);
  });

  it("[#2] the same disagreement on unstable prompts is discounted", async () => {
    await divergentPrompts(10, { stability: 0.4 });
    await refresh();
    const d = geoDivergenceDetailSchema.parse((await read("divergence")).detail);
    expect(d.project_divergence).toBeCloseTo(0.4, 5);
    expect(d.alert.crossed).toBe(false);
  });

  it("[#3/AC2] a prompt with one live result is excluded, and demo results never count: 9 live + 5 demo prompts is below the minimum", async () => {
    await divergentPrompts(9);
    await divergentPrompts(5, { demo: true });
    const solo = await addPrompt();
    await capture({ prompt: solo, engine: "gemini", brand: "ranked", cites: ["g2.com"] });
    await refresh();
    expect(await stored("divergence")).toMatchObject({ sufficient: false, evidence_cells: 9, score: null });
    expect((await stored("divergence")).suppression_reason).toMatch(/10 prompts.*has 9/);
    expect((await read("divergence")).detail).toBeNull();
  });

  it("[#5/AC5] the divergence finding generates an ENGINE-TARGETED task naming the losing engine and the missing domain, once, and never while the rule is off", async () => {
    await weight("docs.acme.com", 0.9);
    await divergentPrompts(10);
    await refresh();
    await generate();
    expect(await taskRows("TG-DIVERGENCE")).toHaveLength(0); // BUILDER PROPOSAL: disabled until the owner approves it

    await enable("TG-DIVERGENCE");
    await refresh(); // the rule's non-retroactive watermark: a row computed after enabling
    await generate();
    await generate();
    const rows = await taskRows("TG-DIVERGENCE");
    // g2.com is cited by both engines, so exactly one domain is missing: one task, for the engine that lacks it.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_geo_analysis: "divergence", affected_engines: ["perplexity"] });
    expect(rows[0].description).toContain("perplexity");
    expect(rows[0].description).toContain("docs.acme.com");
  });

  it("[AC4] the engine-source affinity map is learned from the project's own live capture history", async () => {
    await divergentPrompts(10);
    const extra = await addPrompt();
    await capture({ prompt: extra, engine: "perplexity", brand: null, cites: ["reddit.com"], demo: true });
    await refresh();
    const d = geoDivergenceDetailSchema.parse((await read("divergence")).detail);
    const px = d.affinity.find((e) => e.engine === "perplexity")!;
    expect(px.answers).toBe(10); // the demo capture is not history
    expect(px.domains).toEqual([{ domain: "g2.com", answers_citing: 10, presence_rate: 1, source_class: "review_marketplace" }]);
    expect(d.affinity.find((e) => e.engine === "gemini")!.domains.map((x) => x.domain)).toEqual(["docs.acme.com", "g2.com"]);
  });

  it("[#6/AC6] the two licensed surfaces are compared on a per-answer basis, never on raw citation counts", async () => {
    await divergentPrompts(10);
    for (const engine of ["google_aio", "google_ai_mode"] as const) {
      const n = engine === "google_aio" ? 2 : 4;
      for (let i = 0; i < n; i++) {
        const p = await addPrompt();
        // ai_mode fans out: three citations of the same domain in one answer must not count three times.
        await capture({ prompt: p, engine, brand: "ranked", cites: engine === "google_aio" ? ["g2.com"] : ["g2.com", "g2.com", "g2.com"] });
      }
    }
    await refresh();
    const d = geoDivergenceDetailSchema.parse((await read("divergence")).detail);
    expect(d.surface_comparison).toEqual({
      status: "normalised",
      engines: ["google_aio", "google_ai_mode"],
      basis: "answers_citing_domain / answers",
      domains: [{ domain: "g2.com", rate_a: 1, rate_b: 1 }],
    });
  });

  it("[#13/#14] below the minimum the row is persisted insufficient with its reason, and running it is free and unmetered", async () => {
    await divergentPrompts(3);
    await refresh();
    expect(await stored("divergence")).toMatchObject({ sufficient: false });
    await read("divergence");
    expect(Number((await db.query("SELECT count(*) FROM credit_ledger")).rows[0].count)).toBe(0);
  });

  it("another workspace's prompts never enter this project's divergence", async () => {
    const other = await seedWorkspace();
    await divergentPrompts(10, { ws: other.ws, project: other.project });
    await divergentPrompts(4);
    await refresh();
    expect(await stored("divergence")).toMatchObject({ sufficient: false, evidence_cells: 4 });
  });

  // ------------------------------------------------------------------------------------------------ A5 topics

  async function cluster(label: string, intent = 0.8): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO topic_clusters (id, workspace_id, project_id, label, commercial_intent) VALUES ($1,$2,$3,$4,$5)", [id, workspaceId, projectId, label, intent]);
    return id;
  }
  async function alignment(clusterId: string, current: number, low: number): Promise<void> {
    await db.query(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, current_alignment, target_band_low, target_band_high)
       VALUES ($1,$2,'https://acme.com/p',$3,ARRAY['gemini'],'stand-in',$4,$5,$6)`,
      [workspaceId, projectId, clusterId, current, low, low + 0.1],
    );
  }
  async function concept(clusterId: string, phrase: string, type: string, ratio: number): Promise<void> {
    await db.query(
      `INSERT INTO semantic_nodes (workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, corpus_doc_ratio, evidence_url, evidence_snippet)
       VALUES ($1,$2,$3,$4,$4,$5,$6,'https://rival.com/pricing','a cited passage')`,
      [workspaceId, projectId, clusterId, phrase, type, ratio],
    );
  }
  /** 15 answers in a cluster where the competitor dominates the brand. */
  async function rivalAnswers(clusterId: string, rivalId: string, n = 15): Promise<void> {
    const prompt = await addPrompt({ cluster: clusterId });
    for (let i = 0; i < n; i++) {
      await capture({ prompt, engine: "gemini", brand: "ranked", brandProminence: 0.2, answerForm: "comparison_table", others: [{ type: "competitor", id: rivalId, label: "Rival", prominence: 0.8 }] });
    }
  }
  async function competitor(): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO competitors (id, workspace_id, project_id, name) VALUES ($1,$2,$3,'Rival')", [id, workspaceId, projectId]);
    return id;
  }

  it("[#7/#8/#9] a dominated winnable topic yields a content task with concepts and structure; an unwinnable one is never recommended", async () => {
    const rival = await competitor();
    const winnable = await cluster("CRM pricing");
    const unwinnable = await cluster("Enterprise security", 1);
    await rivalAnswers(winnable, rival);
    await rivalAnswers(unwinnable, rival);
    await alignment(winnable, 0.62, 0.7);
    await alignment(unwinnable, 0.3, 0.7);
    await concept(winnable, "usage based pricing", "pricing_term", 0.6);
    await concept(winnable, "soc 2", "compliance", 0.4);
    await concept(winnable, "one authors preference", "capability", 0.1); // under the 0.30 requirement line

    await enable("TG-TOPIC-CONTENT");
    await refresh();
    const a = await read("topics");
    expect(geoAnalysisSchema.safeParse(a).success).toBe(true);
    const d = geoTopicsDetailSchema.parse(a.detail);
    const win = d.topics.find((t) => t.cluster_id === winnable)!;
    const no = d.topics.find((t) => t.cluster_id === unwinnable)!;
    expect(win.owner).toMatchObject({ entity_type: "competitor", entity_label: "Rival" });
    expect(win).toMatchObject({ recommended: true, not_recommended_reason: null });
    expect(win.achievability).toBeCloseTo(0.7333, 3);
    expect(no).toMatchObject({ recommended: false, achievability: 0 });
    expect(no.not_recommended_reason).toMatch(/achievab/i);
    expect(d.gaps).toHaveLength(1);
    expect(d.gaps[0]).toMatchObject({ cluster_id: winnable, structure: "comparison_table" });
    expect(d.gaps[0]!.required_concepts.map((c) => c.phrase)).toEqual(["usage based pricing", "soc 2"]);

    await generate();
    await generate();
    const rows = await taskRows("TG-TOPIC-CONTENT");
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toContain("usage based pricing");
    expect(rows[0].description).toContain("comparison_table");
    expect(rows[0]).toMatchObject({ source_geo_analysis: "topics" });
  });

  it("[#8] with no alignment measured, a dominated topic is not recommended and the reason says why", async () => {
    const rival = await competitor();
    const a = await cluster("A");
    const b = await cluster("B");
    await rivalAnswers(a, rival);
    await rivalAnswers(b, rival);
    await refresh();
    const d = geoTopicsDetailSchema.parse((await read("topics")).detail);
    expect(d.topics.every((t) => t.achievability === null && t.gap_priority === null && !t.recommended)).toBe(true);
    expect(d.topics[0]!.not_recommended_reason).toMatch(/alignment/i);
    expect(d.gaps).toEqual([]);
  });

  it("[#13/#14] under 30 answers across 2 topics the row is insufficient with its reason; reading is free", async () => {
    const rival = await competitor();
    await rivalAnswers(await cluster("A"), rival, 10);
    await rivalAnswers(await cluster("B"), rival, 10);
    await refresh();
    expect(await stored("topics")).toMatchObject({ sufficient: false, evidence_cells: 20 });
    expect((await stored("topics")).suppression_reason).toMatch(/30 parsed answers/);
    await read("topics");
    expect(Number((await db.query("SELECT count(*) FROM credit_ledger")).rows[0].count)).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------ A6 threshold and tasks

  async function sentimentFixture(positive: number, negative: { reasons: string[] }[]): Promise<void> {
    const prompt = await addPrompt();
    for (let i = 0; i < positive; i++) await capture({ prompt, engine: "gemini", brand: "ranked", sentiment: { label: "positive" } });
    for (const n of negative) await capture({ prompt, engine: "gemini", brand: "ranked", sentiment: { label: "negative", reasons: n.reasons }, cites: ["reddit.com"] });
  }

  it("[#11] a negative theme past the threshold with the sample floor met: one task per reason class, once", async () => {
    await sentimentFixture(30, [{ reasons: ["pricing_objection"] }, { reasons: ["pricing_objection"] }, { reasons: ["missing_feature"] }]);
    await enable("TG-SENTIMENT-REASON");
    await refresh();
    const d = geoSentimentDetailSchema.parse((await read("sentiment")).detail);
    expect(d.threshold).toMatchObject({ cells: 33, negative_cells: 3, crossed: true });
    await generate();
    await generate();
    const rows = await taskRows("TG-SENTIMENT-REASON");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.description).join(" ")).toMatch(/pricing objection/);
    expect(rows.map((r) => r.description).join(" ")).toMatch(/missing feature/);
  });

  it("[#11] under the threshold the themes are reported but no task and no action is made", async () => {
    await sentimentFixture(40, [{ reasons: ["pricing_objection"] }]);
    await enable("TG-SENTIMENT-REASON");
    await refresh();
    const a = await read("sentiment");
    expect(geoSentimentDetailSchema.parse(a.detail).threshold).toMatchObject({ crossed: false });
    expect(a.actions).toEqual([]);
    await generate();
    expect(await taskRows("TG-SENTIMENT-REASON")).toHaveLength(0);
  });

  it("[A6c] the prior window trends a theme: present before, absent before, and nothing measured before", async () => {
    await sentimentFixture(30, [{ reasons: ["pricing_objection"] }, { reasons: ["pricing_objection"] }, { reasons: ["missing_feature"] }]);
    // The prior window (2026-08-03 .. 2026-09-01): one pricing_objection among 5 answers.
    const prior = await addPrompt();
    await capture({ prompt: prior, engine: "gemini", at: "2026-08-15T10:00:00Z", brand: "ranked", sentiment: { label: "negative", reasons: ["pricing_objection"] } });
    for (let i = 0; i < 4; i++) await capture({ prompt: prior, engine: "gemini", at: "2026-08-15T10:00:00Z", brand: "ranked", sentiment: { label: "positive" } });
    await refresh();
    const d = geoSentimentDetailSchema.parse((await read("sentiment")).detail);
    expect(d.reason_classes.map((r) => [r.reason, r.prior_mention_count])).toEqual([
      ["pricing_objection", 1],
      ["missing_feature", 0],
    ]);
    expect(d.threshold!.prior_negative_cell_rate).toBe(0.2);
  });
});
