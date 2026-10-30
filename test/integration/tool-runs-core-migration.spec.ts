import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// Migration 0153 - STORY-078. The three guarantee-carrying constraints, the size trigger and the write-once lifecycle, proven by
// REJECTION against the real chain. Scenario numbers are the story's Test scenarios table.
//   * ck_tr_engine_set: owner decision 26 (2026-10-30) allows Gemini in Tools; the most expensive engine (claude) stays barred.
//   * ck_tr_shape: known gap E-1 closed - an EMPTY engine or prompt array used to pass because array_length('{}') is NULL.
//   * app.tool_run_status_write_once: a run leaves `running` once (AC5).

const NAME = "0153_tool_runs_core_guards";

describe("migration 0153 - tool_runs core guards", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let baselineDir: string;
  const workspaceId = randomUUID();

  const insert = async (over: Record<string, unknown> = {}): Promise<string> => {
    const row: Record<string, unknown> = {
      tool_key: "visibility_scan",
      brand_name: "Acme",
      query_text: "best crm",
      engine_keys: ["perplexity"],
      input_hash: Buffer.alloc(32, 1),
      expires_at: new Date(Date.now() + 86_400_000),
      ...over,
    };
    const keys = Object.keys(row);
    const result = await client.query<{ id: string }>(
      `INSERT INTO tool_runs (workspace_id, ${keys.join(", ")}) VALUES ($1, ${keys.map((_, i) => `$${String(i + 2)}`).join(", ")}) RETURNING id`,
      [workspaceId, ...keys.map((k) => row[k])],
    );
    return result.rows[0]!.id;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    baselineDir = await mkdtemp(path.join(tmpdir(), "nominara-0153-"));
    for (const entry of await readdir(MIGRATIONS_DIR)) {
      if (entry.slice(0, 4) < "0153") await copyFile(path.join(MIGRATIONS_DIR, entry), path.join(baselineDir, entry));
    }
    await migrateUp(client, baselineDir);
    await client.query(`INSERT INTO plans (key, display_name, monthly_price, annual_price, entitlements) VALUES ('free','Free',0,0,'{}') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'free')`, [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
  }, 300_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  });

  it("owner decision 26 - before 0153 a run naming gemini is rejected (the hazard the migration removes)", async () => {
    await expect(insert({ engine_keys: ["gemini"] })).rejects.toThrow(/ck_tr_engine_set/);
  });

  it("migrates up on a POPULATED table and keeps the row", async () => {
    await insert();
    await migrateUp(client);
    expect((await client.query("SELECT count(*)::int AS n FROM tool_runs")).rows[0]).toEqual({ n: 1 });
  });

  it("scenario 2 + owner decision 26 - gemini is allowed in the Tools engine set; claude is still rejected by the engine-set constraint", async () => {
    await expect(insert({ engine_keys: ["gemini"] })).resolves.toBeDefined();
    await expect(insert({ engine_keys: ["perplexity", "gemini"] })).resolves.toBeDefined();
    await expect(insert({ engine_keys: ["claude"] })).rejects.toThrow(/ck_tr_engine_set/);
    await expect(insert({ engine_keys: ["gemini", "claude"] })).rejects.toThrow(/ck_tr_engine_set/);
  });

  it("scenario 1 - each tool type with its required input missing is rejected by the shape constraint", async () => {
    const hash = Buffer.alloc(32, 2);
    await expect(insert({ tool_key: "visibility_scan", brand_name: null })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "visibility_scan", query_text: null })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "prompt_research", engine_keys: ["perplexity"], prompt_texts: null, input_hash: hash })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "competitor_finder", brand_url: null })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "aux_audit", engine_keys: [], target_url: null })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "schema_builder", engine_keys: [], result_json: null })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "compare_runs", engine_keys: [], diff_base_run_id: null })).rejects.toThrow(/ck_tr_shape/);
  });

  it("scenario 1 - well-formed rows of each tool type are accepted", async () => {
    const [base, other] = [await insert({ input_hash: Buffer.alloc(32, 3) }), await insert({ input_hash: Buffer.alloc(32, 4) })];
    await expect(insert({ tool_key: "prompt_research", prompt_texts: ["a?"] })).resolves.toBeDefined();
    await expect(insert({ tool_key: "competitor_finder", brand_url: "https://a.test" })).resolves.toBeDefined();
    await expect(insert({ tool_key: "aux_audit", engine_keys: [], target_url: "https://a.test" })).resolves.toBeDefined();
    await expect(insert({ tool_key: "schema_builder", engine_keys: [], result_json: JSON.stringify({ a: 1 }) })).resolves.toBeDefined();
    await expect(insert({ tool_key: "compare_runs", engine_keys: [], diff_base_run_id: base, diff_compare_run_id: other })).resolves.toBeDefined();
  });

  it("known gap E-1 closed - an EMPTY engine set on a scan, or an EMPTY prompt list on prompt research, is rejected (not waved through as NULL)", async () => {
    await expect(insert({ tool_key: "visibility_scan", engine_keys: [] })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "prompt_research", engine_keys: ["perplexity"], prompt_texts: [] })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "visibility_scan", engine_keys: ["a", "b", "c", "d", "e"] })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "prompt_research", prompt_texts: Array.from({ length: 11 }, (_, i) => `p${String(i)}?`) })).rejects.toThrow(/ck_tr_shape/);
    await expect(insert({ tool_key: "visibility_scan", engine_keys: ["a", "b", "c", "d"] })).resolves.toBeDefined();
    await expect(insert({ tool_key: "prompt_research", prompt_texts: Array.from({ length: 10 }, (_, i) => `p${String(i)}?`) })).resolves.toBeDefined();
  });

  it("scenario 3 - a debit against either free tool is rejected by the zero-debit constraint", async () => {
    await expect(insert({ tool_key: "schema_builder", engine_keys: [], result_json: JSON.stringify({}), credits_charged: 1 })).rejects.toThrow(/ck_tr_free_tools/);
    const [x, y] = [await insert({ input_hash: Buffer.alloc(32, 5) }), await insert({ input_hash: Buffer.alloc(32, 6) })];
    await expect(insert({ tool_key: "compare_runs", engine_keys: [], diff_base_run_id: x, diff_compare_run_id: y, credits_charged: 1 })).rejects.toThrow(/ck_tr_free_tools/);
  });

  it("scenario 4 - a payload above the ceiling is rejected on insert, and an update that grows one past it is rejected too", async () => {
    const big = JSON.stringify({ blob: "x".repeat(24_600) });
    await expect(insert({ result_json: big })).rejects.toThrow(/24576 byte limit/);
    const id = await insert({ result_json: JSON.stringify({ blob: "ok" }) });
    await expect(client.query("UPDATE tool_runs SET result_json = $1 WHERE id = $2", [big, id])).rejects.toThrow(/24576 byte limit/);
    expect((await client.query<{ blob: string }>("SELECT result_json->>'blob' AS blob FROM tool_runs WHERE id = $1", [id])).rows[0]!.blob).toBe("ok");
  });

  it("scenario 7 - a run leaves running once: running -> exactly one terminal state, and a terminal state is never rewritten", async () => {
    const id = await insert({ input_hash: Buffer.alloc(32, 7) });
    await expect(client.query("UPDATE tool_runs SET status = 'completed' WHERE id = $1", [id])).resolves.toBeDefined();
    for (const next of ["failed", "partial", "running"]) {
      await expect(client.query("UPDATE tool_runs SET status = $2 WHERE id = $1", [id, next])).rejects.toThrow(/tool_runs status/);
    }
    expect((await client.query("SELECT status FROM tool_runs WHERE id = $1", [id])).rows[0]).toEqual({ status: "completed" });
  });

  it("scenario 7 - an UPDATE that does not change the status (pin, conversion, a repeated terminal write of the same value) is not a transition", async () => {
    const id = await insert({ input_hash: Buffer.alloc(32, 8) });
    await client.query("UPDATE tool_runs SET status = 'partial' WHERE id = $1", [id]);
    await expect(client.query("UPDATE tool_runs SET pinned = true, status = 'partial' WHERE id = $1", [id])).resolves.toBeDefined();
  });

  it("scenario 14 + 7 - a terminal run may still expire (the sweep's one allowed move), and an expired run stays expired", async () => {
    const id = await insert({ input_hash: Buffer.alloc(32, 9) });
    await client.query("UPDATE tool_runs SET status = 'failed' WHERE id = $1", [id]);
    await expect(client.query("UPDATE tool_runs SET status = 'expired', result_json = NULL WHERE id = $1", [id])).resolves.toBeDefined();
    await expect(client.query("UPDATE tool_runs SET status = 'completed' WHERE id = $1", [id])).rejects.toThrow(/tool_runs status/);
  });

  it("scenario 7 - a run with a nonexistent status is still refused by the status CHECK (the trigger does not replace it)", async () => {
    const id = await insert({ input_hash: Buffer.alloc(32, 10) });
    await expect(client.query("UPDATE tool_runs SET status = 'bogus' WHERE id = $1", [id])).rejects.toThrow();
  });

  it("down restores the original constraints (gemini barred again) and removes the trigger; up again restores them", async () => {
    await client.query("DELETE FROM tool_runs WHERE engine_keys && ARRAY['gemini']");
    await client.query(await readFile(path.join(MIGRATIONS_DIR, `${NAME}.down.sql`), "utf8"));
    await expect(insert({ engine_keys: ["gemini"] })).rejects.toThrow(/ck_tr_engine_set/);
    expect((await client.query("SELECT 1 FROM pg_trigger WHERE tgname = 'tr_tool_runs_status_write_once'")).rowCount).toBe(0);
    expect((await client.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'tool_run_status_write_once'")).rowCount).toBe(0);
    await client.query(await readFile(path.join(MIGRATIONS_DIR, `${NAME}.up.sql`), "utf8"));
    await expect(insert({ engine_keys: ["gemini"] })).resolves.toBeDefined();
  });
});
