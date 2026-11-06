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

// STORY-111 NFR-CMP-01, scenario 8 - the minimisation pass runs BEFORE persistence: the excerpt that surfaces in the interface and in exports is
// written with placeholders. The dual-written payload keeps the verbatim text (audit fidelity; shorter retention, expireRawCaptures).
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

describe("STORY-111 · contact identifiers are minimised before the excerpt is persisted", () => {
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

  async function commit(capture: RawCapture): Promise<string> {
    const resultId = uuidV7();
    const fetched: CellFetched = {
      write: { status: "captured", adapter, raw: capture },
      resultId,
      rawObjectKey: null,
      costUsd: 0,
      seed: undefined,
      now: new Date("2026-10-30T10:00:00.000Z"),
      outcome: { kind: "captured", latencyMs: capture.latencyMs },
    };
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await commitCell(tx, new InMemoryCacheAdapter(), input(0), fetched);
    });
    return resultId;
  }

  it("S8 the persisted excerpt holds placeholders where the answer held an email, a phone number and an address; the payload keeps the verbatim text", async () => {
    const text = "Try Acme. Email sales@acme.example, call +1 415 555 2671, visit 10 Downing Street.";
    const id = await commit(raw({ text }));
    const row = (await db.query<{ response_excerpt: string; payload: { text: string } }>("SELECT response_excerpt, payload FROM answer_captures WHERE id = $1", [id])).rows[0]!;
    expect(row.response_excerpt).toBe("Try Acme. Email [email], call [phone], visit [address].");
    expect(row.payload.text).toBe(text);
  });

  it("S8 an answer with no identifier is stored byte-for-byte (names are preserved), and a long one is cut AFTER minimising", async () => {
    const plain = "Michael Kors and Ben & Jerry's lead the list.";
    const a = await commit(raw({ text: plain }));
    expect((await db.query("SELECT response_excerpt FROM answer_captures WHERE id = $1", [a])).rows[0]!.response_excerpt).toBe(plain);
    await db.query("TRUNCATE answer_captures");
    const long = `${"x".repeat(270)} bob@example.com tail`;
    const b = await commit(raw({ text: long }));
    const excerpt = (await db.query<{ response_excerpt: string }>("SELECT response_excerpt FROM answer_captures WHERE id = $1", [b])).rows[0]!.response_excerpt;
    expect(excerpt).not.toMatch(/bob|@|example\.com/);
    expect(excerpt.length).toBeLessThanOrEqual(280);
  });
});
