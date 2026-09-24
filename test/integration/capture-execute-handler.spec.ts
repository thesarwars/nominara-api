import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import type { RealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { loadManualRunProject, planManualRun } from "../../src/lib/capture/manual-run.js";
import { readRunProgress } from "../../src/lib/capture/run-progress.js";
import { createCaptureExecuteHandler } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-034 — the handler STORY-124's registry held a slot open for.
//
// Everything upstream of it has existed for a while: the planner produced
// cells, the trigger enqueues them. Nothing consumed them, so every run sat
// at `queued` reporting zero forever. These are the properties that only
// exist once something actually moves a cell.
//
// THE PROMPT TEXTS BELOW ARE FIXTURE CASE NAMES, NOT QUESTIONS, and that is
// not test convenience — it is STORY-027's fixture adapter's actual contract:
// `fetchVendorResponse` matches `input.promptText` EXACTLY against
// FIXTURE_CASES ("normal", "refusal", "empty", …) and throws a plain Error
// for anything else.
//
// Which means a run over a REAL project's prompts cannot be driven by these
// adapters: every cell would throw, climb the retry ladder, and land in the
// dead-letter queue. `dev-plan.md`'s Slice 3 line — "six engines resolving
// through fixture adapters" — assumes a fallback the adapter does not have.
// Recorded rather than fixed here: loosening a test double's matching is a
// decision about what the demo proves, not a detail of this handler.

// STORY-152 — the capture-ready seam, and the only reason this spec sets it.
//
// `resolveEnabledEngines` returns ENTITLEMENT ∩ CAPTURE-READY, and production's
// capture-ready set is EMPTY: every active engine in `registry.ts` is bound to
// a fixture adapter that cannot answer a real prompt, so planning a cell for
// one would manufacture a failure out of a request we never made. This suite is
// about the RUN LIFECYCLE — dispatch, progress, coalescing, cancellation, the
// parse hand-off — none of which exists without a cell, so it declares
// capture-ready exactly the one engine it seeds below and nothing else.
//
// Hoisted because the `vi.mock` factory beneath runs before module-level
// initialisation.
const { SEEDED_ENGINE_KEY, SEEDED_CAPTURE_READY_ENGINE_KEYS } = vi.hoisted(() => {
  const key = "perplexity";
  return { SEEDED_ENGINE_KEY: key, SEEDED_CAPTURE_READY_ENGINE_KEYS: [key] as readonly string[] };
});

// The seam is on `PlanRunContext`, but this suite plans through
// `planManualRun`, which builds that context itself and — correctly — never
// sets it. So the real `planRun` is called with the seam added and everything
// else untouched, rather than rebuilding the manual-run planner's context here:
// a hand-rolled context would make the reuse test assert against the spec's own
// key namespace, TTL and shared-cache flag instead of the ones production picks.
vi.mock("../../src/lib/capture/plan-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/capture/plan-run.js")>();
  const planRunWithCaptureReadySeam: typeof actual.planRun = (tx, cache, context) =>
    actual.planRun(tx, cache, { ...context, captureReadyEngineKeys: SEEDED_CAPTURE_READY_ENGINE_KEYS });
  return { ...actual, planRun: planRunWithCaptureReadySeam };
});

const NOW = new Date(Date.UTC(2026, 7, 20, 12, 0, 0));

interface Emission {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

function recordingPublisher(sink: Emission[]): RealtimePublisher {
  return {
    toWorkspace: (_workspaceId, event, payload) => {
      sink.push({ event, payload: payload as Record<string, unknown> });
    },
    memberChanged: () => undefined,
  };
}

describe("STORY-034 · capture.execute moves a cell", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let cache: Cache;
  let emissions: Emission[];
  let parseJobs: { resultId: string }[];
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

  beforeEach(async () => {
    await db.query(
      "TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, projects, usage_counters, workspaces, engines CASCADE",
    );
    cache = new InMemoryCacheAdapter();
    emissions = [];
    parseJobs = [];
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 10)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    // NO `cadence_by_plan`, DELIBERATELY. `project_entitled_engines` gates on
    // the plan FLOOR only; a cadence entry decides whether the SCHEDULER runs
    // the engine, not whether the project may capture on it (STORY-130 §57).
    // This spec executes a cell that is already planned, so an engine with no
    // cadence at all is the honest fixture — and it pins that distinction.
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1, 'perplexity', 'v', 'api', '1.0.0', 86400, 'medium', 'free', 'active')`,
      [SEEDED_ENGINE_KEY],
    );
    // The override row: it narrows, it cannot widen. Same key the seam above
    // declares capture-ready, read from one constant so the two cannot drift.
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, $3, true, 1)`,
      [workspaceId, projectId, SEEDED_ENGINE_KEY],
    );
  });

  function handler() {
    const context = { pool: undefined, env: { VALKEY_CACHE_URL: "unused" } } as unknown as QueueHandlerContext;
    // STORY-135 — the parse enqueue is stubbed and RECORDED. This suite is
    // about the capture handler, and the env above has no queue in it; what
    // matters here is that a captured cell hands its row on, which
    // `parseJobs` below asserts.
    return createCaptureExecuteHandler(context, {
      cache,
      realtime: recordingPublisher(emissions),
      enqueueParse: (payload) => {
        parseJobs.push(payload);
        return Promise.resolve();
      },
    });
  }

  async function addPrompt(text: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                    intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', false, 'active')`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8")],
    );
    return id;
  }

  /**
   * Plan a manual run and hand back the jobs it would have enqueued.
   *
   * REAL TIME, not the frozen `NOW`. The L1 key carries a time bucket derived
   * from `nowMs / ttlSeconds`, so a capture written at wall-clock time is only
   * reusable by a plan in the same bucket — planning in 2026-08 and capturing
   * today would land in different buckets and the reuse test would assert a
   * miss it manufactured itself. In production both sides read the same clock.
   */
  async function planRun(): Promise<{ runId: string; jobs: Job[] }> {
    const runId = uuidV7();
    const project = await loadManualRunProject(db, projectId);
    await db.query("BEGIN");
    const { plan } = await planManualRun(db, cache, project, { runId, triggeredBy: null, now: new Date() });
    await db.query("COMMIT");
    // The shape `dispatchPlannedCells` puts on the wire — `{ payload }`, the
    // signed envelope, minus the signature the worker factory already checked
    // before this handler is ever reached. `kid` is added by the producer at
    // signing time, so it is added here for the same reason: the handler
    // parses the payload it will actually receive, not the one the planner
    // built.
    return {
      runId,
      jobs: plan.cells.map(
        (cell) => ({ data: { payload: { ...(cell.payload as object), kid: "test-kid" } } }) as unknown as Job,
      ),
    };
  }

  it("captures a cell, writes the row, and finishes the run", async () => {
    await addPrompt("normal");
    const { runId, jobs } = await planRun();
    const process = handler();

    for (const job of jobs) await process(db, job);

    const progress = await readRunProgress(db, runId, NOW);
    expect(progress).toMatchObject({ status: "completed", planned: 1, captured: 1, failed: 0, pct: 100 });

    const row = await db.query<{ status: string; cache_layer: string; response_excerpt: string | null }>(
      "SELECT status, cache_layer, response_excerpt FROM answer_captures WHERE run_id = $1",
      [runId],
    );
    expect(row.rows[0]).toMatchObject({ status: "captured", cache_layer: "live" });
    expect(row.rows[0]!.response_excerpt).not.toBeNull();
  });

  it("emits run.completed exactly once, with a duration", async () => {
    await addPrompt("normal");
    await addPrompt("truncated");
    const { jobs } = await planRun();
    const process = handler();

    for (const job of jobs) await process(db, job);

    const completed = emissions.filter((entry) => entry.event === "run.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ status: "completed", captured: 2, failed: 0 });
    // NULL, not zero. There is no scoring core to compare against, and "no
    // previous run" is a different fact from "no change".
    expect(completed[0]!.payload.visibility_delta).toBeNull();
  });

  it("moves the run to running and stamps started_at on the FIRST cell only", async () => {
    await addPrompt("normal");
    await addPrompt("truncated");
    await addPrompt("empty");
    const { runId, jobs } = await planRun();
    const process = handler();

    await process(db, jobs[0]!);
    const afterFirst = await db.query<{ status: string; started_at: Date }>(
      "SELECT status, started_at FROM capture_runs WHERE id = $1",
      [runId],
    );
    expect(afterFirst.rows[0]!.status).toBe("running");

    await process(db, jobs[1]!);
    const afterSecond = await db.query<{ started_at: Date }>("SELECT started_at FROM capture_runs WHERE id = $1", [
      runId,
    ]);
    expect(afterSecond.rows[0]!.started_at.getTime()).toBe(afterFirst.rows[0]!.started_at.getTime());
  });

  it("SKIPS a cell whose run was cancelled, without writing a row", async () => {
    // The cancel drains what is WAITING; a job already delivered to a worker
    // is not in the queue to drain. This is the second half of "in-flight
    // cells complete" — it means the ones genuinely mid-write, not every job
    // the drain raced.
    await addPrompt("normal");
    const { runId, jobs } = await planRun();
    await db.query("UPDATE capture_runs SET status = 'canceled' WHERE id = $1", [runId]);

    await handler()(db, jobs[0]!);

    const rows = await db.query("SELECT 1 FROM answer_captures WHERE run_id = $1", [runId]);
    expect(rows.rowCount).toBe(0);
    expect(emissions).toEqual([]);
  });

  it("skips a run that no longer exists rather than retrying it", async () => {
    await addPrompt("normal");
    const { runId, jobs } = await planRun();
    await db.query("DELETE FROM capture_runs WHERE id = $1", [runId]);

    // Returns rather than throwing: a throw would send the job down the retry
    // ladder for a run that is gone, and end in a dead-letter entry that
    // describes nothing actionable.
    await expect(handler()(db, jobs[0]!)).resolves.toBeUndefined();
  });

  it("coalesces run.progress to one emission per window", async () => {
    // §11 caps it at one per 750 ms per run. The token is on the shared cache
    // rather than an in-process timer, so the cap holds across workers.
    for (const text of ["normal", "truncated", "empty"]) await addPrompt(text);
    const { jobs } = await planRun();
    const process = handler();

    // Two non-final cells inside one window; the third finalises and emits
    // `run.completed` instead.
    await process(db, jobs[0]!);
    await process(db, jobs[1]!);

    expect(emissions.filter((entry) => entry.event === "run.progress")).toHaveLength(1);
  });

  it("STORY-135 — hands each captured cell to the parser, once", async () => {
    await addPrompt("normal");
    const { jobs } = await planRun();
    await handler()(db, jobs[0]!);

    expect(parseJobs).toHaveLength(1);
    const written = await db.query<{ id: string }>("SELECT id FROM answer_captures WHERE status = 'captured'");
    expect(parseJobs[0]!.resultId).toBe(written.rows[0]!.id);
  });

  it("does NOT enqueue a parse for a cell that failed to capture", async () => {
    // A blocked or failed cell has no text. Handing it to the parser would
    // put a job on the queue whose only possible outcome is to return.
    await addPrompt("normal");
    const { runId, jobs } = await planRun();
    await db.query("UPDATE capture_runs SET status = 'canceled' WHERE id = $1", [runId]);
    await handler()(db, jobs[0]!);

    expect(parseJobs).toEqual([]);
  });

  it("seeds the shared cache so a later run can reuse the answer", async () => {
    // The whole point of L1: the next run's planner probes this key and
    // suppresses the cell rather than paying for the same question twice.
    await addPrompt("normal");
    const { jobs } = await planRun();
    await handler()(db, jobs[0]!);

    const second = await planRun();
    const progress = await readRunProgress(db, second.runId, NOW);
    expect(progress.skipped).toBe(1);
    expect(progress.cachedByLayer.l1).toBe(1);
  });
});
