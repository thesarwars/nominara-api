import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { RealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureExecuteHandler } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-A-7 — a run whose LAST cell to settle FAILED rather than parsed.
//
// Only `capture.parse` requested the rollup, so a run whose final cell failed
// terminally in `capture.execute` (no parse follows it) was never rolled up,
// and the rollup cron is tenant-scoped so nothing else covers it.

// A terminal failure, driven through the real handler: the cell row a real
// failed capture writes, and the outcome `captureCell` returns for it.
vi.mock("../../src/lib/capture/execute-cell.js", () => ({
  captureCell: async (
    tx: import("pg").ClientBase,
    _cache: unknown,
    input: { workspaceId: string; projectId: string; runId: string; promptId: string; engineKey: string; sampleIndex: number },
  ) => {
    await tx.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode,
          adapter_version, normalizer_version, content_hash, flags, cache_layer, status, sample_index, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-03-10T23:30:00.000Z','api','1.0.0','n1',$7,'{}','live','failed',$8,'auth_failed')`,
      [
        randomUUID(),
        input.workspaceId,
        input.projectId,
        input.runId,
        input.promptId,
        input.engineKey,
        createHash("sha256").update(randomUUID()).digest(),
        input.sampleIndex,
      ],
    );
    return { kind: "failed", errorCode: "auth_failed" };
  },
}));

const publisher: RealtimePublisher = {
  toWorkspace: () => undefined,
  toProject: () => undefined,
  memberChanged: () => undefined,
};

describe("NEW-A-7 · rollup requested when the last cell fails terminally", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let runId: string;
  let enqueued: { queue: string; payload: Record<string, unknown>; idempotencyKey: string }[];

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
    await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    runId = uuidV7();
    enqueued = [];
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','Asia/Tokyo')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells)
       VALUES ($1,$2,$3,'manual',ARRAY['gemini'],2)`,
      [runId, workspaceId, projectId],
    );
  });

  async function seedParsedCell(): Promise<void> {
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode,
          adapter_version, normalizer_version, content_hash, flags, cache_layer, status, sample_index)
       VALUES ($1,$2,$3,$4,$5,'gemini','2026-03-10T23:30:00.000Z','api','1.0.0','n1',$6,'{}','live','parsed',0)`,
      [randomUUID(), workspaceId, projectId, runId, promptId, createHash("sha256").update(randomUUID()).digest()],
    );
  }

  function executeJob(sampleIndex: number): Job {
    return {
      data: {
        payload: {
          workspaceId,
          kid: "k",
          projectId,
          runId,
          promptId,
          promptText: "q",
          engineKey: "gemini",
          sampleIndex,
          adapterVersion: "1.0.0",
          ttlSeconds: 3600,
          locale: "en-US",
          personaHint: null,
        },
      },
    } as unknown as Job;
  }

  function run(sampleIndex: number): Promise<void> {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const handler = createCaptureExecuteHandler(context, {
      cache: new InMemoryCacheAdapter(),
      realtime: publisher,
      enqueueParse: async () => undefined,
      enqueueRollup: async (queue, _ws, payload, idempotencyKey) => {
        enqueued.push({ queue, payload, idempotencyKey });
      },
    });
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await handler(tx, executeJob(sampleIndex));
    });
  }

  it("NEW-A-7 AC1 · the last cell failing terminally, with its sibling parsed, enqueues one rollup", async () => {
    await seedParsedCell();
    await run(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      queue: "rollup.metric_daily",
      payload: { projectId, metricDate: "2026-03-11" },
      idempotencyKey: `rollup:${projectId}:run:${runId}`,
    });
  });

  it("NEW-A-7 · a terminal failure that leaves a captured-but-unparsed sibling does not enqueue (that parse will)", async () => {
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode,
          adapter_version, normalizer_version, content_hash, flags, cache_layer, status, sample_index)
       VALUES ($1,$2,$3,$4,$5,'gemini','2026-03-10T23:30:00.000Z','api','1.0.0','n1',$6,'{}','live','captured',0)`,
      [randomUUID(), workspaceId, projectId, runId, promptId, createHash("sha256").update(randomUUID()).digest()],
    );
    await run(1);
    expect(enqueued).toHaveLength(0);
  });

  it("NEW-A-7 · a terminal failure while another cell is still outstanding does not enqueue", async () => {
    await run(1); // planned 2, only this one settled
    expect(enqueued).toHaveLength(0);
  });
});
