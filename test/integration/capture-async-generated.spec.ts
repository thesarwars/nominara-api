import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { commitCell, type CaptureCellInput, type CellFetched } from "../../src/lib/capture/execute-cell.js";
import type { CaptureAdapter, RawCapture } from "../../src/lib/engines/contract.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-029 NFR-SIM-12 - the async flag a licensed-SERP adapter reports is PERSISTED on the capture row (answer_captures.async_generated),
// and the three states stay distinct: true (loaded on demand), false (first response, or no overview), NULL (the surface reports none).
// Real Postgres, real commitCell; run under the shared docker lock.

const adapter: CaptureAdapter = {
  engineKey: "google_aio",
  captureMode: "licensed_serp",
  adapterVersion: "0.1.0+serpapi.1",
  supportsCitations: true,
  concurrencyPerTask: 1,
  capture: () => Promise.reject(new Error("not used")),
  healthProbe: () => Promise.resolve({ ok: true, latencyMs: 1 }),
};

function raw(over: Partial<RawCapture>): RawCapture {
  return { text: "an answer", format: "markdown", truncated: false, responseTokensEst: 3, latencyMs: 5, costUsd: 0.015, ...over };
}

describe("STORY-029 · async_generated is persisted on every capture that reports it", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let input: (sampleIndex: number) => CaptureCellInput;

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
    await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    const projectId = randomUUID();
    const promptId = randomUUID();
    const runId = uuidV7();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','Asia/Tokyo')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')`, [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    await db.query(`INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells) VALUES ($1,$2,$3,'manual',ARRAY['google_aio'],3)`, [runId, workspaceId, projectId]);
    input = (sampleIndex) => ({
      workspaceId, projectId, runId, promptId, promptText: "q", engineKey: "google_aio", sampleIndex,
      adapterVersion: "0.1.0", ttlSeconds: 3600, locale: "en-US", personaHint: null, normalizerVersion: "n1",
    });
  });

  async function commit(sampleIndex: number, capture: RawCapture): Promise<void> {
    const fetched: CellFetched = {
      write: { status: "captured", adapter, raw: capture },
      resultId: uuidV7(),
      rawObjectKey: null,
      costUsd: 0,
      seed: undefined,
      now: new Date("2026-10-30T10:00:00.000Z"),
      outcome: { kind: "captured", latencyMs: capture.latencyMs },
    };
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await commitCell(tx, new InMemoryCacheAdapter(), input(sampleIndex), fetched);
    });
  }

  async function stored(sampleIndex: number): Promise<{ async_generated: boolean | null; flags: string[]; engine_key: string; capture_mode: string; adapter_version: string }> {
    const result = await db.query(`SELECT async_generated, flags, engine_key, capture_mode, adapter_version FROM answer_captures WHERE sample_index = $1`, [sampleIndex]);
    return result.rows[0];
  }

  it("true, false and NULL are stored as themselves, and the flag and vendor version travel with the row", async () => {
    await commit(0, raw({ asyncGenerated: true }));
    await commit(1, raw({ text: "", flags: ["no_ai_overview_for_query"], asyncGenerated: false }));
    await commit(2, raw({ asyncGenerated: null }));

    expect((await stored(0)).async_generated).toBe(true);
    const absent = await stored(1);
    expect(absent.async_generated).toBe(false);
    expect(absent.flags).toEqual(["no_ai_overview_for_query"]);
    expect(absent).toMatchObject({ engine_key: "google_aio", capture_mode: "licensed_serp", adapter_version: "0.1.0+serpapi.1" });
    expect((await stored(2)).async_generated).toBeNull();
  });

  it("an engine with no async notion leaves the column NULL", async () => {
    await commit(0, raw({}));
    expect((await stored(0)).async_generated).toBeNull();
  });
});
