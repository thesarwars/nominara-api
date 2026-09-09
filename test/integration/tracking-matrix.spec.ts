import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { MatrixService } from "../../src/modules/tracking/matrix.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import type { MatrixQuery, MatrixResponse } from "../../contracts/tracking/index.js";

// STORY-034 AC8 — "The prompt-by-engine grid returns one row per prompt with
// one cell per engine, and A CELL THAT COULD NOT BE CAPTURED CARRIES A
// STATUS, AN ERROR CODE, AND THE LAST SUCCESS TIME — NEVER AN EMPTY OBJECT."
//
// §6 states the reason: "'we could not ask' and 'the engine did not mention
// you' are different facts." Almost every test below is one pair of facts
// that a naive grid would render identically.

describe("STORY-034 · the prompt × engine matrix", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  const service = new MatrixService();

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
      "TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    for (const key of ["perplexity", "chatgpt"]) {
      await db.query(
        `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                              cache_ttl_seconds, volatility_band, min_plan_key, status)
         VALUES ($1, $1, 'v', 'api', '1.0.0', 86400, 'medium', 'free', 'active')`,
        [key],
      );
      await db.query(
        `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
         VALUES ($1, $2, $3, true, 1)`,
        [workspaceId, projectId, key],
      );
    }
  });

  async function addPrompt(text: string, isPriority = false): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                    intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', $6, 'active')`,
      [id, workspaceId, projectId, text, Buffer.from(text, "utf8"), isPriority],
    );
    return id;
  }

  async function addCapture(
    promptId: string,
    engineKey: string,
    status: string,
    options: { errorCode?: string; agoDays?: number; cacheLayer?: string } = {},
  ): Promise<void> {
    await db.query(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
                                    capture_mode, adapter_version, normalizer_version, content_hash,
                                    status, error_code, cache_layer)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6::int),
               'api', '1.0.0', 'v1', sha256(random()::text::bytea), $7, $8, $9)`,
      [
        workspaceId,
        projectId,
        randomUUID(),
        promptId,
        engineKey,
        options.agoDays ?? 0,
        status,
        options.errorCode ?? null,
        options.cacheLayer ?? "live",
      ],
    );
  }

  function matrix(query: Partial<MatrixQuery> = {}): Promise<MatrixResponse> {
    return withTenantContext(
      db,
      { workspaceId, actorId: randomUUID() },
      () => service.matrix(projectId, { timeframe: "30d", ...query }),
    ) as Promise<MatrixResponse>;
  }

  it("emits EVERY cell, including the ones nothing was ever attempted on", async () => {
    // The grid is prompts × engines built from the project's configuration,
    // with captures joined onto it. A query that listed captures and grouped
    // them would omit these entirely — which is exactly the confusion §6 is
    // protecting against.
    await addPrompt("best crm for a 50-rep sales team");
    await addPrompt("crm with the best hubspot migration path");

    const result = await matrix();

    expect(result.prompts).toHaveLength(2);
    for (const row of result.prompts) {
      expect(row.cells.map((cell) => cell.engine_key).sort()).toEqual(["chatgpt", "perplexity"]);
      expect(row.cells.every((cell) => cell.status === "pending")).toBe(true);
    }
  });

  it("distinguishes NEVER ASKED from ASKED AND FAILED", async () => {
    // The whole of AC8 in one assertion. Both cells are "no answer"; only one
    // of them is a failure, and only one of them means anything about the
    // engine's opinion of the brand.
    const promptId = await addPrompt("best crm for a 50-rep sales team");
    await addCapture(promptId, "chatgpt", "failed", { errorCode: "engine_timeout" });

    const [row] = (await matrix()).prompts;
    const chatgpt = row!.cells.find((cell) => cell.engine_key === "chatgpt")!;
    const perplexity = row!.cells.find((cell) => cell.engine_key === "perplexity")!;

    expect(chatgpt).toMatchObject({ status: "failed", error_code: "engine_timeout" });
    expect(perplexity).toMatchObject({ status: "pending", error_code: null, result_id: null });
  });

  it("carries last_success_at on a failure, from OUTSIDE the window if that is where it is", async () => {
    // A failure whose last success predates the window is the case most worth
    // surfacing: it is the prompt that has been broken longest. Clamping the
    // success lookup to the timeframe would report null for exactly it.
    const promptId = await addPrompt("best crm for a 50-rep sales team");
    await addCapture(promptId, "chatgpt", "captured", { agoDays: 200 });
    await addCapture(promptId, "chatgpt", "failed", { errorCode: "engine_timeout" });

    const [row] = (await matrix({ timeframe: "7d" })).prompts;
    const chatgpt = row!.cells.find((cell) => cell.engine_key === "chatgpt")!;

    expect(chatgpt.status).toBe("failed");
    expect(chatgpt.last_success_at).not.toBeNull();
  });

  it("reports the most recent capture inside the window, not the oldest", async () => {
    const promptId = await addPrompt("best crm for a 50-rep sales team");
    await addCapture(promptId, "chatgpt", "failed", { errorCode: "engine_timeout", agoDays: 5 });
    await addCapture(promptId, "chatgpt", "captured", { agoDays: 1 });

    const [row] = (await matrix()).prompts;
    expect(row!.cells.find((cell) => cell.engine_key === "chatgpt")).toMatchObject({
      status: "captured",
      error_code: null,
    });
  });

  it("names the cache layer, because a reused answer is not a fresh one", async () => {
    const promptId = await addPrompt("best crm for a 50-rep sales team");
    await addCapture(promptId, "perplexity", "skipped", { cacheLayer: "l2" });

    const [row] = (await matrix()).prompts;
    expect(row!.cells.find((cell) => cell.engine_key === "perplexity")).toMatchObject({
      status: "skipped",
      cache_layer: "l2",
    });
  });

  it("narrows to the requested engines and never widens past what is enabled", async () => {
    await addPrompt("best crm for a 50-rep sales team");

    const narrowed = await matrix({ engines: "chatgpt" });
    expect(narrowed.engine_keys).toEqual(["chatgpt"]);

    // An engine the project has not enabled cannot be added by asking for it:
    // the row set comes from `project_engines` and the parameter filters it.
    const invented = await matrix({ engines: "gemini" });
    expect(invented.engine_keys).toEqual([]);
    expect(invented.prompts).toEqual([]);
  });

  it("leaves archived prompts out of the grid", async () => {
    const promptId = await addPrompt("best crm for a 50-rep sales team");
    await db.query("UPDATE tracked_prompts SET status = 'archived' WHERE id = $1", [promptId]);

    expect((await matrix()).prompts).toEqual([]);
  });

  it("puts priority prompts first", async () => {
    await addPrompt("an ordinary question", false);
    await addPrompt("the one that matters", true);

    const result = await matrix();
    expect(result.prompts[0]!.text).toBe("the one that matters");
  });

  it("returns an empty grid for a project with no prompts, and 404 for no project", async () => {
    // An empty grid is a real answer; a missing project is not.
    expect((await matrix()).prompts).toEqual([]);

    await expect(
      withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
        service.matrix(randomUUID(), { timeframe: "30d" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
