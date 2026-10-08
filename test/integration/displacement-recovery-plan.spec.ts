import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { displacementFeedQuerySchema, recoveryPlanResponseSchema } from "../../contracts/analytics/index.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { DisplacementService } from "../../src/modules/displacement/displacement.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-C-6 — POST /v1/displacements/{id}/recovery-plan. STORY-057 scenarios 9, 10, 11 and 12 (backend half).
// One authority task per SEEDABLE citation gap, through the ONE task-insert path (TasksService); fingerprint
// sha256('authority:{project_id}:{domain}') (owner decision 2026-10-08, NEW-C-6 option 1).
//
// Tenancy assertions run under `SET ROLE nominara_app`: the owning role bypasses RLS and would pass for the wrong reason.
describe("NEW-C-6 · displacement recovery plan", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let promptId: string;
  let actorId: string;
  const service = new DisplacementService(new TasksService(new NoopRealtimePublisher()));

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db, MIGRATIONS_DIR);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tasks, ref_counters, displacement_events, source_domains, answer_captures, tracked_prompts, projects, workspaces CASCADE");
    await db.query("TRUNCATE users CASCADE");
    actorId = (await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])).rows[0].id;
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [id, `w-${id.slice(0, 8)}`]);
    }
    await db.query(
      "INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Planet',$3,'https://p.com','p.com')",
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  async function capture(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,
          normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,'gemini',now(),'api','1.0.0','n1',$6,'{}'::jsonb,'{}','live','parsed',true)`,
      [id, workspaceId, projectId, uuidV7(), promptId, createHash("sha256").update(id).digest()],
    );
    return id;
  }

  const gapEntry = (domain: string, path = "x") => ({ url: `https://${domain}/${path}`, domain, source_class: "blog", held_by: ["Rival"], brand_present: false });

  async function displacement(options: { citationGap?: unknown[]; conceptGap?: unknown[]; taskId?: string } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO displacement_events
         (id,workspace_id,project_id,prompt_id,engine_key,kind,before_result_id,after_result_id,
          displaced_by,citation_gap,concept_gap,impact_score,task_id)
       VALUES ($1,$2,$3,$4,'gemini','position_lost',$5,$6,'[]'::jsonb,$7::jsonb,$8::jsonb,0.5,$9)`,
      [id, workspaceId, projectId, promptId, await capture(), await capture(),
        JSON.stringify(options.citationGap ?? []), JSON.stringify(options.conceptGap ?? []), options.taskId ?? null],
    );
    return id;
  }

  const seedable = (...domains: string[]) =>
    Promise.all(domains.map((d) => db.query("INSERT INTO source_domains (workspace_id, domain, is_seedable) VALUES ($1,$2,true)", [workspaceId, d])));
  const plan = (id: string, ws = workspaceId, client: Client = db) =>
    withTenantContext(client, { workspaceId: ws, actorId }, () => service.recoveryPlan(id));
  const taskRows = async () => (await db.query("SELECT * FROM tasks ORDER BY created_at, id")).rows;

  it("STORY-057 #9 / NEW-C-6 AC2 — one authority task per seedable citation gap, linked to the displacement, fingerprint per the owner formula", async () => {
    await seedable("seed.com", "other.org");
    const id = await displacement({ citationGap: [gapEntry("seed.com"), gapEntry("other.org", "y")] });
    const tasks = await plan(id);

    expect(recoveryPlanResponseSchema.safeParse(tasks).success).toBe(true);
    expect(tasks).toHaveLength(2);
    const rows = await taskRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe("authority");
      expect(row.origin).toBe("auto");
      expect(row.source_displacement_id).toBe(id);
      expect(row.source_domain_id).not.toBeNull();
      expect(row.status).toBe("todo");
    }
    const byUrl = new Map(rows.map((r) => [r.affected_url, r]));
    const seed = byUrl.get("https://seed.com/x")!;
    expect(Buffer.from(seed.dedupe_fingerprint).equals(createHash("sha256").update(`authority:${projectId}:seed.com`).digest())).toBe(true);
    expect(byUrl.has("https://other.org/y")).toBe(true);
    expect((await db.query("SELECT task_id FROM displacement_events WHERE id = $1", [id])).rows[0].task_id).toBe(tasks[0]!.id);
  });

  it("STORY-057 #10 / NEW-C-6 AC2 — a non-seedable or unknown domain gets no task, and the gap stays visible in the feed", async () => {
    await db.query("INSERT INTO source_domains (workspace_id, domain, is_seedable) VALUES ($1,'closed.com',false)", [workspaceId]);
    await seedable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("closed.com"), gapEntry("unknown.com"), gapEntry("seed.com")] });
    const tasks = await plan(id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.affected_url).toBe("https://seed.com/x");
    const [item] = (await withTenantContext(db, { workspaceId, actorId }, () => service.feed(projectId, displacementFeedQuerySchema.parse({})))).items;
    expect(item!.citation_gap.map((g) => g.domain)).toEqual(["closed.com", "unknown.com", "seed.com"]);
  });

  it("STORY-057 #12 / NEW-C-6 AC2 — a repeat call creates no duplicate task and burns no reference; it returns the same tasks", async () => {
    await seedable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com")] });
    const first = await plan(id);
    const counter = (await db.query("SELECT next_value FROM ref_counters")).rows;
    const second = await plan(id);
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
    expect(await taskRows()).toHaveLength(1);
    expect((await db.query("SELECT next_value FROM ref_counters")).rows).toEqual(counter);
  });

  it("STORY-057 #12 — a second displacement on the same project and domain reuses the open task rather than adding another", async () => {
    await seedable("seed.com");
    const a = await displacement({ citationGap: [gapEntry("seed.com")] });
    const b = await displacement({ citationGap: [gapEntry("seed.com")] });
    const [first] = await plan(a);
    const [second] = await plan(b);
    expect(second!.id).toBe(first!.id);
    expect(await taskRows()).toHaveLength(1);
    expect((await db.query("SELECT task_id FROM displacement_events WHERE id = $1", [b])).rows[0].task_id).toBe(first!.id);
  });

  it("NEW-C-6 AC2 — once the task is done, the fingerprint is free again and a new plan creates a new task", async () => {
    await seedable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com")] });
    const [first] = await plan(id);
    await db.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [first!.id]);
    const [again] = await plan(id);
    expect(again!.id).not.toBe(first!.id);
    expect(await taskRows()).toHaveLength(2);
  });

  it("NEW-C-6 AC2 — two gap URLs on one domain are ONE task, and the feed's recovery_task_count says the same", async () => {
    await seedable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com", "a"), gapEntry("Seed.com", "b")] });
    const [item] = (await withTenantContext(db, { workspaceId, actorId }, () => service.feed(projectId, displacementFeedQuerySchema.parse({})))).items;
    const tasks = await plan(id);
    expect(tasks).toHaveLength(1);
    expect(item!.recovery_task_count).toBe(tasks.length);
  });

  it("STORY-057 / NEW-C-6 AC2 — concept tasks are zero until STORY-058: a concept gap alone yields an empty plan, and task_id stays null", async () => {
    const id = await displacement({ conceptGap: [{ concept: "pricing", prevalence: 0.6, evidence_url: "https://e.com" }] });
    expect(await plan(id)).toEqual([]);
    expect(await taskRows()).toHaveLength(0);
    expect((await db.query("SELECT task_id FROM displacement_events WHERE id = $1", [id])).rows[0].task_id).toBeNull();
  });

  it("NEW-C-6 AC2 — no gaps at all is an empty plan, not an error", async () => {
    expect(await plan(await displacement())).toEqual([]);
  });

  it("NEW-C-6 AC2 — a seedable domain of ANOTHER workspace does not make a task", async () => {
    await db.query("INSERT INTO source_domains (workspace_id, domain, is_seedable) VALUES ($1,'seed.com',true)", [otherWorkspaceId]);
    const id = await displacement({ citationGap: [gapEntry("seed.com")] });
    expect(await plan(id)).toEqual([]);
  });

  it("NEW-C-6 AC2 — concurrent plans for one displacement make exactly one task per domain and consume one reference", async () => {
    await seedable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com")] });
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      const results = await Promise.allSettled([plan(id, workspaceId, db), plan(id, workspaceId, other)]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await taskRows()).toHaveLength(1);
      expect((await db.query("SELECT next_value FROM ref_counters")).rows[0].next_value).toBe(2);
    } finally {
      await other.end();
    }
  });

  it("NEW-C-6 AC3 — under nominara_app, another workspace's displacement id is 404 and nothing is written; a scoped member outside the project is 403", async () => {
    await seedable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com")] });
    await db.query("SET ROLE nominara_app");
    try {
      await expect(plan(id, otherWorkspaceId)).rejects.toMatchObject({ code: "not_found" });
      await expect(
        withTenantContext(db, { workspaceId, actorId, scopeProjectIds: [randomUUID()] }, () => service.recoveryPlan(id)),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.query("RESET ROLE");
    }
    expect(await taskRows()).toHaveLength(0);
  });

  it("NEW-C-6 AC2 — the plan's tasks are written in one transaction: a failure part-way leaves no task and no task_id", async () => {
    await seedable("seed.com", "b.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com"), gapEntry("b.com")] });
    // A trigger that rejects the second task proves atomicity without touching production code.
    await db.query(`CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.affected_url LIKE 'https://seed.com/%' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER boom BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION pg_temp.boom()");
    try {
      await expect(plan(id)).rejects.toThrow();
    } finally {
      await db.query("DROP TRIGGER boom ON tasks");
    }
    expect(await taskRows()).toHaveLength(0);
    expect((await db.query("SELECT task_id FROM displacement_events WHERE id = $1", [id])).rows[0].task_id).toBeNull();
  });

  it("NEW-C-6 observability - counts the plan and logs workspace and displacement IDs plus counts only, never a title, URL or competitor", async () => {
    await seedable("seed.com");
    const id = await displacement({ citationGap: [gapEntry("seed.com")] });
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    try {
      await plan(id);
      await plan(id);
    } finally {
      spy.mockRestore();
    }
    expect(logs).toContainEqual({ metric: "nominara_displacement_recovery_plans_total", value: 1, outcome: "created" });
    expect(logs).toContainEqual({ metric: "nominara_displacement_recovery_plans_total", value: 1, outcome: "unchanged" });
    expect(logs).toContainEqual({ message: "displacement recovery plan", workspace_id: workspaceId, displacement_id: id, tasks_created: 1, tasks_existing: 0 });
    expect(logs).toContainEqual({ message: "displacement recovery plan", workspace_id: workspaceId, displacement_id: id, tasks_created: 0, tasks_existing: 1 });
    expect(JSON.stringify(logs)).not.toMatch(/Rival|seed\.com\/x|Earn a citation/);
  });
});
