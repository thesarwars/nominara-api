import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { fanOutCells, resolveEnabledEngines, selectPrompts } from "../../src/lib/capture/plan-cells.js";

// STORY-032 — tracking-engine.md §5's cell planning, against real Postgres.
//
// Engine resolution is the piece with a cost consequence in BOTH directions,
// which is why most of these tests are about what it must EXCLUDE. Resolving
// too many engines captures — and bills for — work the customer is not
// entitled to. Resolving too few silently under-covers the matrix, and a gap
// in a chart looks like an engine that had nothing to say rather than one
// that was never asked.
describe("STORY-032 · engine resolution, prompt selection and cell fan-out", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
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
  }, 240_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  /**
   * The capture-ready seam. STORY-152.
   *
   * `resolveEnabledEngines` returns ENTITLEMENT ∩ CAPTURE-READY, and in
   * production the capture-ready half is EMPTY — every engine in the registry
   * is fixture-backed, so nothing here can answer a real prompt until
   * STORY-001 opens the vendor accounts. These tests are about entitlement
   * resolution, not about which adapters exist, so they pass the keys THEY
   * seeded and let the entitlement filter be the only thing under test.
   */
  let seededEngineKeys: string[];

  /**
   * Each test declares the engines it means, rather than leaning on 0027's catalog.
   *
   * NO `cadence_by_plan`, and that is the point: entitlement is the plan
   * FLOOR (`min_plan_key`) and nothing else. An engine the plan never
   * schedules is still an engine the project may capture on — STORY-130 §57's
   * "tools only" free tier is exactly that — so these fixtures resolve on the
   * floor alone, which is what every exclusion below claims to test.
   */
  async function addEngine(
    key: string,
    options: { minPlan?: string; status?: string; ttl?: number; adapter?: string } = {},
  ): Promise<void> {
    if (!seededEngineKeys.includes(key)) seededEngineKeys.push(key);
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1, $1, 'v', 'api', $2, $3, 'medium', $4, $5)
       ON CONFLICT (key) DO UPDATE SET min_plan_key = EXCLUDED.min_plan_key, status = EXCLUDED.status`,
      [key, options.adapter ?? "1.0.0", options.ttl ?? 86_400, options.minPlan ?? "free", options.status ?? "active"],
    );
  }

  async function enableForProject(key: string, options: { enabled?: boolean; samples?: number } = {}): Promise<void> {
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, projectId, key, options.enabled ?? true, options.samples ?? 1],
    );
  }

  async function addPrompt(
    text: string,
    options: { priority?: boolean; status?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                    intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', $6, $7)`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8"), options.priority ?? false, options.status ?? "active"],
    );
    return id;
  }

  async function setPlan(planKey: string): Promise<void> {
    await db.query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [workspaceId, planKey]);
  }

  beforeEach(async () => {
    await db.query("TRUNCATE project_engines, tracked_prompts, projects, workspaces, engines CASCADE");
    seededEngineKeys = [];
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 2)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  // The guard: if resolution returned nothing, every exclusion below would
  // pass for the wrong reason.
  it("resolves an enabled, entitled, active engine", async () => {
    await addEngine("perplexity");
    await enableForProject("perplexity");

    const engines = await resolveEnabledEngines(db, projectId, undefined, seededEngineKeys);

    expect(engines).toHaveLength(1);
    expect(engines[0]).toMatchObject({ engineKey: "perplexity", sampleCount: 1, ttlSeconds: 86_400 });
  }, 30_000);

  it("excludes an engine the project has switched off", async () => {
    await addEngine("perplexity");
    await enableForProject("perplexity", { enabled: false });

    expect(await resolveEnabledEngines(db, projectId, undefined, seededEngineKeys)).toHaveLength(0);
  }, 30_000);

  it("excludes an engine WE have disabled, whatever the project asked for", async () => {
    await addEngine("perplexity", { status: "disabled" });
    await enableForProject("perplexity");

    expect(await resolveEnabledEngines(db, projectId, undefined, seededEngineKeys)).toHaveLength(0);
  }, 30_000);

  // AC1, and the reason the filter reads plan ORDER from the database rather
  // than a compiled-in tier mapping: the plan change alone must take effect.
  it("excludes an engine above the workspace's plan, and admits it after an upgrade — with no redeploy", async () => {
    await addEngine("claude", { minPlan: "business" });
    await enableForProject("claude");
    await setPlan("starter");

    expect(
      await resolveEnabledEngines(db, projectId, undefined, seededEngineKeys),
      "starter is below business",
    ).toHaveLength(0);

    await setPlan("business");
    expect(
      await resolveEnabledEngines(db, projectId, undefined, seededEngineKeys),
      "the ONLY thing that changed is a row in the database",
    ).toHaveLength(1);
  }, 30_000);

  // A caller-supplied list narrows. It must never widen, or it becomes a way
  // to probe which engines a workspace is entitled to.
  it("an explicit engine list narrows but cannot widen past the entitlement", async () => {
    await addEngine("perplexity");
    await addEngine("claude", { minPlan: "enterprise" });
    await enableForProject("perplexity");
    await enableForProject("claude");

    expect(await resolveEnabledEngines(db, projectId, ["perplexity"], seededEngineKeys)).toHaveLength(1);
    expect(
      await resolveEnabledEngines(db, projectId, ["claude"], seededEngineKeys),
      "asking for an unentitled engine returns nothing, never an error that confirms it exists",
    ).toHaveLength(0);
  }, 30_000);

  it("selects every active prompt for the 'all' scope, and skips paused ones", async () => {
    await addPrompt("a");
    await addPrompt("b");
    await addPrompt("paused", { status: "paused" });

    const prompts = await selectPrompts(db, projectId, "all");
    expect(prompts.map((p) => p.text).sort()).toEqual(["a", "b"]);
  }, 30_000);

  it("caps the priority scope at the project's own limit", async () => {
    for (const t of ["p1", "p2", "p3"]) await addPrompt(t, { priority: true });
    await addPrompt("ordinary");

    const prompts = await selectPrompts(db, projectId, "priority");
    expect(prompts, "priority_prompt_limit is 2 for this project").toHaveLength(2);
    expect(prompts.every((p) => p.text.startsWith("p"))).toBe(true);
  }, 30_000);

  // A shifting subset would move a chart because the QUESTION set moved,
  // which is indistinguishable from the answers moving.
  it("returns the SAME priority subset across repeated runs", async () => {
    for (const t of ["p1", "p2", "p3", "p4"]) await addPrompt(t, { priority: true });

    const first = await selectPrompts(db, projectId, "priority");
    const second = await selectPrompts(db, projectId, "priority");
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
  }, 30_000);

  it("fans out prompts x engines x that engine's own sample count", () => {
    const prompts = [
      { id: "p1", text: "one" },
      { id: "p2", text: "two" },
    ];
    const engines = [
      { engineKey: "perplexity", sampleCount: 1, ttlSeconds: 3_600, adapterVersion: "1.0.0" },
      { engineKey: "chatgpt", sampleCount: 3, ttlSeconds: 7_200, adapterVersion: "2.1.0" },
    ];

    const cells = fanOutCells(prompts, engines);

    expect(cells, "2 prompts x (1 + 3 samples)").toHaveLength(8);
    expect(cells.filter((c) => c.engineKey === "chatgpt" && c.promptId === "p1").map((c) => c.sampleIndex)).toEqual([
      0, 1, 2,
    ]);
    // Each cell carries ITS engine's TTL, not a run-wide one — the L1 bucket
    // and the L2 window are both derived from it per cell.
    expect(cells.find((c) => c.engineKey === "perplexity")!.ttlSeconds).toBe(3_600);
    expect(cells.find((c) => c.engineKey === "chatgpt")!.ttlSeconds).toBe(7_200);
  });

  it("plans nothing when a project has prompts but no entitled engine", () => {
    expect(fanOutCells([{ id: "p1", text: "one" }], [])).toEqual([]);
  });
});
