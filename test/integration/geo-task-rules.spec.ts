import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { taskGenerationConditionSchema } from "../../contracts/tasks/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { normalize } from "../../src/lib/parser/normalize.js";
import { buildStructure, type StructureInput } from "../../src/lib/geo/structure.js";
import { writeGeoAnalysis } from "../../src/lib/geo/persist-analysis.js";
import { refreshProjectGeoWindows } from "../../src/lib/rollup/refresh-project-geo.js";
import { generateTasksForProject } from "../../src/lib/taskgen/generate.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-060 AC6 / scenarios 4 and 8, owner decision 15 — the alias-tuning and structure-template findings GENERATE tasks, through the
// migration-0150 rule rows and the `geo_finding` evaluator, and the digest lever links the task.

const AS_OF = new Date("2026-10-01T12:00:00Z");
const IN_WINDOW = "2026-09-20T10:00:00Z";
const METRIC_DATE = "2026-10-01";
const CLUSTER = { id: "11111111-1111-4111-8111-111111111111", label: "CRM pricing" };

describe("STORY-060 · GEO findings generate tasks (migration 0150)", () => {
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

  beforeEach(async () => {
    await db.query("TRUNCATE tasks, ref_counters, geo_analyses, answer_captures, mention_facts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain,category_slug) VALUES ($1,$2,'Notion',$3,'https://notion.so','notion.so','crm')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  const tx = <T>(fn: (c: Client) => Promise<T>) => withTenantContext(db, { workspaceId, actorId: randomUUID() }, (c) => fn(c as unknown as Client)) as Promise<T>;
  const generate = () => tx((c) => generateTasksForProject(c, tasks, { projectId, metricDate: METRIC_DATE }));
  const taskRows = async (rule: string) => (await db.query("SELECT * FROM tasks WHERE rule_code = $1 AND project_id = $2", [rule, projectId])).rows;
  const digest = () => withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new GeoService(tasks).digest(projectId, { timeframe: "30d" }));

  async function matches(n: number, span: string): Promise<void> {
    const raw = `We looked at ${span} for teams.`;
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

  it("[STORY-060 AC6 / #4] migration 0150 seeds TG-ENTITY-ALIAS and TG-STRUCTURE-TEMPLATE, enabled, with a condition the closed grammar accepts", async () => {
    const rows = (await db.query("SELECT * FROM task_generation_rules WHERE code IN ('TG-ENTITY-ALIAS','TG-STRUCTURE-TEMPLATE') ORDER BY code")).rows;
    expect(rows.map((r) => r.code)).toEqual(["TG-ENTITY-ALIAS", "TG-STRUCTURE-TEMPLATE"]);
    for (const r of rows) {
      expect(r.enabled).toBe(true);
      expect(taskGenerationConditionSchema.safeParse(r.condition).success, r.code).toBe(true);
    }
  });

  it("[STORY-060 AC6 / #4] a high-risk refresh generates exactly one open TG-ENTITY-ALIAS task, the lever links it, and a recompute adds no duplicate", async () => {
    await matches(26, "Notion");
    await matches(7, "notion"); // 7 of 33 = 21.2%: high
    await tx((c) => refreshProjectGeoWindows(c, projectId, { asOf: AS_OF }));
    expect((await digest()).levers.find((l) => l.analysis_href === "geo?analysis=entity")?.task ?? null).toBeNull();

    await generate();
    const [task, ...rest] = await taskRows("TG-ENTITY-ALIAS");
    expect(rest).toHaveLength(0);
    expect(task).toMatchObject({ status: "todo", source_geo_analysis: "entity", kind: "content" });
    expect(task.title).toMatch(/aliases/iu);

    const lever = (await digest()).levers.find((l) => l.analysis_href === "geo?analysis=entity");
    expect(lever?.task).toMatchObject({ task_id: task.id });

    await tx((c) => refreshProjectGeoWindows(c, projectId, { asOf: AS_OF }));
    await generate();
    await generate();
    expect(await taskRows("TG-ENTITY-ALIAS")).toHaveLength(1);
  });

  it("[STORY-060 AC6 / #4] a low-risk window generates no alias task", async () => {
    await matches(35, "Notion");
    await tx((c) => refreshProjectGeoWindows(c, projectId, { asOf: AS_OF }));
    await generate();
    expect(await taskRows("TG-ENTITY-ALIAS")).toHaveLength(0);
  });

  it("[STORY-060 AC7 / #8] a structure-match gap with a supplied page generates one TG-STRUCTURE-TEMPLATE task per gap, once", async () => {
    const f = (form: "comparison_table" | "narrative", answers: number) => ({ engine: "gemini", dataSource: "live" as const, form, answers, cluster: CLUSTER });
    const input: StructureInput = {
      windowStart: "2026-09-02",
      windowDays: 30,
      rootDomain: "notion.so",
      forms: [f("comparison_table", 24), f("narrative", 6)],
      position: [],
      priorPosition: [],
      pages: [{ url: "https://notion.so/pricing", tables: 0, lists: { ordered: 0, unordered: 2, definition: 0 } }],
    };
    await tx((c) => writeGeoAnalysis(c, projectId, buildStructure(input).write));
    await generate();
    await generate();
    const rows = await taskRows("TG-STRUCTURE-TEMPLATE");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_geo_analysis: "structure", kind: "content" });
    expect(rows[0].affected_url).toBe("https://notion.so/pricing");
  });
});
