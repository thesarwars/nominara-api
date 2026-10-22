import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-A-7 — the run's last parsed cell asks for the day's rollup.
//
// WHY THE PARSE PATH. `capture.execute` finalises a run before its cells are
// parsed, so a rollup requested from there would read facts that do not exist
// yet. Only the parse that leaves no `captured` (unparsed) cell behind can know
// the facts are complete.

const ANSWER = "## Best CRMs\n\n1. **HubSpot** — we recommend it.\n2. Salesforce — deeper reporting.";
const CAPTURED_AT = "2026-03-10T23:30:00.000Z";

interface Enqueued {
  queue: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

describe("NEW-A-7 · rollup requested from the parse completion path", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let runId: string;
  let enqueued: Enqueued[];
  let sampleCounter = 0;

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

  async function seedWorkspace(timezone: string): Promise<{ workspaceId: string; projectId: string; promptId: string }> {
    const w = randomUUID();
    const p = randomUUID();
    const q = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth',$3)", [
      w,
      `w-${randomUUID().slice(0, 8)}`,
      timezone,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')`,
      [p, w, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [q, w, p],
    );
    return { workspaceId: w, projectId: p, promptId: q };
  }

  async function seedRun(w: string, p: string, planned: number): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells)
       VALUES ($1,$2,$3,'manual',ARRAY['gemini'],$4)`,
      [id, w, p, planned],
    );
    return id;
  }

  async function seedCapture(
    w: string,
    p: string,
    q: string,
    r: string,
    status: "captured" | "failed" | "parsed" = "captured",
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, response_excerpt,
          payload, flags, cache_layer, status, sample_index)
       VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','1.0.0','n1',$7,$8,$9::jsonb,'{}','live',$10,$11)`,
      [
        id,
        w,
        p,
        r,
        q,
        CAPTURED_AT,
        createHash("sha256").update(randomUUID()).digest(),
        ANSWER.slice(0, 280),
        JSON.stringify({ format: "markdown", text: ANSWER }),
        status,
        sampleCounter++,
      ],
    );
    return id;
  }

  beforeEach(async () => {
    await db.query(
      "TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces CASCADE",
    );
    ({ workspaceId, projectId, promptId } = await seedWorkspace("Asia/Tokyo"));
    runId = await seedRun(workspaceId, projectId, 2);
    enqueued = [];
  });

  function parseHandler() {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    return createCaptureParseHandler(context, {
      // These tests are about run-completion rollups; a late-fact dirty mark (STORY-042) must not reach a real Valkey.
      markRollupDirty: async () => undefined,
      enqueueRollup: async (queue, ws, payload, idempotencyKey) => {
        enqueued.push({ queue, workspaceId: ws, payload, idempotencyKey });
      },
    });
  }

  function job(resultId: string, force = false): Job {
    return {
      data: {
        payload: {
          workspaceId,
          kid: "test-kid",
          resultId,
          projectId,
          promptId,
          engineKey: "gemini",
          capturedAt: CAPTURED_AT,
          force,
        },
      },
    } as unknown as Job;
  }

  /** Runs the parse the way the worker does: inside the tenant transaction, effects after COMMIT. */
  function parseInTenant(resultId: string, force = false, afterHandler?: () => void): Promise<void> {
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await parseHandler()(tx, job(resultId, force));
      afterHandler?.();
    });
  }

  it("NEW-A-7 AC1 · the parse of the final cell enqueues exactly one rollup for the workspace-local day", async () => {
    const first = await seedCapture(workspaceId, projectId, promptId, runId);
    const second = await seedCapture(workspaceId, projectId, promptId, runId);

    await parseInTenant(first);
    expect(enqueued, "a cell is still unparsed").toHaveLength(0);

    await parseInTenant(second);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      queue: "rollup.metric_daily",
      workspaceId,
      // 23:30Z on the 10th is the 11th in Tokyo — the workspace's day, not UTC's.
      payload: { projectId, metricDate: "2026-03-11" },
      idempotencyKey: `rollup:${projectId}:run:${runId}`,
    });
  });

  it("NEW-A-7 AC1 · a second parse completion of the same run reuses the idempotency key", async () => {
    const first = await seedCapture(workspaceId, projectId, promptId, runId);
    const second = await seedCapture(workspaceId, projectId, promptId, runId);
    await parseInTenant(first);
    await parseInTenant(second);
    await parseInTenant(second, true);

    expect(new Set(enqueued.map((e) => e.idempotencyKey)).size).toBe(1);
  });

  it("NEW-A-7 AC1 · two last cells parsed at the same time enqueue exactly one rollup", async () => {
    // READ COMMITTED, no lock: tx2 parses B while tx1's parse of A is uncommitted,
    // sees A still `captured` and skips; tx1 then commits having seen B `captured`
    // and skips too. Neither requests the rollup. The run row lock serialises them.
    const a = await seedCapture(workspaceId, projectId, promptId, runId);
    const b = await seedCapture(workspaceId, projectId, promptId, runId);
    const second = new Client({ connectionString: container.getConnectionUri() });
    const monitor = new Client({ connectionString: container.getConnectionUri() });
    await second.connect();
    await monitor.connect();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let tx1Parsed!: () => void;
      const parsedA = new Promise<void>((resolve) => {
        tx1Parsed = resolve;
      });

      const tx1 = withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await parseHandler()(tx, job(a));
        tx1Parsed();
        await gate; // hold the transaction open, uncommitted
      });
      await parsedA;

      const tx2 = withTenantContext(second, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await parseHandler()(tx, job(b));
      });

      // Sequence tx2 behind tx1's lock: wait until it is blocked, bounded so the
      // unfixed (lock-free) code fails on the assertion below rather than hanging.
      const deadline = Date.now() + 3_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const locks = await monitor.query("SELECT 1 FROM pg_locks WHERE NOT granted LIMIT 1");
        waiting = (locks.rowCount ?? 0) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      await Promise.all([tx1, tx2]);

      expect(waiting, "the second completer must block on the run row lock").toBe(true);
      expect(enqueued).toHaveLength(1);
    } finally {
      await second.end();
      await monitor.end();
    }
  }, 30_000);

  it("NEW-A-7 AC2 · the enqueue happens after COMMIT, never inside the transaction", async () => {
    const first = await seedCapture(workspaceId, projectId, promptId, runId);
    const second = await seedCapture(workspaceId, projectId, promptId, runId);
    await parseInTenant(first);

    let insideTx = -1;
    await parseInTenant(second, false, () => {
      insideTx = enqueued.length;
    });
    expect(insideTx).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  it("NEW-A-7 AC2 · a rolled-back parse enqueues nothing", async () => {
    const first = await seedCapture(workspaceId, projectId, promptId, runId);
    const second = await seedCapture(workspaceId, projectId, promptId, runId);
    await parseInTenant(first);

    await expect(
      withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await parseHandler()(tx, job(second));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(enqueued).toHaveLength(0);
  });

  it("NEW-A-7 · a run whose cells are not all accounted for does not enqueue", async () => {
    // planned 3, only 2 cells exist so far.
    const three = await seedRun(workspaceId, projectId, 3);
    const a = await seedCapture(workspaceId, projectId, promptId, three);
    const b = await seedCapture(workspaceId, projectId, promptId, three);
    await parseInTenant(a);
    await parseInTenant(b);
    expect(enqueued).toHaveLength(0);
  });

  it("NEW-A-7 · a failed sibling counts as accounted for, so the last parse still enqueues", async () => {
    const a = await seedCapture(workspaceId, projectId, promptId, runId);
    await seedCapture(workspaceId, projectId, promptId, runId, "failed");
    await parseInTenant(a);
    expect(enqueued).toHaveLength(1);
  });

  it("NEW-A-7 · a capture with no run row enqueues nothing", async () => {
    const orphan = await seedCapture(workspaceId, projectId, promptId, uuidV7());
    await parseInTenant(orphan);
    expect(enqueued).toHaveLength(0);
  });

  it("NEW-A-7 AC3 · the rollup job under workspace A's context never reads or writes workspace B", async () => {
    const b = await seedWorkspace("UTC");
    const bRun = await seedRun(b.workspaceId, b.projectId, 1);
    const bCapture = await seedCapture(b.workspaceId, b.projectId, b.promptId, bRun);
    // B's facts exist and are parsed by B's own context.
    await withTenantContext(db, { workspaceId: b.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await createCaptureParseHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
        markRollupDirty: async () => undefined,
        enqueueRollup: async () => undefined,
      })(tx, {
        data: {
          payload: {
            workspaceId: b.workspaceId,
            kid: "k",
            resultId: bCapture,
            projectId: b.projectId,
            promptId: b.promptId,
            engineKey: "gemini",
            capturedAt: CAPTURED_AT,
            force: false,
          },
        },
      } as unknown as Job);
    });

    const a = await seedCapture(workspaceId, projectId, promptId, runId);
    await parseInTenant(a);

    const rollup = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, { enqueueVerifyPresence: async () => undefined, enqueueTaskGenerate: async () => undefined });
    const rollupJob = (project: string, ws: string): Job =>
      ({ data: { payload: { workspaceId: ws, kid: "k", projectId: project, metricDate: "2026-03-11" } } }) as unknown as Job;

    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      // The runtime role, so RLS is in force (the test connection is a superuser).
      await tx.query("SET LOCAL ROLE nominara_app");
      await rollup(tx, rollupJob(projectId, workspaceId));
      // A forged payload naming B's project: invisible under A's context.
      await rollup(tx, rollupJob(b.projectId, workspaceId));
    });

    const rows = await db.query<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM metric_daily");
    expect(rows.rows.map((r) => r.workspace_id)).toEqual([workspaceId]);
    const bRows = await db.query("SELECT 1 FROM metric_daily WHERE project_id = $1", [b.projectId]);
    expect(bRows.rowCount).toBe(0);
  });
});
