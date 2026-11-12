import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { refreshProjectTopicClusters } from "../../src/lib/rollup/refresh-project-topic-clusters.js";
import { visibilityScore } from "../../src/lib/scoring/index.js";
import { TopicsService } from "../../src/modules/prompts/topics.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { asTenantJob } from "../support/tenant-job.js";

// STORY-188 - the rollup refreshes every denormalised column of `topic_clusters` (visibility_score, authority_rank, leader_entity_id,
// gap_priority, achievability, computed_at) from the stored facts, through the scoring library and the A5 code; reads serve the stored
// columns. Stand-in data: crafted cells, mentions and alignments (no embedding model is called).
// The connection is the owner role (RLS does not hide the seed); the second workspace proves a refresh touches only its own project.

const AS_OF = new Date("2026-10-01T12:00:00Z"); // 30d window = 2026-09-02 .. 2026-10-01
const IN_WINDOW = "2026-09-20T10:00:00Z";
const TIMEZONE = "UTC";

describe("STORY-188 - topic cluster performance refreshed by the rollup", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let competitorId: string;

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
      "TRUNCATE task_verifications, milestones, tasks, ref_counters, corpus_passages, geo_alignments, semantic_nodes, citation_facts, mention_facts, answer_captures, competitors, tracked_prompts, topic_clusters, projects, workspaces CASCADE",
    );
    ({ ws: workspaceId, project: projectId } = await seedWorkspace());
    competitorId = randomUUID();
    await db.query("INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source) VALUES ($1,$2,$3,'Rival','rival.com',ARRAY[]::text[],'user')", [competitorId, workspaceId, projectId]);
  });

  const refresh = (project = projectId, ws = workspaceId) => withTenantContext(db, { workspaceId: ws, actorId: randomUUID() }, (tx) => refreshProjectTopicClusters(tx, project, TIMEZONE, { asOf: AS_OF }));
  const cluster = async (label: string, over: { ws?: string; project?: string } = {}): Promise<string> => {
    const id = randomUUID();
    await db.query("INSERT INTO topic_clusters (id, workspace_id, project_id, label) VALUES ($1,$2,$3,$4)", [id, over.ws ?? workspaceId, over.project ?? projectId, label]);
    return id;
  };
  const row = async (id: string) => (await db.query("SELECT visibility_score::float8 AS v, authority_rank, leader_entity_id, gap_priority, achievability, computed_at, updated_at FROM topic_clusters WHERE id = $1", [id])).rows[0]!;

  async function addPrompt(clusterId: string | null, over: { deleted?: boolean; ws?: string; project?: string } = {}): Promise<string> {
    const id = randomUUID();
    const text = `prompt ${id}`;
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, cluster_id, deleted_at)
       VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration','active',$6,$7)`,
      [id, over.ws ?? workspaceId, over.project ?? projectId, text, Buffer.from(text, "utf8"), clusterId, over.deleted === true ? new Date() : null],
    );
    return id;
  }

  /** One parsed answer. `brand` / `rival` are prominences (null = absent); the brand's SoV is stored as the rollup's own cell figure. */
  async function capture(prompt: string, o: { brand: number | null; rival?: number | null; engine?: string; at?: string; ws?: string; project?: string }): Promise<void> {
    const ws = o.ws ?? workspaceId;
    const project = o.project ?? projectId;
    const at = o.at ?? IN_WINDOW;
    const engine = o.engine ?? "gemini";
    const id = randomUUID();
    const rival = o.rival ?? null;
    const sov = o.brand === null ? 0 : o.brand / (o.brand + (rival ?? 0));
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status,brand_present,sov)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'api','v1','v1','\\x00','{}'::jsonb,'parsed',$8,$9)`,
      [id, ws, project, randomUUID(), prompt, engine, at, o.brand !== null, sov],
    );
    const mention = (type: "brand" | "competitor", entityId: string | null, label: string, prominence: number) =>
      db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_id,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,0,0,4,0,$10,'neutral',0,0.9,'lexicon')`,
        [ws, project, id, prompt, engine, at, type, entityId, label, prominence],
      );
    if (o.brand !== null) await mention("brand", null, "Acme", o.brand);
    if (rival !== null) await mention("competitor", competitorId, "Rival", rival);
  }
  async function cells(clusterId: string, n: number, o: Parameters<typeof capture>[1]): Promise<void> {
    for (let i = 0; i < n; i++) await capture(await addPrompt(clusterId), o);
  }
  async function alignment(clusterId: string, current: number, low: number): Promise<void> {
    await db.query(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, current_alignment, target_band_low, target_band_high)
       VALUES ($1,$2,'https://acme.com/p',$3,ARRAY['gemini'],'stand-in',$4,$5,$6)`,
      [workspaceId, projectId, clusterId, current, low, low + 0.1],
    );
  }

  /** A: rival leads (20 answers); B: the brand alone (12); D: brand absent (3); E: no answers. */
  async function fixture() {
    const [a, b, d, e] = [await cluster("A rival leads"), await cluster("B brand leads"), await cluster("D brand absent"), await cluster("E no answers")];
    await cells(a, 20, { brand: 0.2, rival: 0.8 });
    await cells(b, 12, { brand: 0.9 });
    await cells(d, 3, { brand: null, rival: 0.9 });
    await addPrompt(e);
    await alignment(a, 0.625, 0.7);
    return { a, b, d, e };
  }

  it("[AC1] visibility_score is the scoring library's score over the cluster's OWN member prompts; computed_at is stamped", async () => {
    const { a, b, d } = await fixture();
    await refresh();
    // presence 1, SoV 0.2 (a), 0.9/0.9 = 1 (b); sentiment 50 (a score-0 mention); no citations (null, renormalised away).
    expect((await row(a)).v).toBeCloseTo(visibilityScore({ presenceRate: 1, shareOfVoice: 0.2, citationShare: null, sentimentScore: 50 })!, 3);
    expect((await row(a)).v).toBeCloseTo(65.625, 3);
    expect((await row(b)).v).toBeCloseTo(90.625, 3);
    // d: answered, brand never named: a real 0 (presence 0, SoV 0, no mention to score), never a null.
    expect((await row(d)).v).toBe(0);
    for (const id of [a, b, d]) expect((await row(id)).computed_at).not.toBeNull();
  });

  it("[AC1] a cluster with no answer in the window has a NULL score, not 0, and a cell outside the window or of a deleted prompt is not counted", async () => {
    const { a, e } = await fixture();
    await capture(await addPrompt(a), { brand: null, rival: 0.9, at: "2026-08-01T10:00:00Z" }); // before the window
    await capture(await addPrompt(a, { deleted: true }), { brand: null, rival: 0.9 }); // a deleted prompt
    await refresh();
    expect((await row(e)).v).toBeNull();
    expect((await row(a)).v).toBeCloseTo(65.625, 3);
  });

  it("[AC2] authority_rank, leader_entity_id, gap_priority and achievability are refreshed from A5 and the alignment distance", async () => {
    const { a, b, d } = await fixture();
    await refresh();
    const ra = await row(a);
    expect(ra.authority_rank).toBe(2);
    expect(ra.leader_entity_id).toBe(competitorId);
    expect(ra.achievability).toBeCloseTo(0.75, 5); // 1 - (0.7 - 0.625) / 0.3
    expect(ra.gap_priority).toBeCloseTo(0.7 * (0.8 - 0.2) * 0.75, 5); // commercial_intent 0.7 (default) x authority gap x achievability
    const rb = await row(b);
    expect(rb.authority_rank).toBe(1);
    expect(rb.leader_entity_id).toBe(projectId); // the brand's entity id is the project id, as in metric_daily
    expect(rb.achievability).toBeNull(); // no alignment measured: null, not 0
    expect(rb.gap_priority).toBeNull();
    expect((await row(d)).authority_rank).toBe(2);
  });

  it("[AC2] a cluster with no answers has no authority columns, and below the A5 evidence minimum none do; nothing is a placeholder", async () => {
    const { e } = await fixture();
    await alignment(e, 0.55, 0.7);
    await refresh();
    const re = await row(e);
    expect(re).toMatchObject({ authority_rank: null, leader_entity_id: null, gap_priority: null });
    expect(re.achievability).toBeCloseTo(0.5, 5);

    await db.query("TRUNCATE mention_facts, answer_captures");
    await cells((await db.query("SELECT id FROM topic_clusters WHERE label = 'A rival leads'")).rows[0].id as string, 2, { brand: 0.2, rival: 0.8 });
    await refresh();
    const a = await db.query("SELECT authority_rank, leader_entity_id, gap_priority FROM topic_clusters WHERE label = 'A rival leads'");
    expect(a.rows[0]).toEqual({ authority_rank: null, leader_entity_id: null, gap_priority: null });
  });

  it("[AC3] reads serve the stored columns: facts that change after the refresh do not change what the list returns", async () => {
    const { a } = await fixture();
    await refresh();
    const before = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new TopicsService().list(projectId));
    await db.query("TRUNCATE mention_facts, answer_captures");
    const after = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new TopicsService().list(projectId));
    expect(after).toEqual(before);
    const topic = after.topics.find((t) => t.topic_id === a)!;
    expect(topic.visibility_score).toBeCloseTo(65.625, 3);
    expect(topic.authority_rank).toBe(2);
    expect(topic.leader_entity_id).toBe(competitorId);
    expect(topic.computed_at).not.toBeNull();
  });

  it("[AC4] a matched cluster keeps its columns when the clustering reruns, and a NEW cluster is refreshed by the next rollup", async () => {
    const { a } = await fixture();
    await refresh();
    const first = await row(a);
    // a matched cluster: untouched by anything but the rollup (clustering writes none of these columns) - re-stamping is the rollup's.
    const fresh = await cluster("F new");
    await cells(fresh, 4, { brand: 0.5, rival: 0.5 });
    expect((await row(fresh)).computed_at).toBeNull();
    await refresh();
    expect((await row(fresh)).v).not.toBeNull();
    expect((await row(fresh)).computed_at).not.toBeNull();
    expect((await row(a)).v).toBe(first.v);
  });

  it("[AC5] idempotent: a second refresh leaves every value as it was", async () => {
    const { a, b, d, e } = await fixture();
    await refresh();
    const first = await Promise.all([a, b, d, e].map(row));
    await refresh();
    const second = await Promise.all([a, b, d, e].map(row));
    for (const [i, r] of first.entries()) expect({ ...second[i], computed_at: 0, updated_at: 0 }).toEqual({ ...r, computed_at: 0, updated_at: 0 });
  });

  it("[AC5 / STORY-047] the refresh never moves updated_at: min(updated_at) is the time of the LAST CLUSTERING, which the weekly trigger reads", async () => {
    const { a } = await fixture();
    await db.query("UPDATE topic_clusters SET updated_at = '2026-01-01T00:00:00Z' WHERE id = $1", [a]);
    await refresh();
    expect((await row(a)).updated_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect((await row(a)).computed_at).not.toBeNull();
  });

  it("[AC5] only the project's own clusters are touched: another workspace's and another project's keep NULL columns", async () => {
    await fixture();
    const other = await seedWorkspace();
    const foreign = await cluster("Other tenant", { ws: other.ws, project: other.project });
    const sibling = randomUUID();
    await db.query(`INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Sib',$3,'https://sib.com','sib.com')`, [sibling, workspaceId, `p-${randomUUID().slice(0, 8)}`]);
    const sib = await cluster("Sibling", { project: sibling });
    await refresh();
    for (const id of [foreign, sib]) expect(await row(id)).toMatchObject({ v: null, computed_at: null });
    // a refresh run under the wrong workspace reads and writes nothing of this project (RLS is the guarantee)
    const { a } = { a: (await db.query("SELECT id FROM topic_clusters WHERE label = 'A rival leads'")).rows[0].id as string };
    await db.query("UPDATE topic_clusters SET computed_at = NULL, visibility_score = NULL WHERE id = $1", [a]);
    await refresh(projectId, other.ws).catch(() => undefined);
    expect(await row(a)).toMatchObject({ v: null, computed_at: null });
  });

  describe("a dissolved cluster's dangling prompt_cluster_id", () => {
    async function referrers(clusterId: string) {
      const task = (await db.query(
        `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, prompt_cluster_id)
         VALUES ($1,$2,$3,'content',decode(md5(random()::text),'hex'),'T','D',$4) RETURNING id`,
        [workspaceId, projectId, `T-${randomUUID().slice(0, 6)}`, clusterId],
      )).rows[0].id as string;
      const milestone = (await db.query(
        "INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title) VALUES ($1,$2,now(),'task_completed','M') RETURNING id",
        [workspaceId, projectId],
      )).rows[0].id as string;
      await db.query("INSERT INTO task_verifications (workspace_id, project_id, task_id, milestone_id, horizon, due_at, prompt_cluster_id) VALUES ($1,$2,$3,$4,'short',now(),$5)", [workspaceId, projectId, task, milestone, clusterId]);
      await db.query("INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model) VALUES ($1,$2,'https://acme.com/p',$3,ARRAY['gemini'],'m')", [workspaceId, projectId, clusterId]);
      await db.query(
        `INSERT INTO semantic_nodes (workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, evidence_url, evidence_snippet)
         VALUES ($1,$2,$3,'p','p','capability','https://x','s')`,
        [workspaceId, projectId, clusterId],
      );
      await db.query(
        `INSERT INTO corpus_passages (workspace_id, project_id, citation_url_hash, url, domain, prompt_cluster_id, passage_index, text, token_count, content_hash, embedding_model, expires_at)
         VALUES ($1,$2,'\\x01','https://x','x.com',$3,0,'t',1,'\\x0a','m', now() + interval '1 day')`,
        [workspaceId, projectId, clusterId],
      );
    }
    const nullCounts = async () =>
      (await db.query(
        `SELECT (SELECT count(*) FROM tasks WHERE prompt_cluster_id IS NULL)::int AS tasks,
                (SELECT count(*) FROM task_verifications WHERE prompt_cluster_id IS NULL)::int AS verifications,
                (SELECT count(*) FROM geo_alignments WHERE prompt_cluster_id IS NULL)::int AS alignments,
                (SELECT count(*) FROM semantic_nodes WHERE prompt_cluster_id IS NULL)::int AS nodes,
                (SELECT count(*) FROM corpus_passages WHERE prompt_cluster_id IS NULL)::int AS passages`,
      )).rows[0];

    it("[decision 99d] is nulled in the refresh's own transaction, in every table that holds one; a live cluster's references stay", async () => {
      const { a } = await fixture();
      await referrers(randomUUID()); // points at a cluster that no longer exists
      await referrers(a); //            points at a live one
      await refresh();
      expect(await nullCounts()).toEqual({ tasks: 1, verifications: 1, alignments: 1, nodes: 1, passages: 1 });
      expect(Number((await db.query("SELECT count(*) FROM tasks WHERE prompt_cluster_id = $1", [a])).rows[0].count)).toBe(1);
    });

    it("[decision 99d] a refresh that fails rolls the nulling back with it (one transaction)", async () => {
      await fixture();
      await referrers(randomUUID());
      await db.query("ALTER TABLE topic_clusters ADD CONSTRAINT ck_test_fail CHECK (visibility_score IS NULL OR visibility_score < 0) NOT VALID");
      try {
        await expect(refresh()).rejects.toThrow();
      } finally {
        await db.query("ALTER TABLE topic_clusters DROP CONSTRAINT ck_test_fail");
      }
      expect((await nullCounts()).tasks).toBe(0);
    });

    it("[decision 99d] corpus passages that would collide on the cluster-keyed unique index once nulled do not abort the rollup", async () => {
      await fixture();
      const gone = randomUUID();
      const insert = (cluster: string | null) =>
        db.query(
          `INSERT INTO corpus_passages (workspace_id, project_id, citation_url_hash, url, domain, prompt_cluster_id, passage_index, text, token_count, content_hash, embedding_model, expires_at)
           VALUES ($1,$2,'\\x01','https://x','x.com',$3,0,'t',1,'\\x0b','m', now() + interval '1 day')`,
          [workspaceId, projectId, cluster],
        );
      await insert(null); // already cluster-less, same content
      await insert(gone); //  would duplicate it when nulled
      await insert(randomUUID()); // two dissolved clusters, same content
      // the two dangling rows are duplicates of the cluster-less one: both are dropped, and counted as cleared references
      await expect(refresh()).resolves.toMatchObject({ danglingNulled: 2 });
      expect(Number((await db.query("SELECT count(*) FROM corpus_passages WHERE content_hash = '\\x0b' AND prompt_cluster_id IS NOT NULL")).rows[0].count)).toBe(0);
      expect(Number((await db.query("SELECT count(*) FROM corpus_passages WHERE content_hash = '\\x0b'")).rows[0].count)).toBe(1);
    });
  });

  describe("observability (span, counters, redacted log line)", () => {
    const exporter = new InMemorySpanExporter();
    // No trace.disable(): it would orphan the module-level tracer.
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    let lines: unknown[];
    beforeEach(() => {
      exporter.reset();
      lines = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(m));
    });
    afterEach(() => vi.restoreAllMocks());
    const spans = () => exporter.getFinishedSpans().filter((x) => x.name === "topic_clusters.refresh");
    const metric = (name: string) => lines.filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null && (l as { metric?: unknown }).metric === name);

    it("one topic_clusters.refresh span with the counts, the ok counter, a duration observation, and one log line of ids and counts only", async () => {
      await fixture();
      await refresh();
      expect(spans()).toHaveLength(1);
      expect(spans()[0]!.attributes).toMatchObject({ "nominara.topic_clusters.refreshed": 4, "nominara.topic_clusters.dangling_nulled": 0 });
      expect(metric("nominara_topic_clusters_refresh_total")).toEqual([{ metric: "nominara_topic_clusters_refresh_total", value: 1, outcome: "ok" }]);
      expect(metric("nominara_topic_clusters_dangling_cleared_total")).toEqual([]);
      const duration = metric("nominara_topic_clusters_refresh_duration_ms");
      expect(duration).toHaveLength(1);
      expect(duration[0]!.value).toBeGreaterThanOrEqual(0);

      const logged = lines.filter((l) => (l as { event?: unknown })?.event === "topic_clusters.refreshed");
      expect(logged).toHaveLength(1);
      const line = logged[0] as Record<string, unknown>;
      expect(Object.keys(line).sort()).toEqual(["clusters", "dangling_nulled", "duration_ms", "event", "project_id", "workspace_id"]);
      expect(line).toMatchObject({ workspace_id: workspaceId, project_id: projectId, clusters: 4, dangling_nulled: 0 });
      // never a label, the project's or workspace's name, or answer text
      const text = JSON.stringify(lines);
      for (const secret of ["A rival leads", "B brand leads", "Acme", "prompt "]) expect(text).not.toContain(secret);
    });

    it("a refresh that clears dangling references counts them in the span, the log line and the cleared counter", async () => {
      await fixture();
      await db.query("INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model) VALUES ($1,$2,'https://acme.com/p',$3,ARRAY['gemini'],'m')", [workspaceId, projectId, randomUUID()]);
      await refresh();
      expect(spans()[0]!.attributes["nominara.topic_clusters.dangling_nulled"]).toBe(1);
      expect(metric("nominara_topic_clusters_dangling_cleared_total")).toHaveLength(1);
      expect(lines.find((l) => (l as { event?: unknown })?.event === "topic_clusters.refreshed")).toMatchObject({ dangling_nulled: 1 });
    });

    it("a failing refresh is an error span and an error counter, and logs no success line", async () => {
      await fixture();
      await db.query("ALTER TABLE topic_clusters ADD CONSTRAINT ck_test_fail2 CHECK (visibility_score IS NULL OR visibility_score < 0) NOT VALID");
      try {
        await expect(refresh()).rejects.toThrow();
      } finally {
        await db.query("ALTER TABLE topic_clusters DROP CONSTRAINT ck_test_fail2");
      }
      expect(spans()).toHaveLength(1);
      expect(spans()[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(metric("nominara_topic_clusters_refresh_total")).toEqual([{ metric: "nominara_topic_clusters_refresh_total", value: 1, outcome: "error" }]);
      expect(lines.some((l) => (l as { event?: unknown })?.event === "topic_clusters.refreshed")).toBe(false);
    });
  });

  describe("wired into rollup.metric_daily", () => {
    const handler = () => createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext);
    const job = (over: Record<string, unknown> = {}): Job => ({ data: { payload: { workspaceId, kid: "test-kid", projectId, ...over } } }) as unknown as Job;

    it("[AC5 / decision 99d] a rollup refreshes the project's cluster columns after the project rollup, in its own transaction", async () => {
      const a = await cluster("A recent");
      const at = new Date(Date.now() - 86_400_000).toISOString();
      await cells(a, 3, { brand: 0.5, rival: 0.5, at });
      expect((await row(a)).computed_at).toBeNull();
      await asTenantJob(db, workspaceId, () => handler()(db, job({ metricDate: at.slice(0, 10) })));
      const r = await row(a);
      expect(r.v).not.toBeNull();
      expect(r.computed_at).not.toBeNull();
    });

    it("[AC5] a rollup that has nothing to refresh (a project without clusters) is a no-op, not an error", async () => {
      await asTenantJob(db, workspaceId, () => handler()(db, job({ metricDate: "2026-09-10" })));
      expect((await db.query("SELECT count(*)::int AS n FROM topic_clusters")).rows[0].n).toBe(0);
    });
  });
});
