import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { loadCooccurringEntities } from "../../src/lib/discovery/cooccurrence.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";

// STORY-043 AC11 - the co-occurrence read EXECUTED against the real schema and its CHECK constraints (a string-matching unit test cannot tell a
// statement that runs from one that does not). The READS run as the actual runtime role (nominara_app) inside a transaction carrying
// set_config('app.current_workspace_id', ..., true), because a superuser bypasses RLS and would pass vacuously; the fixtures are written by the
// owner connection. A second workspace holds a first run of its own whose entities must never appear in the first workspace's read.

describe("STORY-043 AC11 · loadCooccurringEntities executes", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let otherWorkspaceId: string;
  let otherProjectId: string;
  let otherPromptId: string;
  let token = 0;
  let sample = 0;

  /** The read exactly as the service makes it: as nominara_app, in a transaction that sets the workspace local to it. */
  async function read(inWorkspace: string, forProject: string) {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.current_workspace_id', $1, true)", [inWorkspace]);
      return await loadCooccurringEntities(app, forProject);
    } finally {
      await app.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    app = await connectAsRole({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() }, "nominara_app", resolvePassword("nominara_app", {}));
  }, 240_000);

  afterAll(async () => {
    await app.end();
    await db.end();
    await container.stop();
  });

  async function seedWorkspace(): Promise<{ workspaceId: string; projectId: string; promptId: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    const prompt = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'HubSpot', $3, 'https://hubspot.com', 'hubspot.com')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [prompt, ws, project],
    );
    return { workspaceId: ws, projectId: project, promptId: prompt };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE mention_facts, answer_captures, capture_runs, tracked_prompts, projects, workspaces CASCADE");
    ({ workspaceId, projectId, promptId } = await seedWorkspace());
    ({ workspaceId: otherWorkspaceId, projectId: otherProjectId, promptId: otherPromptId } = await seedWorkspace());
    await db.query(
      `INSERT INTO engines (key,display_name,vendor,capture_mode,adapter_version,cache_ttl_seconds,volatility_band,min_plan_key,status,cadence_by_plan)
       VALUES ('chatgpt','chatgpt','v','api','1.0.0',86400,'medium','free','active','{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
  });

  async function run(status: string, createdAt: string, ws = workspaceId, project = projectId): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status, created_at) VALUES ($1,$2,$3,'scheduled',ARRAY['chatgpt'],$4,$5::timestamptz)`,
      [id, ws, project, status, createdAt],
    );
    return id;
  }

  async function answer(runId: string, labels: ReadonlyArray<[string, string]>, status = "parsed", ws = workspaceId, project = projectId, prompt = promptId): Promise<void> {
    const resultId = randomUUID();
    const capturedAt = "2026-11-01T00:00:00Z";
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,sample_index,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,scoring_version)
       VALUES ($1,$2,$3,$4,$5,'chatgpt',$9,$6::timestamptz,'api','1.0.0','n1',$7,'{}'::jsonb,'{}','live',$8,'v1')`,
      // A distinct sample index per answer: (run_id, prompt_id, engine_key, sample_index) is unique.
      [resultId, ws, project, runId, prompt, capturedAt, Buffer.from(randomUUID()), status, (sample += 1)],
    );
    for (const [type, label] of labels) {
      await db.query(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score,scoring_version)
         VALUES ($1,$2,$3,$4,'chatgpt',$5::timestamptz,$6,$7,$7,0,0,1,$8,0.5,'neutral',0,0.9,'lexicon',0,'v1')`,
        [ws, project, resultId, prompt, capturedAt, type, label, (token += 10)],
      );
    }
  }

  it("counts untracked entities per answer that also names the brand, most frequent first", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"], ["other", "Zoho"]]);
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"]]);
    await answer(first, [["other", "Pipedrive"]]); // no brand in this answer: not co-occurring
    expect(await read(workspaceId, projectId)).toEqual([
      { label: "Salesforce", results: 2, brandResults: 2 },
      { label: "Zoho", results: 1, brandResults: 2 },
    ]);
  });

  it("never returns a tracked competitor, only entity_type 'other'", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["competitor", "Salesforce"]]);
    expect(await read(workspaceId, projectId)).toEqual([]);
  });

  it("reads the FIRST run only, not a later one", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    const later = await run("completed", "2026-11-05T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"]]);
    await answer(later, [["brand", "HubSpot"], ["other", "Zoho"]]);
    expect((await read(workspaceId, projectId)).map((e) => e.label)).toEqual(["Salesforce"]);
  });

  it("a first run that has not finished proposes nothing (it is not skipped for a later one)", async () => {
    const first = await run("running", "2026-11-01T00:00:00Z");
    const later = await run("completed", "2026-11-05T00:00:00Z");
    await answer(first, [["brand", "HubSpot"], ["other", "Salesforce"]]);
    await answer(later, [["brand", "HubSpot"], ["other", "Zoho"]]);
    expect(await read(workspaceId, projectId)).toEqual([]);
  });

  it("a run where the brand is named nowhere is an honest empty list", async () => {
    const first = await run("completed", "2026-11-01T00:00:00Z");
    await answer(first, [["other", "Salesforce"]]);
    expect(await read(workspaceId, projectId)).toEqual([]);
  });

  it("RLS - another workspace's first run never leaks into this one's read, and is invisible to a read aimed at its project", async () => {
    const mine = await run("completed", "2026-11-01T00:00:00Z");
    await answer(mine, [["brand", "HubSpot"], ["other", "Salesforce"]]);
    const theirs = await run("completed", "2026-11-01T00:00:00Z", otherWorkspaceId, otherProjectId);
    await answer(theirs, [["brand", "HubSpot"], ["other", "LeakyCo"]], "parsed", otherWorkspaceId, otherProjectId, otherPromptId);
    await answer(theirs, [["brand", "HubSpot"], ["other", "LeakyCo"]], "parsed", otherWorkspaceId, otherProjectId, otherPromptId);

    expect((await read(workspaceId, projectId)).map((e) => e.label)).toEqual(["Salesforce"]);
    // Aimed at the other workspace's project from this workspace's context: the planner filter would match, RLS must not.
    expect(await read(workspaceId, otherProjectId)).toEqual([]);
    // The control: the fixture is real, and the other workspace sees its own.
    expect((await read(otherWorkspaceId, otherProjectId)).map((e) => e.label)).toEqual(["LeakyCo"]);
  });

  it("no run at all is an empty list", async () => {
    expect(await read(workspaceId, projectId)).toEqual([]);
  });
});
