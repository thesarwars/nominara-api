import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoStructureDetailSchema } from "../../contracts/analytics/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { testCacheRedisUrl } from "../support/test-valkey.js";

// STORY-060 checkpoint-1 — the A3 analysis must be COMPUTED in a running
// system: by the rollup.metric_daily handler, from the facts the real parser
// wrote (Gemini) — not only by a test calling refreshProjectGeo directly.

const ANSWER = [
  "## Best CRMs for scaling teams",
  "",
  "1. **HubSpot** — we recommend it for most teams; the pipelines are excellent.",
  "2. Salesforce — deeper reporting, however it has a steep learning curve.",
  "3. Zoho CRM — cheapest at scale.",
].join("\n");

describe("STORY-060 · A3 is computed by the rollup handler from parser output", () => {
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

  beforeEach(async () => {
    await db.query(
      "TRUNCATE geo_analyses, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'best crm',sha256('best crm'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  async function capture(engineKey: string, text: string): Promise<{ id: string; at: string }> {
    const id = randomUUID();
    const at = new Date().toISOString();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, response_excerpt, payload, flags, cache_layer, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'api','1.0.0','n1',$8,$9,$10::jsonb,'{}','live','captured')`,
      [id, workspaceId, projectId, uuidV7(), promptId, engineKey, at, createHash("sha256").update(text + id).digest(), text.slice(0, 280), JSON.stringify({ format: "markdown", text })],
    );
    return { id, at };
  }

  // As the worker runs it: inside the job's tenant transaction, which owns COMMIT and the after-commit tasks.
  const parse = (engineKey: string, c: { id: string; at: string }) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) =>
      createCaptureParseHandler({ pool: undefined, env: { VALKEY_CACHE_URL: testCacheRedisUrl() } } as unknown as QueueHandlerContext)(tx, {
        data: { payload: { workspaceId, kid: "k", resultId: c.id, projectId, promptId, engineKey, capturedAt: c.at, force: false } },
      } as unknown as Job),
    );

  // Inside a tenant transaction, as `withTenantJob` runs it, so `app.current_workspace()` is set: the loaders' workspace predicate
  // (STORY-061 r4) reads nothing without it, which is the production behaviour. The context is set transaction-locally on the same
  // connection; `withTenantContext` is not used because its after-commit hooks would reach for a queue this test does not have.
  const rollup = async () => {
    await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext)(db, {
        data: { payload: { workspaceId, kid: "k", projectId } },
      } as unknown as Job);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  };

  const structureRows = async () =>
    (await db.query("SELECT * FROM geo_analyses WHERE project_id = $1 AND analysis = 'structure' ORDER BY window_days", [projectId])).rows;

  it("a Gemini window parsed by the real parser is analysed by the rollup handler, as live data", async () => {
    for (let i = 0; i < 31; i++) await parse("gemini", await capture("gemini", ANSWER));
    expect(await structureRows()).toHaveLength(0);

    await rollup();

    const rows = await structureRows();
    const thirty = rows.find((r) => r.window_days === 30);
    expect(thirty).toBeDefined();
    expect(thirty.sufficient).toBe(true);
    expect(thirty.evidence_cells).toBe(31);

    const a = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
      new GeoService(new TasksService(new NoopRealtimePublisher())).analysis(projectId, "structure", { timeframe: "30d" }),
    );
    const detail = geoStructureDetailSchema.parse(a.detail);
    expect(detail.total).toBe(31);
    expect(detail.engines).toEqual([expect.objectContaining({ engine: "gemini", data_source: "live", total: 31 })]);
  }, 120_000);

  it("a second handler run replaces the row rather than adding one", async () => {
    for (let i = 0; i < 30; i++) await parse("gemini", await capture("gemini", ANSWER));
    await rollup();
    const before = await structureRows();
    await rollup();
    expect(await structureRows()).toHaveLength(before.length);
  }, 120_000);

  it("a window under the minimum is persisted as insufficient with its reason, not skipped", async () => {
    for (let i = 0; i < 3; i++) await parse("gemini", await capture("gemini", ANSWER));
    await rollup();
    const thirty = (await structureRows()).find((r) => r.window_days === 30);
    expect(thirty).toMatchObject({ sufficient: false, evidence_cells: 3 });
    expect(thirty.suppression_reason).toMatch(/30/);
  }, 120_000);

  it("STORY-062 · a READ never recomputes structure: facts changed after the rollup leave the detail matching the stored row", async () => {
    for (let i = 0; i < 31; i++) await parse("gemini", await capture("gemini", ANSWER));
    await rollup();
    const read = () =>
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new GeoService(new TasksService(new NoopRealtimePublisher())).analysis(projectId, "structure", { timeframe: "30d" }));
    const before = await read();
    expect(geoStructureDetailSchema.parse(before.detail).total).toBe(31);

    for (let i = 0; i < 5; i++) await parse("gemini", await capture("gemini", ANSWER));

    const stored = (await structureRows()).find((r) => r.window_days === 30);
    expect(stored.evidence_cells).toBe(31);
    const after = await read();
    expect(after.detail).toEqual(before.detail);
    expect(geoStructureDetailSchema.parse(after.detail).total).toBe(stored.evidence_cells);

    await rollup();
    expect(geoStructureDetailSchema.parse((await read()).detail).total).toBe(36);
  }, 120_000);
});
