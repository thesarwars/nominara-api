import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { captureL1Key } from "../../src/lib/capture/l1-cache-key.js";
import { adapterMajorOf } from "../../src/lib/capture/l1-exact-hash.js";
import { estimateManualRun, loadManualRunProject } from "../../src/lib/capture/manual-run.js";
import { deepScanPrice } from "../../src/lib/capture/deep-scan-price.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";

// STORY-034 AC1 — "A free estimate endpoint returns the exact price and the
// cache forecast for a manual run. This is what the confirmation modal
// renders."
//
// Test scenario 1: "Request an estimate → Exact price and cache forecast;
// NOTHING CHARGED." The last clause is asserted structurally rather than by
// reading a wallet: the estimate opens no transaction and writes no row, so
// the assertion is that the tables it could have touched are untouched.

const TTL_SECONDS = 86_400;
const NOW = new Date(Date.UTC(2026, 7, 20, 12, 0, 0));

describe("STORY-034 · estimating a manual deep scan", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let cache: Cache;
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
    workspaceId = randomUUID();
    projectId = randomUUID();
    await seedWorkspace("growth");
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 10)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ('perplexity', 'perplexity', 'v', 'api', '1.0.0', $1, 'medium', 'free', 'active')`,
      [TTL_SECONDS],
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, 'perplexity', true, 1)`,
      [workspaceId, projectId],
    );
  });

  async function seedWorkspace(planKey: string): Promise<void> {
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, $3)", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
      planKey,
    ]);
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
   * Seed the shared answer cache so the L1 probe finds `text`.
   *
   * `cacheKeyNamespace()` rather than a literal "test": the estimate builds
   * its key from the deployment namespace, and a test that seeded a different
   * one would assert a miss it manufactured itself.
   */
  async function seedL1(text: string): Promise<void> {
    await cache.set(
      captureL1Key({
        env: cacheKeyNamespace(),
        engineKey: "perplexity",
        adapterMajor: adapterMajorOf("1.0.0"),
        promptText: text,
        locale: "en-US",
        personaHint: null,
        ttlSeconds: TTL_SECONDS,
        nowMs: NOW.getTime(),
      }),
      JSON.stringify({ v: 1, contentHash: "a".repeat(64), payload: { answer: "cached" }, excerpt: "cached" }),
      { ttlMs: 600_000 },
    );
  }

  async function estimate() {
    const project = await loadManualRunProject(db, projectId);
    return estimateManualRun(db, cache, project, NOW);
  }

  it("prices the scan from the plan, not from the cell count", async () => {
    // `deep_scan.credits` on growth is 200. THREE PROMPTS COST THE SAME AS
    // ONE, which is the whole of the flat-price rule: pricing per live cell
    // would make the bill depend on what other tenants happened to ask
    // recently, which is unbudgetable.
    await addPrompt("best crm for a 50-rep sales team");
    const one = await estimate();
    await addPrompt("crm with the best hubspot migration path");
    await addPrompt("which crm has the strongest reporting");
    const three = await estimate();

    expect(one.credits).toBe(200);
    expect(three.credits).toBe(200);
    expect(three.forecast.plannedCells).toBe(3);
    expect(one.forecast.plannedCells).toBe(1);
  });

  it("forecasts the cache split, naming which layer answered", async () => {
    const cached = "best crm for a 50-rep sales team";
    await addPrompt(cached);
    await addPrompt("crm with the best hubspot migration path");
    await seedL1(cached);

    const result = await estimate();

    expect(result.forecast).toMatchObject({
      plannedCells: 2,
      liveCells: 1,
      cachedCells: 1,
      cachedByLayer: { l1: 1, l2: 0 },
    });
  });

  it("reports the prompt count and the engines the scan would reach", async () => {
    await addPrompt("best crm for a 50-rep sales team");
    await addPrompt("crm with the best hubspot migration path");

    const result = await estimate();

    expect(result.promptCount).toBe(2);
    expect(result.engineKeys).toEqual(["perplexity"]);
  });

  it("WRITES NOTHING — no run row, no counter, no suppressed capture", async () => {
    await addPrompt("best crm for a 50-rep sales team");
    await estimate();

    for (const table of ["capture_runs", "usage_counters", "answer_captures"]) {
      const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      expect(rows.rows[0]!.n, `${table} should be untouched by a free estimate`).toBe("0");
    }
  });

  it("refuses a plan that does not include manual deep scans, naming the tier that does", async () => {
    // `deep_scan.credits` is null on free. `feature_not_in_plan` rather than
    // a zero price: a free workspace cannot buy this scan at any figure, and
    // the remedy is a plan rather than credits.
    await db.query("UPDATE workspaces SET plan_key = 'free' WHERE id = $1", [workspaceId]);

    await expect(deepScanPrice(db, workspaceId)).rejects.toMatchObject({
      code: "feature_not_in_plan",
      // Read from `plans`, not written down here — starter is the lowest tier
      // whose schedule carries an actual number.
      details: { key: "deep_scan.credits", min_plan: "starter" },
    });
  });

  it("refuses a negotiated price that was never negotiated", async () => {
    // Enterprise's schedule entry is the string "negotiated": the figure
    // belongs in the workspace's overrides, and until one is written the
    // price is genuinely unknown. Charging the business tier's 500 instead
    // would silently mis-bill the largest accounts.
    await db.query("UPDATE workspaces SET plan_key = 'enterprise' WHERE id = $1", [workspaceId]);

    await expect(deepScanPrice(db, workspaceId)).rejects.toMatchObject({ code: "precondition_unmet" });
  });

  it("takes a negotiated price from the workspace's override", async () => {
    await db.query(
      `UPDATE workspaces
          SET plan_key = 'enterprise',
              entitlement_overrides = jsonb_build_object('deep_scan.credits', 1200)
        WHERE id = $1`,
      [workspaceId],
    );

    await expect(deepScanPrice(db, workspaceId)).resolves.toBe(1200);
  });
});
