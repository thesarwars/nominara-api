import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { loadCooccurringEntities } from "../../src/lib/discovery/cooccurrence.js";

// STORY-043 AC11 - the co-occurrence read EXECUTED against the real schema and its CHECK constraints (a string-matching unit test cannot tell a
// statement that runs from one that does not). NOT YET RUN: written in batch 17, to be run by the coordinator under the docker lock.

describe("STORY-043 AC11 · loadCooccurringEntities executes", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let token = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 240_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE mention_facts, answer_captures, capture_runs, tracked_prompts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'HubSpot', $3, 'https://hubspot.com', 'hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
       VALUES ('chatgpt','chatgpt','v','api','1.0.0',86400,'medium','free','active','{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
  });

  async function run(status: string, createdAt: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status, created_at) VALUES ($1,$2,$3,'scheduled',ARRAY['chatgpt'],$4,$5::timestamptz)`,
      [id, workspaceId, projectId, status, createdAt],
    );
    return id;
  }

  async function answer(runId: string, labels: ReadonlyArray<[string, string]>, status = "parsed"): Promise<void> {
    const resultId = randomUUID();
    const capturedAt = "2026-11-01T00:00:00Z";
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,scoring_version)
       VALUES ($1,$2,$3,$4,$5,'chatgpt',$6::timestamptz,'api','1.0.0','n1',$7,'{}'::jsonb,'{}','live',$8,'v1')`,
      [resultId, workspaceId, projectId, runId, promptId, capturedAt, Buffer.from(randomUUID()), status],
    );
    for (const [type, label] of labels) {
      await db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score,scoring_version)
         VALUES ($1,$2,$3,$4,'chatgpt',$5::timestamptz,$6,$7,$7,0,0,1,$8,0.5,'neutral',0,0.9,'lexicon',0,'v1')`,
        [workspaceId, projectId, resultId, promptId, capturedAt, type, label, (token += 10)],
      );
    }
  }

  it("counts untracked entities per answer that also names the brand, most frequent first", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"], ["other", "Zoho"]]);
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"]]);
    await answer(first, [["other", "Pipedrive"]]); // no brand in this answer: not co-occurring
    expect(await loadCooccurringEntities(db, projectId)).toEqual([
      { label: "Salesforce", results: 2, brandResults: 2 },
      { label: "Zoho", results: 1, brandResults: 2 },
    ]);
  });

  it("never returns a tracked competitor, only entity_type 'other'", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["competitor", "Salesforce"]]);
    expect(await loadCooccurringEntities(db, projectId)).toEqual([]);
  });

  it("reads the FIRST run only, not a later one", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    const later = await run("completed", "2026-11-05T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"]]);
    await answer(later, [["brand", "HubSpot"], ["other", "Zoho"]]);
    expect((await loadCooccurringEntities(db, projectId)).map((e) => e.label)).toEqual(["Salesforce"]);
  });

  it("a first run that has not finished proposes nothing (it is not skipped for a later one)", async () => {
    const first = await run("running", "2026-11-01T00:00:00Z");
    const later = await run("completed", "2026-11-05T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"]]);
    await answer(later, [["brand", "HubSpot"], ["other", "Zoho"]]);
    expect(await loadCooccurringEntities(db, projectId)).toEqual([]);
  });

  it("a run where the brand is named nowhere is an honest empty list", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    await answer(first, [["other", "Salesforce"]]);
    expect(await loadCooccurringEntities(db, projectId)).toEqual([]);
  });

  it("no run at all is an empty list", async () => {
    expect(await loadCooccurringEntities(db, projectId)).toEqual([]);
  });
});
