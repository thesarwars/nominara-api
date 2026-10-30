import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { rankGeoLevers } from "../../src/lib/geo/lever-rank.js";
import { SENTIMENT_TASK_RULE } from "../../src/lib/geo/sentiment.js";
import { refreshProjectGeoWindows } from "../../src/lib/rollup/refresh-project-geo.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-C-13 (STORY-062 AC8/9/10/12) — the rollup's GEO hook ranks the Top Three
// Levers across analyses and a recompute replaces rather than accumulates.

const AS_OF = new Date("2026-10-01T12:00:00Z"); // 30d window starts 2026-09-02; the 7d window does not contain IN_WINDOW
const IN_WINDOW = "2026-09-20T10:00:00Z";
const PRIOR_WINDOW = "2026-08-15T10:00:00Z";
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

  async function makeProjectIn(ws: string): Promise<string> {
    const project = randomUUID();
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://acme.com','acme.com')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    return project;
  }

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

  async function mention(ws: string, project: string, label: "positive" | "negative", at = IN_WINDOW): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
       VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00',$7::jsonb,'parsed')`,
      [id, ws, project, randomUUID(), randomUUID(), at, JSON.stringify({ format: "markdown", text: TEXT })],
    );
    await db.query(
      `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
         occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,
         evidence_start,evidence_end,negative_reasons,position_class)
       VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Acme','Acme',0,0,4,0,0.5,$6,0,0.5,'lexicon',0,41,$7::text[],'neutral_list')`,
      [ws, project, id, randomUUID(), at, label, label === "negative" ? ["complaint_thread_cited"] : []],
    );
    if (label === "negative") {
      await db.query(
        `INSERT INTO citation_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,slot_index,raw_url,normalized_url,url_hash,domain,position_weight)
         VALUES ($1,$2,$3,$4,'gemini',$5,1,'https://reddit.com/r/crm/1','https://reddit.com/r/crm/1',sha256(convert_to('https://reddit.com/r/crm/1','UTF8')),'reddit.com',1)`,
        [ws, project, id, randomUUID(), at],
      );
    }
  }

  beforeEach(async () => {
    await db.query("TRUNCATE tasks, geo_analyses, citation_facts, mention_facts, answer_captures, projects, workspaces CASCADE");
    ({ ws: workspaceId, project: projectId } = await makeProject());
    for (let i = 0; i < 30; i++) await mention(workspaceId, projectId, "positive");
    for (let i = 0; i < 2; i++) await mention(workspaceId, projectId, "negative");
    // Owner decision 22: a crossing needs a RISE over a prior window with its own 30 answers. The prior window (2026-08-03 .. 2026-09-01) is clean.
    for (let i = 0; i < 30; i++) await mention(workspaceId, projectId, "positive", PRIOR_WINDOW);
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

  // The rule the sentiment finding names (STORY-061 moved it from TG-SENTIMENT-NEGATIVE, the cell-rate alert rule, to its own).
  const RULE = SENTIMENT_TASK_RULE;
  interface TaskSeed {
    status?: string;
    rule?: string | null;
    analysis?: string | null;
    title?: string;
    impact?: number;
    deletedAt?: string | null;
    ws?: string;
    project?: string;
  }
  let taskSeq = 0;
  /** A task row as the generator would leave it; owner role, so RLS never hides the seed. */
  async function task(seed: TaskSeed = {}): Promise<string> {
    const seq = ++taskSeq;
    const status = seed.status ?? "todo";
    const res = await db.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, rule_code, dedupe_fingerprint, title, description, status,
                          dismissed_reason, impact_score, source_geo_analysis, deleted_at)
       VALUES ($1, $2, $3, 'content', $4, sha256(convert_to($5, 'UTF8')), $6, 'D', $7, $8, $9, $10, $11) RETURNING id`,
      [
        seed.ws ?? workspaceId, seed.project ?? projectId, `LEV-${seq}`,
        seed.rule === undefined ? RULE : seed.rule, `fp-${seq}-${randomUUID()}`, seed.title ?? `Task ${seq}`,
        status, status === "dismissed" ? "noise" : null, seed.impact ?? 0,
        seed.analysis === undefined ? "sentiment" : seed.analysis, seed.deletedAt ?? null,
      ],
    );
    return res.rows[0]!.id;
  }
  const digest = (scope?: string[]) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID(), ...(scope === undefined ? {} : { scopeProjectIds: scope }) }, () =>
      new GeoService(new TasksService(new NoopRealtimePublisher())).digest(projectId, { timeframe: "30d" }),
    );

  it("[C13-3] the digest reads the ranked lever from the persisted rows; with no task for its rule the link is null", async () => {
    await refresh();
    const d = await digest();
    expect(d.levers).toHaveLength(1);
    expect(d.levers[0]).toMatchObject({ rank: 1, analysis_href: "geo?analysis=sentiment", task: null });
  });

  it("[C13-3a] STORY-062 AC10 · a lever links its analysis AND the open task for the finding's rule (todo)", async () => {
    await refresh();
    const id = await task({ title: "Answer the pricing complaints" });
    const d = await digest();
    expect(d.levers[0]).toMatchObject({
      analysis_href: "geo?analysis=sentiment",
      task: { task_id: id, label: "Answer the pricing complaints", href: `plan?task=${id}` },
    });
  });

  it("[C13-3b] an in_progress task is open, so it links", async () => {
    await refresh();
    const id = await task({ status: "in_progress" });
    expect((await digest()).levers[0]!.task?.task_id).toBe(id);
  });

  it.each(["dismissed", "done"])("[C13-3c] a %s task is never the action: the link is null", async (status) => {
    await refresh();
    await task({ status });
    expect((await digest()).levers[0]!.task).toBeNull();
  });

  it("[C13-3d] a dismissed task and an open one for the same rule: the open task links", async () => {
    await refresh();
    await task({ status: "dismissed", impact: 99 });
    const open = await task({ status: "todo", impact: 1 });
    expect((await digest()).levers[0]!.task?.task_id).toBe(open);
  });

  it("[C13-3e] two open tasks for the rule: the higher impact one links, deterministically", async () => {
    await refresh();
    await task({ impact: 1 });
    const top = await task({ impact: 5 });
    expect((await digest()).levers[0]!.task?.task_id).toBe(top);
  });

  it("[C13-3f] a soft-deleted task, another rule, another analysis, or an unattributed task never links", async () => {
    await refresh();
    await task({ deletedAt: "2026-09-25T00:00:00Z" });
    await task({ rule: "TG-CITATION-LOSS" });
    await task({ analysis: "structure" });
    await task({ analysis: null });
    expect((await digest()).levers[0]!.task).toBeNull();
  });

  it("[C13-3g] a task of another project in the same workspace never links", async () => {
    await refresh();
    const other = await makeProjectIn(workspaceId);
    await task({ project: other });
    expect((await digest()).levers[0]!.task).toBeNull();
  });

  it("[C13-3h] under the application role: another workspace's open task never links, and a caller scoped away from the project gets no link", async () => {
    await refresh();
    const other = await makeProject();
    await task({ ws: other.ws, project: other.project });
    const mine = await task();
    await db.query("SET ROLE nominara_app");
    try {
      expect((await digest()).levers[0]!.task?.task_id).toBe(mine); // RLS hid the other workspace's row
      expect((await digest([projectId])).levers[0]!.task?.task_id).toBe(mine);
      expect((await digest([other.project])).levers[0]!.task).toBeNull(); // in-scope only
    } finally {
      await db.query("RESET ROLE");
    }
  });

  it("[C13-4] recomputing the same windows replaces rows: no duplicates, same ranks", async () => {
    await refresh();
    const first = await rows();
    await refresh();
    await refresh();
    const again = await rows();
    expect(again).toHaveLength(15); // structure + entity + sentiment + divergence + topics (STORY-061), three windows
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
    // A stale state a correct pass WOULD repair; only the owner of the rows may repair it.
    await db.query("UPDATE geo_analyses SET lever_rank = NULL WHERE analysis = 'sentiment' AND window_days = 30");
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
