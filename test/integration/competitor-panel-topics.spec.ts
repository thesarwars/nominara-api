import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { CompetitorPanelService } from "../../src/modules/analytics/competitor-panel.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-090 AC8 - the Overview's competitor panel honours the topic-cluster filter, like the scorecards and the growth map: every figure is the SAME
// formula over the member prompts of the chosen clusters (brand row, competitor rows, head-to-head, detected-not-tracked, data source), and an id the
// project does not have is a 400 naming `topics`.
//
// Fixture: cluster A's prompt - 3 cells with the brand (position 2) and Salesforce (position 1), 10 cells naming an untracked "Pipedrive" (spread so the
// detection threshold of 10 is reached by A alone). Cluster B's prompt - 2 cells with the brand only.

describe("STORY-090 AC8 · topic-cluster filter on the competitor panel", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let clusterA: string;
  let clusterB: string;
  let promptA: string;
  let promptB: string;
  let salesforce: string;

  const resolver = { resolveForWorkspace: async () => ({ entitlements: { "competitors.max_per_project": { value: 5 } } }) } as unknown as EntitlementResolver;

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

  async function addCluster(label: string, project = projectId): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO topic_clusters (id, workspace_id, project_id, label) VALUES ($1,$2,$3,$4)", [id, workspaceId, project, label]);
    return id;
  }

  async function addPrompt(cluster: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status,cluster_id)
       VALUES ($1,$2,$3,$4,sha256($4::text::bytea),'recommendation','consideration',false,'active',$5)`,
      [id, workspaceId, projectId, `q-${id}`, cluster],
    );
    return id;
  }

  beforeEach(async () => {
    await db.query(
      "TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, topic_clusters, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    salesforce = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')", [
      projectId,
      workspaceId,
      `p-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
       VALUES ('chatgpt','chatgpt','v','api','1.0.0',86400,'medium','free','active','{}'::jsonb)`,
    );
    await db.query("INSERT INTO project_engines (workspace_id,project_id,engine_key,enabled,sample_count,weight) VALUES ($1,$2,'chatgpt',true,1,1)", [workspaceId, projectId]);
    await db.query("INSERT INTO competitors (id,workspace_id,project_id,name,root_domain) VALUES ($1,$2,$3,'Salesforce','salesforce.com')", [salesforce, workspaceId, projectId]);
    clusterA = await addCluster("Pricing");
    clusterB = await addCluster("Support");
    promptA = await addPrompt(clusterA);
    promptB = await addPrompt(clusterB);
  });

  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

  interface Mention {
    type: "brand" | "competitor" | "other";
    label: string;
    prominence: number;
    listPosition?: number;
    entityId?: string;
  }

  async function addCell(promptId: string, mentions: Mention[], normalizer = "n1"): Promise<void> {
    const resultId = randomUUID();
    const capturedAt = daysAgo(1);
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present,scoring_version)
       VALUES ($1,$2,$3,$4,$5,'chatgpt',$6::timestamptz,'api','1.0.0',$7,$8,'{}'::jsonb,'{}','live','parsed',$9,'v1')`,
      [resultId, workspaceId, projectId, uuidV7(), promptId, capturedAt, normalizer, createHash("sha256").update(resultId).digest(), mentions.some((m) => m.type === "brand")],
    );
    let token = 0;
    for (const m of mentions) {
      await db.query(
        `INSERT INTO mention_facts
           (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_id,entity_label,matched_alias,occurrence_index,char_start,char_end,
            first_token_index,prominence,list_position,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score,scoring_version)
         VALUES ($1,$2,$3,$4,'chatgpt',$5::timestamptz,$6,$7,$8,$8,0,0,1,$9,$10,$11,'positive',0.5,0.9,'lexicon',0.4,'v1')`,
        [workspaceId, projectId, resultId, promptId, capturedAt, m.type, m.entityId ?? null, m.label, (token += 10), m.prominence, m.listPosition ?? null],
      );
    }
  }

  async function seed(): Promise<void> {
    const brand: Mention = { type: "brand", label: "HubSpot", prominence: 0.5, listPosition: 2 };
    const sf: Mention = { type: "competitor", label: "Salesforce", prominence: 0.6, listPosition: 1, entityId: salesforce };
    for (let i = 0; i < 3; i++) await addCell(promptA, [brand, sf]);
    for (let i = 0; i < 10; i++) await addCell(promptA, [{ type: "other", label: "Pipedrive", prominence: 0.1 }]);
    for (let i = 0; i < 2; i++) await addCell(promptB, [brand]);
  }

  const panel = (query: Record<string, unknown> = {}) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new CompetitorPanelService(resolver).panel(projectId, { timeframe: "30d", ...query } as never)) as ReturnType<
      CompetitorPanelService["panel"]
    >;
  const rowOf = (doc: Awaited<ReturnType<typeof panel>>, label: string) => doc.rows.find((r) => r.label === label)!;

  it("STORY-090 AC8 · one cluster narrows the brand and competitor rows to its prompts", async () => {
    await seed();
    const a = await panel({ topics: clusterA });
    // Cluster A: brand and Salesforce co-appear on 3 cells, Salesforce ahead every time: the brand wins none of them.
    expect(rowOf(a, "Salesforce").h2h_win_rate).toBe(0);
    const b = await panel({ topics: clusterB });
    // Cluster B never names Salesforce. Null, not 0: no contest, and 0 share of voice is a measured absence.
    expect(rowOf(b, "Salesforce").h2h_win_rate).toBeNull();
    expect(rowOf(b, "Salesforce").sov).toBe(0);
    expect(rowOf(b, "HubSpot").sov).toBeGreaterThan(0);
    expect(rowOf(a, "HubSpot").sov).not.toBe(rowOf(b, "HubSpot").sov);
  });

  it("STORY-090 AC8 · all clusters together equal the unfiltered panel, and no topics is unchanged", async () => {
    await seed();
    const whole = await panel();
    expect(await panel({ topics: `${clusterA},${clusterB}` })).toEqual(whole);
    expect(await panel({ topics: undefined })).toEqual(whole);
  });

  it("STORY-090 AC8 · detected-not-tracked counts only the chosen clusters' captures", async () => {
    await seed();
    expect((await panel()).rows.find((r) => !r.tracked)).toMatchObject({ label: "Pipedrive", appearances: 10 });
    expect((await panel({ topics: clusterA })).rows.find((r) => !r.tracked)).toMatchObject({ label: "Pipedrive", appearances: 10 });
    expect((await panel({ topics: clusterB })).rows.filter((r) => !r.tracked)).toEqual([]);
  });

  it("STORY-090 AC8 · the data source describes only the chosen clusters' captures", async () => {
    await seed();
    // One extra seeded (demo) capture in cluster B only.
    await addCell(promptB, [{ type: "brand", label: "HubSpot", prominence: 0.5 }], DEMO_SEED_MARKER);
    const a = await panel({ topics: clusterA });
    expect(a.engine_data_source.chatgpt).toBe("live");
    expect((await panel({ topics: clusterB })).engine_data_source.chatgpt).toBe("mixed");
    expect((await panel()).engine_data_source.chatgpt).toBe("mixed");
  });

  it("STORY-090 AC8 · a cluster with no answered cell in the window reads null, not zero", async () => {
    await seed();
    const empty = await addCluster("Empty");
    const doc = await panel({ topics: empty });
    expect(rowOf(doc, "HubSpot").blended).toBeNull();
    expect(rowOf(doc, "HubSpot").sov).toBeNull();
    expect(rowOf(doc, "Salesforce").blended).toBeNull();
  });

  it("STORY-090 AC8 · an unknown cluster id and another project's cluster id are a 400 naming `topics`, never dropped", async () => {
    await seed();
    const otherProject = randomUUID();
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Other',$3,'https://o.test','o.test')", [otherProject, workspaceId, `o-${randomUUID().slice(0, 8)}`]);
    const foreign = await addCluster("Foreign", otherProject);
    for (const topics of [randomUUID(), foreign, `${clusterA},${foreign}`]) {
      await expect(panel({ topics })).rejects.toMatchObject({ code: "validation_failed", details: { issues: [{ path: ["topics"] }] } });
    }
  });
});
