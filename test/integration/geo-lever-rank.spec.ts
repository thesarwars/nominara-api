import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { rankGeoLevers } from "../../src/lib/geo/lever-rank.js";
import { refreshProjectGeoWindows } from "../../src/lib/rollup/refresh-project-geo.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-C-13 (STORY-062 AC8/9/10/12) — the rollup's GEO hook ranks the Top Three
// Levers across analyses and a recompute replaces rather than accumulates.

const AS_OF = new Date("2026-10-01T12:00:00Z"); // 30d window starts 2026-09-02; the 7d window does not contain IN_WINDOW
const IN_WINDOW = "2026-09-20T10:00:00Z";
const TEXT = "Acme is clunky and the pricing is steep [thread](https://reddit.com/r/crm/1) today.";

describe("NEW-C-13 · Top Three Levers (persisted)", () => {
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

  async function makeProject(): Promise<{ ws: string; project: string }> {
    const ws = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    const project = randomUUID();
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://acme.com','acme.com')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    return { ws, project };
  }

  async function mention(ws: string, project: string, label: "positive" | "negative"): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
       VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00',$7::jsonb,'parsed')`,
      [id, ws, project, randomUUID(), randomUUID(), IN_WINDOW, JSON.stringify({ format: "markdown", text: TEXT })],
    );
    await db.query(
      `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
         occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,
         evidence_start,evidence_end,negative_reasons,position_class)
       VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Acme','Acme',0,0,4,0,0.5,$6,0,0.5,'lexicon',0,41,$7::text[],'neutral_list')`,
      [ws, project, id, randomUUID(), IN_WINDOW, label, label === "negative" ? ["complaint_thread_cited"] : []],
    );
    if (label === "negative") {
      await db.query(
        `INSERT INTO citation_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,slot_index,raw_url,normalized_url,url_hash,domain,position_weight)
         VALUES ($1,$2,$3,$4,'gemini',$5,1,'https://reddit.com/r/crm/1','https://reddit.com/r/crm/1',sha256(convert_to('https://reddit.com/r/crm/1','UTF8')),'reddit.com',1)`,
        [ws, project, id, randomUUID(), IN_WINDOW],
      );
    }
  }

  beforeEach(async () => {
    await db.query("TRUNCATE geo_analyses, citation_facts, mention_facts, answer_captures, projects, workspaces CASCADE");
    ({ ws: workspaceId, project: projectId } = await makeProject());
    for (let i = 0; i < 30; i++) await mention(workspaceId, projectId, "positive");
    for (let i = 0; i < 2; i++) await mention(workspaceId, projectId, "negative");
  });

  const refresh = () =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => refreshProjectGeoWindows(tx, projectId, { asOf: AS_OF }));
  const rows = async () =>
    (await db.query("SELECT analysis, window_days, lever_rank, sufficient, findings FROM geo_analyses ORDER BY analysis, window_days")).rows;

  it("[C13-1] the rollup hook promotes the actionable analysis to lever 1 and leaves the no-action one unranked", async () => {
    await refresh();
    const r = await rows();
    const s30 = r.find((x) => x.analysis === "sentiment" && x.window_days === 30)!;
    expect(s30.lever_rank).toBe(1);
    expect(s30.findings.filter((f: { lever_rank?: number }) => f.lever_rank === 1)).toHaveLength(1);
    expect(r.find((x) => x.analysis === "structure" && x.window_days === 30)!.lever_rank).toBeNull();
  });

  it("[C13-2] an insufficient window carries no lever", async () => {
    await refresh();
    const s7 = (await rows()).find((x) => x.analysis === "sentiment" && x.window_days === 7)!;
    expect(s7).toMatchObject({ sufficient: false, lever_rank: null });
  });

  it("[C13-3] the digest reads the ranked lever from the persisted rows; its task is null until the task engine exists", async () => {
    await refresh();
    const d = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new GeoService().digest(projectId, { timeframe: "30d" }));
    expect(d.levers).toHaveLength(1);
    expect(d.levers[0]).toMatchObject({ rank: 1, analysis_href: "geo?analysis=sentiment", task: null });
  });

  it("[C13-4] recomputing the same windows replaces rows: no duplicates, same ranks", async () => {
    await refresh();
    const first = await rows();
    await refresh();
    await refresh();
    const again = await rows();
    expect(again).toHaveLength(6); // structure + sentiment, three windows
    expect(again.map((x) => [x.analysis, x.window_days, x.lever_rank])).toEqual(first.map((x) => [x.analysis, x.window_days, x.lever_rank]));
  });

  it("[C13-5] a stale lever is cleared when the evidence goes: the next recompute drops the rank", async () => {
    await refresh();
    await db.query("DELETE FROM citation_facts");
    await db.query("DELETE FROM mention_facts WHERE sentiment_label = 'negative'");
    await refresh();
    const s30 = (await rows()).find((x) => x.analysis === "sentiment" && x.window_days === 30)!;
    expect(s30.lever_rank).toBeNull();
    expect(JSON.stringify(s30.findings)).not.toContain("lever_rank");
  });

  it("[C13-6] free and unmetered: no credit ledger entry", async () => {
    await refresh();
    expect(Number((await db.query("SELECT count(*) FROM credit_ledger")).rows[0].count)).toBe(0);
  });

  it("[C13-7] tenant isolation under nominara_app: another workspace's ranking pass changes none of this project's rows", async () => {
    await refresh();
    const before = await rows();
    const other = await makeProject();
    await db.query("SET ROLE nominara_app");
    try {
      await withTenantContext(db, { workspaceId: other.ws, actorId: randomUUID() }, (tx) => rankGeoLevers(tx, projectId, "2026-09-02", 30));
    } finally {
      await db.query("RESET ROLE");
    }
    expect(await rows()).toEqual(before);
  });
});
