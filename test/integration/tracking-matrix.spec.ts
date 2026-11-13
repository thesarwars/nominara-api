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

  interface CaptureOptions {
    errorCode?: string;
    agoDays?: number;
    agoHours?: number;
    cacheLayer?: string;
    /** STORY-091's scores. Left undefined they stay NULL — a captured but unparsed cell. */
    brandPresent?: boolean;
    rank?: number;
    sov?: number;
    sentiment?: string;
    /** STORY-091: `answer_captures.flags` (the parse stage stamps `engine_refused_to_answer` / `empty_answer`). */
    flags?: string[];
  }

  async function addCapture(
    promptId: string,
    engineKey: string,
    status: string,
    options: CaptureOptions = {},
  ): Promise<{ id: string; capturedAt: Date }> {
    const inserted = await db.query<{ id: string; captured_at: Date }>(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
                                    capture_mode, adapter_version, normalizer_version, content_hash,
                                    status, error_code, cache_layer,
                                    brand_present, brand_rank_position, sov, sentiment_label, flags)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6::int, hours => $10::int),
               'api', '1.0.0', 'v1', sha256(random()::text::bytea), $7, $8, $9,
               $11, $12, $13, $14, $15::text[])
       RETURNING id, captured_at`,
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
        options.agoHours ?? 0,
        options.brandPresent ?? null,
        options.rank ?? null,
        options.sov ?? null,
        options.sentiment ?? null,
        options.flags ?? [],
      ],
    );
    return { id: inserted.rows[0]!.id, capturedAt: inserted.rows[0]!.captured_at };
  }

  /** One `mention_facts` row for a capture (STORY-091: the brand's position in the answer is read from its first occurrence). */
  async function addMention(capture: { id: string; capturedAt: Date }, promptId: string, engineKey: string, mention: { type: "brand" | "competitor" | "other"; occurrence: number; charStart: number; positionClass: string }): Promise<void> {
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, entity_type, entity_label, matched_alias, occurrence_index,
          char_start, char_end, first_token_index, prominence, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method, render_score, position_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'X','X',$8,$9,$9 + 1,0,0.5,'positive',0.5,0.9,'lexicon',0.4,$10)`,
      [workspaceId, projectId, capture.id, promptId, engineKey, capture.capturedAt, mention.type, mention.occurrence, mention.charStart, mention.positionClass],
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
  // ── STORY-091 · the scores the grid renders ──────────────────────────────
  //
  // §6's cell reads `①44%🟢`. Every one of these fields is NULLABLE, and null
  // is not zero in any of them: the whole reason STORY-034 shipped the cell
  // without them was that a default would put a measurement nobody made on
  // the wire.

  it("carries rank, share of voice and sentiment on a parsed cell", async () => {
    const promptId = await addPrompt("crm");
    await addCapture(promptId, "chatgpt", "parsed", {
      brandPresent: true,
      rank: 1,
      sov: 0.62,
      sentiment: "positive",
    });

    const cell = (await matrix()).prompts[0]!.cells.find((c) => c.engine_key === "chatgpt")!;
    expect(cell).toMatchObject({ brand_present: true, brand_rank_position: 1, sentiment_label: "positive" });
    expect(Number(cell.sov)).toBeCloseTo(0.62, 5);
  });

  it("distinguishes ABSENT from NEVER PARSED — the same honesty rule, one level down", async () => {
    // `brand_present: false` on a parsed cell is a real finding: the engine
    // answered and did not name the brand. Null on a pending cell is the
    // absence of a measurement. Rendering both as a dash would make an
    // outage look like a visibility collapse.
    const promptId = await addPrompt("crm");
    await addCapture(promptId, "chatgpt", "parsed", { brandPresent: false, sov: 0 });

    const cells = (await matrix()).prompts[0]!.cells;
    const absent = cells.find((c) => c.engine_key === "chatgpt")!;
    expect(absent).toMatchObject({ status: "parsed", brand_present: false });
    expect(Number(absent.sov)).toBe(0);

    // The other engine was never attempted at all.
    expect(cells.find((c) => c.engine_key === "perplexity")).toMatchObject({
      status: "pending",
      brand_present: null,
      sov: null,
      sentiment_label: null,
    });
  });

  // STORY-091 (the drawer's "position class" and "tell a refusal from another absence") - two facts the cell did not carry.
  it("STORY-091 · a parsed cell names the brand's position in the answer, read from its FIRST occurrence; a competitor's or another capture's mention is not it", async () => {
    const promptId = await addPrompt("crm");
    const capture = await addCapture(promptId, "chatgpt", "parsed", { brandPresent: true, sov: 0.5 });
    await addMention(capture, promptId, "chatgpt", { type: "brand", occurrence: 1, charStart: 400, positionClass: "caveat" });
    await addMention(capture, promptId, "chatgpt", { type: "brand", occurrence: 0, charStart: 20, positionClass: "recommendation" });
    await addMention(capture, promptId, "chatgpt", { type: "competitor", occurrence: 0, charStart: 5, positionClass: "ranked" });
    const other = await addCapture(promptId, "perplexity", "parsed", { brandPresent: true });
    await addMention(other, promptId, "perplexity", { type: "brand", occurrence: 0, charStart: 9, positionClass: "also_consider" });

    const cells = (await matrix()).prompts[0]!.cells;
    expect(cells.find((c) => c.engine_key === "chatgpt")!.position_class).toBe("recommendation");
    expect(cells.find((c) => c.engine_key === "perplexity")!.position_class).toBe("also_consider");
  });

  it("STORY-091 · position_class is null (never a default class) where nothing places the brand: pending, failed, parsed-and-absent, and a brand-less answer", async () => {
    const promptId = await addPrompt("crm");
    await addCapture(promptId, "chatgpt", "parsed", { brandPresent: false, sov: 0 });
    expect((await matrix()).prompts[0]!.cells.map((c) => [c.engine_key, c.position_class])).toEqual([["chatgpt", null], ["perplexity", null]]);
    const failed = await addPrompt("crm two");
    await addCapture(failed, "perplexity", "failed", { errorCode: "timeout" });
    const cells = (await matrix()).prompts.find((p) => p.prompt_id === failed)!.cells;
    expect(cells.map((c) => c.position_class)).toEqual([null, null]);
  });

  it("STORY-091 · a cell carries the flags the parse stamped, so a refusal reads differently from another absence; no capture is null, and none stamped is []", async () => {
    const promptId = await addPrompt("crm");
    await addCapture(promptId, "chatgpt", "parsed", { brandPresent: false, sov: 0, flags: ["engine_refused_to_answer"] });
    await addCapture(promptId, "perplexity", "parsed", { brandPresent: false, sov: 0 });
    const other = await addPrompt("crm two");
    const cells = (await matrix()).prompts;
    const first = cells.find((p) => p.prompt_id === promptId)!.cells;
    expect(first.find((c) => c.engine_key === "chatgpt")!.flags).toEqual(["engine_refused_to_answer"]);
    expect(first.find((c) => c.engine_key === "perplexity")!.flags).toEqual([]);
    expect(cells.find((p) => p.prompt_id === other)!.cells.map((c) => c.flags)).toEqual([null, null]);
  });

  it("AC3 — a cached cell reports its TRUE age, and a live one reports none", async () => {
    // A cached cell stamped with today's date would claim a freshness it does
    // not have. Null on a live cell: 0 would say it was captured this instant.
    const promptId = await addPrompt("crm");
    await addCapture(promptId, "chatgpt", "parsed", { cacheLayer: "l1", agoHours: 30 });
    await addCapture(promptId, "perplexity", "parsed", { cacheLayer: "live" });

    const cells = (await matrix()).prompts[0]!.cells;
    expect(cells.find((c) => c.engine_key === "chatgpt")!.cache_age_ms).toBeGreaterThan(29 * 3_600_000);
    expect(cells.find((c) => c.engine_key === "perplexity")!.cache_age_ms).toBeNull();
  });

  // ⚠ STORY-152 — THE PLAN FLOOR, WHICH THIS SPEC COULD NOT PREVIOUSLY SEE.
  //
  // The matrix's columns now come from `project_entitled_engines`, and the
  // comment in matrix.service.ts claims "the columns are the plan's engines by
  // construction". Nothing here tested that claim: every engine this file
  // seeds carries min_plan_key='free', so the floor could have been deleted
  // from the view and all fourteen tests above would still pass.
  //
  // `claude` is a business engine and this workspace is on growth. The
  // project_engines row is the strongest form of the test — it is the row
  // that, under a design where the entitled set is WRITTEN rather than
  // derived, would have granted the engine.
  it("⚠ an engine above the plan floor is not a column, even with an enabled override row", async () => {
    await addPrompt("best crm for a 50-rep sales team");
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ('claude', 'claude', 'v', 'api', '1.0.0', 86400, 'medium', 'business', 'active')
       ON CONFLICT (key) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, 'claude', true, 1)`,
      [workspaceId, projectId],
    );

    const grid = await matrix({});
    expect(grid.engine_keys, "growth does not buy claude, and an override cannot widen the set").not.toContain("claude");
    // Anti-vacuity: the two engines this project DOES buy are still columns,
    // so the assertion above is not passing because the grid is empty.
    expect(grid.engine_keys).toEqual(["chatgpt", "perplexity"]);

    // And asking for it by name does not add it either — the request
    // parameter narrows the entitled set, it does not bypass it.
    expect((await matrix({ engines: "claude" })).engine_keys).toEqual([]);

    // The floor is what excludes it, not its absence from project_engines:
    // upgrading the workspace makes the same row resolve.
    await db.query("UPDATE workspaces SET plan_key = 'business' WHERE id = $1", [workspaceId]);
    expect((await matrix({})).engine_keys, "on business, the very same row is entitled").toContain("claude");
  });
});
