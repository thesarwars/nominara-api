import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { aggregateRange } from "../../src/lib/rollup/aggregate-day.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { recordExhaustedCell, type CaptureCellInput } from "../../src/lib/capture/execute-cell.js";
import { recordSuppressedCells } from "../../src/lib/capture/record-suppressed.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { testCacheRedisUrl } from "../support/test-valkey.js";

// STORY-136 AC9 (second-engineer review, BLOCKER) — EVERY writer of answer_captures stamps the scoring library's
// SCORING_VERSION, never the column default. The library constant is mocked to a value no migration default knows, so a
// writer that leaves the stamp to the default ('v1') cannot pass by coincidence.

const MOCKED = "v9-test";

vi.mock("../../src/lib/scoring/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/scoring/index.js")>();
  return { ...actual, SCORING_VERSION: "v9-test" };
});

describe("STORY-136 AC9 · every answer_captures writer stamps SCORING_VERSION", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let runId: string;

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
    await db.query("TRUNCATE mention_facts, citation_facts, answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    runId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys) VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'])`,
      [runId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, 'best crm', sha256('best crm'::bytea), 'recommendation', 'consideration', false, 'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  async function versionsOf(): Promise<string[]> {
    const rows = await db.query<{ scoring_version: string }>("SELECT scoring_version FROM answer_captures WHERE run_id = $1", [runId]);
    return rows.rows.map((row) => row.scoring_version);
  }

  it("STORY-136 AC9 · capture.parse's no-text branch (refusal / L2-suppressed) stamps the library version", async () => {
    const resultId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
          normalizer_version, content_hash, payload, flags, cache_layer, status)
       VALUES ($1,$2,$3,$4,$5,'perplexity', now(), 'api','1.0.0','n1',$6,'{}'::jsonb,'{}','live','captured')`,
      [resultId, workspaceId, projectId, runId, promptId, createHash("sha256").update("x").digest()],
    );
    const context = { pool: undefined, env: { VALKEY_CACHE_URL: testCacheRedisUrl() } } as unknown as QueueHandlerContext;
    const job = {
      data: {
        payload: { workspaceId, kid: "test-kid", resultId, projectId, promptId, engineKey: "perplexity", capturedAt: new Date().toISOString(), force: false },
      },
    } as unknown as Job;
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => createCaptureParseHandler(context, { enqueueRollup: async () => undefined })(tx, job));

    const row = await db.query<{ status: string; scoring_version: string }>("SELECT status, scoring_version FROM answer_captures WHERE id = $1", [resultId]);
    expect(row.rows[0]).toEqual({ status: "parsed", scoring_version: MOCKED });

    // …and the scorecard's own question: under the current version that refusal is still a cell.
    const aggregates = await aggregateRange(db, projectId, "2000-01-01", "2100-01-01", "UTC", MOCKED);
    expect(aggregates.find((entry) => entry.entityType === "brand")?.cellsTotal).toBe(1);
  });

  it("STORY-136 AC9 · execute-cell's writeCell INSERT stamps the library version", async () => {
    const input: CaptureCellInput = {
      workspaceId, projectId, runId, promptId, promptText: "best crm", engineKey: "perplexity", sampleIndex: 0,
      adapterVersion: "1.0.0", ttlSeconds: 60, locale: "en-US", personaHint: null, normalizerVersion: "n1",
    };
    await recordExhaustedCell(db, input, new Error("boom"));
    expect(await versionsOf()).toEqual([MOCKED]);
  });

  it("STORY-136 AC9 · record-suppressed's INSERT stamps the library version", async () => {
    const written = await recordSuppressedCells(
      db,
      { workspaceId, projectId, runId, normalizerVersion: "n1", captureMode: "api", aliasFingerprint: createHash("sha256").update("a").digest() },
      [{ layer: "l1", promptId, engineKey: "perplexity", sampleIndex: 0, contentHash: Buffer.alloc(32, 7), payload: { text: "t" }, excerpt: "t", adapterVersion: "1.0.0" }],
    );
    expect(written).toBe(1);
    expect(await versionsOf()).toEqual([MOCKED]);
  });
});
