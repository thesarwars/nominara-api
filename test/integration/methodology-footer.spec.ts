import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { methodologyFooterSchema } from "../../contracts/reports/index.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";
import { MethodologyService } from "../../src/modules/reports/methodology.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// NEW-E-100a — GET /projects/{id}/reports/methodology against real rollup rows.

describe("NEW-E-100a · methodology footer service", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;

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

  async function makeProject(ws: string, extra: { scoringVersion?: string; overrides?: object } = {}): Promise<string> {
    const project = randomUUID();
    await db.query(
      "INSERT INTO workspaces (id,name,slug,plan_key,timezone,scoring_version,entitlement_overrides) VALUES ($1,'W',$2,'growth','UTC',$3,$4::jsonb) ON CONFLICT (id) DO NOTHING",
      [ws, `w-${randomUUID().slice(0, 8)}`, extra.scoringVersion ?? "v1", JSON.stringify(extra.overrides ?? {})],
    );
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
       VALUES ($1,$2,'P',$3,'https://x.com','x.com')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    return project;
  }

  beforeEach(async () => {
    await db.query("TRUNCATE metric_daily, answer_captures, tracked_prompts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = await makeProject(workspaceId);
    promptId = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  }

  async function addMetric(
    engine: string,
    ago: number,
    cells: number,
    ratio: number,
    opts: { entityType?: string; version?: string; project?: string; ws?: string } = {},
  ): Promise<void> {
    await db.query(
      `INSERT INTO metric_daily (workspace_id,project_id,engine_key,entity_type,entity_id,metric_date,cells_total,live_capture_ratio,scoring_version)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9)`,
      [
        opts.ws ?? workspaceId,
        opts.project ?? projectId,
        engine,
        opts.entityType ?? "brand",
        opts.project ?? projectId,
        daysAgo(ago),
        cells,
        ratio,
        opts.version ?? "v1",
      ],
    );
  }

  async function addCapture(engine: string, normalizer: string): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,
          capture_mode,adapter_version,normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,$6,now() - interval '1 hour','api','1.0.0',$7,$8,'{}'::jsonb,'{}','live','parsed',true)`,
      [id, workspaceId, projectId, uuidV7(), promptId, engine, normalizer, createHash("sha256").update(id).digest()],
    );
  }

  function read(timeframe: "24h" | "7d" | "30d" | "90d" = "30d", ws = workspaceId, project = projectId) {
    return withTenantContext(db, { workspaceId: ws, actorId: randomUUID() }, () =>
      new MethodologyService().footer(project, { timeframe }),
    ) as ReturnType<MethodologyService["footer"]>;
  }

  it("NEW-E-100a AC1 — carries every NFR-AGY-05 field, from rollup rows, and validates against the contract", async () => {
    await addMetric("gemini", 3, 30, 1);
    await addMetric("chatgpt", 1, 10, 0.5);
    const footer = await read("30d");
    expect(methodologyFooterSchema.safeParse(footer).success).toBe(true);
    expect(footer.data_through).toBe(daysAgo(1));
    expect(footer.engines).toEqual(["chatgpt", "gemini"]);
    expect(footer.timeframe).toBe("30d");
    expect(footer.sample_size).toBe(40);
    expect(footer.live_capture_ratio).toBeCloseTo(0.875, 6);
    expect(footer.scoring_version).toBe("v1");
    expect(footer.weight_overrides).toBeNull();
    expect(footer.note.length).toBeGreaterThan(0);
  });

  it("NEW-E-100a AC1 — a project with no rollup has data_through null, live_capture_ratio null (never 0) and sample_size 0", async () => {
    const footer = await read();
    expect(footer.data_through).toBeNull();
    expect(footer.live_capture_ratio).toBeNull();
    expect(footer.sample_size).toBe(0);
    expect(footer.engines).toEqual([]);
    expect(footer.engine_data_sources).toEqual([]);
  });

  it("NEW-E-100a AC1 — a measured live_capture_ratio of 0 is reported as 0, not null", async () => {
    await addMetric("gemini", 1, 5, 0);
    expect((await read()).live_capture_ratio).toBe(0);
  });

  it("NEW-E-100a AC1 — data_through is the latest metric_daily date for the project even when it is older than the timeframe", async () => {
    await addMetric("gemini", 60, 8, 1);
    const footer = await read("7d");
    expect(footer.data_through).toBe(daysAgo(60));
    expect(footer.sample_size).toBe(0);
    expect(footer.engines).toEqual([]);
    expect(footer.live_capture_ratio).toBeNull();
  });

  it("NEW-E-100a AC1 — the timeframe bounds the sample", async () => {
    await addMetric("gemini", 2, 4, 1);
    await addMetric("gemini", 20, 6, 1);
    expect((await read("7d")).sample_size).toBe(4);
    expect((await read("30d")).sample_size).toBe(10);
    expect((await read("24h")).sample_size).toBe(0);
  });

  it("NEW-E-100a AC2 — competitor rows, the cross-engine blend row and other scoring versions are not counted as engines or sample", async () => {
    await addMetric("gemini", 1, 7, 1);
    await addMetric("gemini", 1, 99, 1, { entityType: "competitor" });
    await addMetric("all", 1, 99, 1);
    await addMetric("gemini", 2, 99, 1, { version: "v0" });
    const footer = await read();
    expect(footer.engines).toEqual(["gemini"]);
    expect(footer.sample_size).toBe(7);
  });

  it("NEW-E-100a AC1 — each engine carries live | demo | mixed | null from its measured captures", async () => {
    for (const engine of ["gemini", "chatgpt", "claude", "perplexity"]) await addMetric(engine, 1, 5, 1);
    await addCapture("gemini", "n1");
    await addCapture("chatgpt", DEMO_SEED_MARKER);
    await addCapture("claude", "n1");
    await addCapture("claude", DEMO_SEED_MARKER);
    const footer = await read();
    expect(Object.fromEntries(footer.engine_data_sources.map((e) => [e.engine_key, e.data_source]))).toEqual({
      gemini: "live",
      chatgpt: "demo",
      claude: "mixed",
      perplexity: null,
    });
  });

  it("NEW-E-100a AC1 — weight overrides come from the workspace's overrides, null when none", async () => {
    expect((await read()).weight_overrides).toBeNull();
    const ws = randomUUID();
    const project = await makeProject(ws, { overrides: { scoring_weights: { presence: 0.5, sov: 0.2 } } });
    expect((await read("30d", ws, project)).weight_overrides).toEqual({ presence: 0.5, sov: 0.2 });
  });

  it("NEW-E-100a AC1 — scoring_version is the workspace's, and the sample reads that version only", async () => {
    const ws = randomUUID();
    const project = await makeProject(ws, { scoringVersion: "v2" });
    await addMetric("gemini", 1, 3, 1, { ws, project, version: "v2" });
    await addMetric("gemini", 1, 50, 1, { ws, project, version: "v1" });
    const footer = await read("30d", ws, project);
    expect(footer.scoring_version).toBe("v2");
    expect(footer.sample_size).toBe(3);
  });

  it("NEW-E-100a AC2 — a project in another workspace, or one that does not exist, is a 404", async () => {
    const otherWs = randomUUID();
    const otherProject = await makeProject(otherWs);
    await expect(read("30d", workspaceId, otherProject)).rejects.toBeInstanceOf(NotFoundError);
    await expect(read("30d", workspaceId, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("NEW-E-100a AC2 — a soft-deleted project is a 404", async () => {
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
    await expect(read()).rejects.toBeInstanceOf(NotFoundError);
  });
});
