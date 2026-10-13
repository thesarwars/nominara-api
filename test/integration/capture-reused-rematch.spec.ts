import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { finalizeRun } from "../../src/lib/capture/finalize-run.js";
import { projectAliasFingerprint } from "../../src/lib/capture/l3-short-circuit.js";
import { recordRunCounts, recordSuppressedCells } from "../../src/lib/capture/record-suppressed.js";
import { readRunProgress } from "../../src/lib/capture/run-progress.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-032 AC7 (owner decision 2026-10-13) — a reused (L1/L2) cell is RE-MATCHED against the current alias set
// by `capture.parse`, and the row KEEPS `status = 'skipped'`.
//
// Why it keeps `skipped`: `run-progress.ts` counts captured+parsed from the rows and skipped from the run row, and
// `finalizeRun` sums them (`deliveredCells`). A reused row turned `parsed` would be counted twice, and the second
// count flows into settlement and refunds. The facts are carried; the status is not changed.
//
// THE INVARIANTS (each is a test below, named with its tag):
//   [I1 status-stays-skipped]      a re-matched row is still `skipped`
//   [I2 no-double-count]           run counts, progress and settlement inputs are identical before and after
//   [I3 no-cross-tenant-source]    an L2 source in another workspace or project is never read
//   [I4 idempotent]                a redelivered / replayed rematch writes the same facts, not more
//   [I5 current-alias-set]         the match uses the alias set as it is NOW, not the plan-time stamp
//   [I6 unscored-is-not-matched]   the plan-time fingerprint stamp must not make a row look already matched

const ANSWER = [
  "## Best CRMs for scaling teams",
  "",
  "1. **HubSpot** — we recommend it for most teams.",
  "2. Salesforce — deeper reporting.",
  "3. Zoho CRM — cheapest at scale.",
].join("\n");

// An answer that, IF it were ever read for the wrong tenant's reused row, would produce facts for this project (it names
// this project's brand in a list). A leak test whose text matches nothing passes for the wrong reason: the first version
// used a plain sentence and two predicate mutations survived it.
const LEAK = "1. **HubSpot** — leaked from another tenant's capture.\n2. Salesforce — also leaked.";

describe("STORY-032 AC7 · re-matching a reused cell", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let promptA: string;
  let promptB: string;
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
    rollups = [];
    await db.query("RESET ROLE");
    await db.query(
      "TRUNCATE mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, capture_runs, projects, workspaces CASCADE",
    );
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    projectId = randomUUID();
    otherProjectId = randomUUID();
    promptA = randomUUID();
    promptB = randomUUID();
    runId = uuidV7();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [id, `w-${id.slice(0, 8)}`]);
    }
    await project(workspaceId, projectId, "HubSpot", "hubspot.com");
    await project(workspaceId, otherProjectId, "Acme", "acme.com");
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1, $2, $3, 'Salesforce', 'salesforce.com', ARRAY[]::text[], 'user')`,
      [randomUUID(), workspaceId, projectId],
    );
    for (const id of [promptA, promptB]) {
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
         VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', false, 'active')`,
        [id, workspaceId, projectId, `best crm ${id.slice(0, 4)}`, Buffer.from(`best crm ${id.slice(0, 4)}`, "utf8")],
      );
    }
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status)
       VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'], 'running')`,
      [runId, workspaceId, projectId],
    );
  });

  async function project(ws: string, id: string, name: string, domain: string): Promise<void> {
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, owned_domains, brand_aliases)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY[]::text[], ARRAY[]::text[])`,
      [id, ws, name, `p-${id.slice(0, 8)}`, `https://${domain}`, domain],
    );
  }

  const hashOf = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

  /** A fully parsed, live capture with text — the source an L2 row reuses, or the run's one live cell. */
  async function liveCapture(over: { ws?: string; project?: string; prompt?: string; text?: string; run?: string | null; status?: string } = {}): Promise<string> {
    const id = randomUUID();
    const text = over.text ?? ANSWER;
    let sourceRun = over.run;
    if (sourceRun === null) {
      // `run_id` is NOT NULL: a source capture belongs to an EARLIER run, in its own workspace and project.
      sourceRun = uuidV7();
      await db.query(
        `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status) VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'], 'completed')`,
        [sourceRun, over.ws ?? workspaceId, over.project ?? projectId],
      );
    }
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
          normalizer_version, content_hash, response_excerpt, payload, flags, cache_layer, status)
       VALUES ($1,$2,$3,$4,$5,'perplexity', now(), 'api','1.0.0','n1',$6,$7,$8::jsonb,'{}','live',$9)`,
      [
        id, over.ws ?? workspaceId, over.project ?? projectId, sourceRun === undefined ? runId : sourceRun, over.prompt ?? promptB,
        hashOf(text), text.slice(0, 280), JSON.stringify({ format: "markdown", text }), over.status ?? "parsed",
      ],
    );
    return id;
  }

  async function currentFingerprint(): Promise<Buffer> {
    return projectAliasFingerprint(db, projectId);
  }

  /** The row the PLANNER writes for an L1 hit — the real writer, so the shape is authentic. */
  async function reusedL1(text = ANSWER): Promise<string> {
    await recordSuppressedCells(
      db,
      { workspaceId, projectId, runId, normalizerVersion: "n1", captureMode: "api", aliasFingerprint: await currentFingerprint() },
      [
        {
          layer: "l1", promptId: promptA, engineKey: "perplexity", sampleIndex: 0, contentHash: hashOf(text),
          payload: { format: "markdown", text }, excerpt: text.slice(0, 280), adapterVersion: "1.0.0",
        },
      ],
    );
    return reusedRowId();
  }

  async function reusedL2(sourceId: string, text = ANSWER): Promise<string> {
    await recordSuppressedCells(
      db,
      { workspaceId, projectId, runId, normalizerVersion: "n1", captureMode: "api", aliasFingerprint: await currentFingerprint() },
      [{ layer: "l2", promptId: promptA, engineKey: "perplexity", sampleIndex: 0, sourceResultId: sourceId, sourceContentHash: hashOf(text), adapterVersion: "1.0.0" }],
    );
    return reusedRowId();
  }

  async function reusedRowId(): Promise<string> {
    const found = await db.query<{ id: string }>("SELECT id FROM answer_captures WHERE run_id = $1 AND status = 'skipped'", [runId]);
    expect(found.rows, "the planner's row must exist").toHaveLength(1);
    return found.rows[0]!.id;
  }

  /** planned = the reused cell + the run's one live cell; skipped = the reused cell. */
  async function recordCounts(): Promise<void> {
    await recordRunCounts(db, runId, { planned: 2, skipped: 1, engineKeys: ["perplexity"] });
  }

  let rollups: string[];
  function handler() {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    return createCaptureParseHandler(context, {
      enqueueRollup: (_queue, _workspaceId, _payload, idempotencyKey) => {
        rollups.push(idempotencyKey);
        return Promise.resolve(undefined);
      },
    });
  }

  function job(resultId: string): Job {
    return {
      data: { payload: { workspaceId, kid: "test-kid", resultId, projectId, promptId: promptA, engineKey: "perplexity", capturedAt: new Date().toISOString(), force: false } },
    } as unknown as Job;
  }

  const run = (resultId: string): Promise<unknown> =>
    withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => handler()(tx, job(resultId)));

  const rowOf = async (id: string) =>
    (
      await db.query<{ status: string; brand_present: boolean | null; alias_fingerprint: Buffer | null; cache_layer: string; flags: string[] }>(
        "SELECT status, brand_present, alias_fingerprint, cache_layer, flags FROM answer_captures WHERE id = $1",
        [id],
      )
    ).rows[0]!;
  const factLabels = async (id: string): Promise<string[]> =>
    (await db.query<{ entity_label: string }>("SELECT entity_label FROM mention_facts WHERE result_id = $1 ORDER BY char_start", [id])).rows.map(
      (r) => r.entity_label,
    );
  const factIds = async (id: string): Promise<string[]> =>
    (await db.query<{ id: string }>("SELECT id FROM mention_facts WHERE result_id = $1 ORDER BY id", [id])).rows.map((r) => r.id);

  it("[I1 status-stays-skipped] STORY-032 AC7 · an L1 row is re-matched, carries the facts, and is STILL skipped", async () => {
    const reused = await reusedL1();
    expect((await rowOf(reused)).brand_present, "the planner leaves it unscored").toBeNull();

    await run(reused);

    const after = await rowOf(reused);
    expect(after.status).toBe("skipped");
    expect(after.cache_layer).toBe("l1");
    expect(after.brand_present).toBe(true);
    expect(await factLabels(reused)).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
  });

  it("[I1 status-stays-skipped] STORY-032 AC7 · an L2 row resolves its text through source_result_id, and the facts belong to the REUSED row", async () => {
    const source = await liveCapture({ run: null });
    const reused = await reusedL2(source);

    await run(reused);

    const after = await rowOf(reused);
    expect(after.status).toBe("skipped");
    expect(after.brand_present).toBe(true);
    expect(await factLabels(reused)).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
    expect(await factLabels(source), "the source's own facts are not touched").toEqual([]);
  });

  it("[I5 current-alias-set] STORY-032 AC7 · an alias added AFTER planning appears in the re-matched cell, and the stamp moves to the current fingerprint", async () => {
    const reused = await reusedL1();
    const stamped = (await rowOf(reused)).alias_fingerprint!;
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1, $2, $3, 'Zoho CRM', 'zoho.com', ARRAY[]::text[], 'user')`,
      [randomUUID(), workspaceId, projectId],
    );

    await run(reused);

    const zoho = await db.query<{ entity_type: string }>("SELECT entity_type FROM mention_facts WHERE result_id = $1 AND entity_label = 'Zoho CRM'", [reused]);
    expect(zoho.rows[0]?.entity_type).toBe("competitor");
    const after = (await rowOf(reused)).alias_fingerprint!;
    expect(after.equals(await currentFingerprint())).toBe(true);
    expect(after.equals(stamped)).toBe(false);
  });

  it("[I6 unscored-is-not-matched] STORY-032 AC7 · the planner stamps the CURRENT fingerprint, yet an unscored skipped row is never short-circuited as already matched", async () => {
    const reused = await reusedL1();
    expect((await rowOf(reused)).alias_fingerprint!.equals(await currentFingerprint())).toBe(true);

    await run(reused);

    expect(await factLabels(reused), "if the stamp were read as 'already matched' no facts would exist").not.toEqual([]);
  });

  it("[I2 no-double-count] STORY-032 AC7 · run counts, progress and the settlement inputs are identical before and after the re-match", async () => {
    const live = await liveCapture();
    const reused = await reusedL1();
    await recordCounts();
    const before = await readRunProgress(db, runId);
    const countsBefore = (await db.query("SELECT planned_cells, skipped_cells, captured_cells, failed_cells FROM capture_runs WHERE id = $1", [runId])).rows[0];

    await run(reused);

    const after = await readRunProgress(db, runId);
    expect(after).toEqual(before);
    expect((await db.query("SELECT planned_cells, skipped_cells, captured_cells, failed_cells FROM capture_runs WHERE id = $1", [runId])).rows[0]).toEqual(countsBefore);
    expect(after.captured + after.skipped, "deliveredCells is what settlement is given").toBe(after.planned);
    expect(after).toMatchObject({ planned: 2, captured: 1, skipped: 1, failed: 0, pct: 100 });
    expect((await rowOf(live)).status).toBe("parsed");
    expect(
      (await db.query("SELECT count(*)::int AS n FROM answer_captures WHERE run_id = $1 AND status IN ('captured','parsed')", [runId])).rows[0].n,
      "only the live cell is a capture",
    ).toBe(1);
  });

  it("[I2 no-double-count] STORY-032 AC7 · finalising the run after the re-match delivers exactly `planned` cells and refunds nothing", async () => {
    await liveCapture();
    const reused = await reusedL1();
    await recordCounts();
    await run(reused);

    const finalized = await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) =>
      finalizeRun(tx, workspaceId, await readRunProgress(tx, runId)),
    );

    expect(finalized).toMatchObject({ status: "completed", refunded: 0 });
    const progress = await readRunProgress(db, runId);
    expect(progress.captured + progress.skipped).toBe(progress.planned);
  });

  it("[I3 no-cross-tenant-source] STORY-032 AC7 · an L2 row whose source is in ANOTHER WORKSPACE resolves nothing: no facts, still skipped, nothing leaks", async () => {
    const foreign = await liveCapture({ ws: otherWorkspaceId, project: otherProjectId, run: null, text: LEAK });
    // `answer_captures.source_result_id` has no FK, so a poisoned pointer is representable.
    const reused = await reusedL2(foreign);

    await run(reused);

    expect(await factLabels(reused)).toEqual([]);
    const after = await rowOf(reused);
    expect(after.status).toBe("skipped");
    expect(after.brand_present).toBeNull();
  });

  it("[I3 no-cross-tenant-source] STORY-032 AC7 · the same, under the RLS role: the policy and the explicit predicate agree", async () => {
    const foreign = await liveCapture({ ws: otherWorkspaceId, project: otherProjectId, run: null, text: LEAK });
    const reused = await reusedL2(foreign);
    await db.query("SET ROLE nominara_app");
    try {
      await run(reused);
    } finally {
      await db.query("RESET ROLE");
    }
    expect(await factLabels(reused)).toEqual([]);
    expect((await rowOf(reused)).brand_present).toBeNull();
  });

  it("[I3 no-cross-tenant-source] STORY-032 AC7 · a source in another PROJECT of the same workspace is not read either", async () => {
    const sibling = await liveCapture({ project: otherProjectId, run: null, text: LEAK });
    const reused = await reusedL2(sibling);

    await run(reused);

    expect(await factLabels(reused)).toEqual([]);
    expect((await rowOf(reused)).status).toBe("skipped");
  });

  it("[I4 idempotent] STORY-032 AC7 · a redelivered job with an unchanged alias set writes nothing new; a forced second pass replaces rather than doubles", async () => {
    const reused = await reusedL1();
    await run(reused);
    const first = await factIds(reused);
    expect(first.length).toBeGreaterThan(0);

    await run(reused);
    expect(await factIds(reused), "an already re-matched row is not re-parsed").toEqual(first);

    // A changed alias set DOES re-match, and it replaces the old facts.
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1, $2, $3, 'Zoho CRM', 'zoho.com', ARRAY[]::text[], 'user')`,
      [randomUUID(), workspaceId, projectId],
    );
    await run(reused);
    const labels = await factLabels(reused);
    expect(labels.filter((l) => l === "HubSpot"), "the brand appears once, not twice").toHaveLength(1);
    expect(labels.filter((l) => l === "Zoho CRM")).toHaveLength(1);
    expect(new Set(await factIds(reused)).size).toBe(labels.length);
    expect((await rowOf(reused)).status).toBe("skipped");
  });

  it("[I1 status-stays-skipped] STORY-032 AC7 · a reused row whose source text is GONE stays skipped, unscored and flagged, and nothing throws", async () => {
    const source = await liveCapture({ run: null });
    const reused = await reusedL2(source);
    // Retention clears payloads; the row remains.
    await db.query("UPDATE answer_captures SET payload = '{}'::jsonb WHERE id = $1", [source]);

    await expect(run(reused)).resolves.toBeUndefined();

    const after = await rowOf(reused);
    expect(after.status, "NOT marked parsed: that would count it twice").toBe("skipped");
    expect(after.brand_present).toBeNull();
    expect(after.flags).toContain("rematch_unavailable");
    expect(await factLabels(reused)).toEqual([]);
  });

  it("[I1 status-stays-skipped] STORY-032 AC7 · an L2 row whose source row was deleted behaves the same", async () => {
    const source = await liveCapture({ run: null });
    const reused = await reusedL2(source);
    await db.query("DELETE FROM answer_captures WHERE id = $1", [source]);

    await expect(run(reused)).resolves.toBeUndefined();

    expect((await rowOf(reused)).status).toBe("skipped");
    expect(await factLabels(reused)).toEqual([]);
  });

  it("STORY-032 AC7 · a LIVE captured row with no text is still marked parsed (the existing rule is untouched)", async () => {
    const live = await liveCapture({ status: "captured", text: "" });
    await db.query("UPDATE answer_captures SET payload = '{\"text\":\"\"}'::jsonb WHERE id = $1", [live]);

    await run(live);

    expect((await rowOf(live)).status).toBe("parsed");
  });

  it("[I2 no-double-count] NEW-A-7 · the run's day rollup waits for the re-match: not requested while a reused row is unmatched, requested ONCE after it", async () => {
    const live = await liveCapture({ status: "captured" });
    const reused = await reusedL1();
    await recordCounts();

    await run(live);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rollups, "the live cell is parsed but a reused cell is still unmatched: the day's facts are incomplete").toEqual([]);

    await run(reused);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rollups).toEqual([`rollup:${projectId}:run:${runId}`]);
  });

  it("NEW-A-7 · a reused row that CANNOT be re-matched does not hold the rollup back for ever", async () => {
    const live = await liveCapture({ status: "captured" });
    const source = await liveCapture({ run: null });
    const reused = await reusedL2(source);
    await recordCounts();
    await db.query("UPDATE answer_captures SET payload = '{}'::jsonb WHERE id = $1", [source]);

    await run(live);
    await run(reused);
    await new Promise((resolve) => setImmediate(resolve));

    expect(rollups).toEqual([`rollup:${projectId}:run:${runId}`]);
  });
});
