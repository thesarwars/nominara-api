import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createCaptureParseHandler, type CaptureParseDeps } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import { aggregateRange } from "../../src/lib/rollup/aggregate-day.js";
import { ParseAlertMonitor } from "../../src/lib/parser/parse-alerts.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { testCacheRedisUrl } from "../support/test-valkey.js";

// STORY-135 — the parse stage, end to end against a real database.
//
// This is the test that could not exist for six stories: every parser library
// was unit-tested against strings, and NOTHING PROVED THEY COMPOSE. The
// assertions below are about the seams — that offsets computed by the matcher
// index the text the normaliser produced, that a mention's sentiment and its
// rendering describe the same mention, and that the fact rows and the capture
// land together or not at all.

const ANSWER = [
  "## Best CRMs for scaling teams",
  "",
  "1. **HubSpot** — we recommend it for most teams; the pipelines are excellent.",
  "2. Salesforce — deeper reporting, however it has a steep learning curve.",
  "3. Zoho CRM — cheapest at scale.",
  "",
  "See [the G2 roundup](https://www.g2.com/categories/crm?utm_source=chatgpt) and",
  "https://docs.hubspot.com/api/crm for details.",
].join("\n");

describe("STORY-135 · capture.parse", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let competitorId: string;

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
      "TRUNCATE mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    competitorId = randomUUID();

    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, owned_domains, brand_aliases)
       VALUES ($1, $2, 'HubSpot', $3, 'https://hubspot.com', 'hubspot.com', ARRAY['hubspot.dev'], ARRAY[]::text[])`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1, $2, $3, 'Salesforce', 'salesforce.com', ARRAY[]::text[], 'user')`,
      [competitorId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                    intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, 'best crm', sha256('best crm'::bytea), 'recommendation', 'consideration', false, 'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  /** A captured row, exactly as `capture.execute` writes one. */
  async function seedCapture(text: string, over: Record<string, unknown> = {}): Promise<string> {
    const resultId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, response_excerpt,
          payload, flags, cache_layer, status)
       VALUES ($1,$2,$3,$4,$5,$6, now(), 'api','1.0.0','n1',$7,$8,$9::jsonb,'{}','live',$10)`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        (over.engineKey as string | undefined) ?? "google_ai_mode",
        createHash("sha256").update(text, "utf8").digest(),
        text.slice(0, 280),
        JSON.stringify({ format: "markdown", text, ...(over.payload as object | undefined) }),
        (over.status as string | undefined) ?? "captured",
      ],
    );
    return resultId;
  }

  function handler(deps?: CaptureParseDeps) {
    const context = { pool: undefined, env: { VALKEY_CACHE_URL: testCacheRedisUrl() } } as unknown as QueueHandlerContext;
    // No arbiter — production has none bound either, so every in-band mention
    // finalises deterministically. See STORY-038.
    return createCaptureParseHandler(context, deps);
  }

  /** The handler as the worker runs it: inside the job's tenant transaction, which owns COMMIT and the after-commit tasks. */
  function run(h: ReturnType<typeof handler>, j: Job): Promise<unknown> {
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => h(tx, j));
  }

  function job(resultId: string, force = false): Job {
    return {
      data: {
        payload: {
          workspaceId,
          kid: "test-kid",
          resultId,
          projectId,
          promptId,
          engineKey: "google_ai_mode",
          capturedAt: new Date().toISOString(),
          force,
        },
      },
    } as unknown as Job;
  }

  it("parses a real answer into fact rows and marks the capture parsed", async () => {
    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const capture = await db.query<{ status: string; brand_present: boolean; sov: number; citation_count: number }>(
      "SELECT status, brand_present, sov, citation_count FROM answer_captures WHERE id = $1",
      [resultId],
    );
    expect(capture.rows[0]).toMatchObject({ status: "parsed", brand_present: true });
    expect(Number(capture.rows[0]!.sov)).toBeGreaterThan(0);
    expect(capture.rows[0]!.citation_count).toBeGreaterThan(0);
  });

  it("writes the brand AND the competitor, with the competitor's id", async () => {
    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const mentions = await db.query<{ entity_type: string; entity_label: string; entity_id: string | null }>(
      "SELECT entity_type, entity_label, entity_id FROM mention_facts WHERE result_id = $1 ORDER BY char_start",
      [resultId],
    );

    const brand = mentions.rows.find((row) => row.entity_type === "brand");
    const competitor = mentions.rows.find((row) => row.entity_type === "competitor");
    expect(brand).toMatchObject({ entity_label: "HubSpot", entity_id: null });
    expect(competitor).toMatchObject({ entity_label: "Salesforce", entity_id: competitorId });
  });

  it("MATCHES THE PROJECT NAME even with no brand_aliases configured", async () => {
    // A project created from a URL alone has none. A matcher built from an
    // empty set matches nothing, which would report every answer as
    // brand-absent — indistinguishable from a real absence.
    const rows = await db.query<{ brand_aliases: string[] }>("SELECT brand_aliases FROM projects WHERE id = $1", [projectId]);
    expect(rows.rows[0]!.brand_aliases).toEqual([]);

    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const brand = await db.query("SELECT 1 FROM mention_facts WHERE result_id = $1 AND entity_type = 'brand'", [resultId]);
    expect(brand.rowCount).toBeGreaterThan(0);
  });

  it("records the untracked entity — the precondition that cannot be retrofitted", async () => {
    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const other = await db.query<{ entity_label: string; entity_id: string | null }>(
      "SELECT entity_label, entity_id FROM mention_facts WHERE result_id = $1 AND entity_type = 'other'",
      [resultId],
    );
    expect(other.rows.map((row) => row.entity_label)).toContain("Zoho CRM");
    expect(other.rows[0]!.entity_id).toBeNull();
  });

  it("EVERY offset indexes the text the normaliser produced", async () => {
    // The seam six unit-tested libraries could not prove: the matcher's spans,
    // the sentiment evidence spans, and the stored text have to agree. An
    // off-by-one here renders every highlight in the drawer in the wrong
    // place, silently.
    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const rows = await db.query<{
      entity_label: string;
      char_start: number;
      char_end: number;
      evidence_start: number;
      evidence_end: number;
    }>(
      "SELECT entity_label, char_start, char_end, evidence_start, evidence_end FROM mention_facts WHERE result_id = $1",
      [resultId],
    );

    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      // The stored span must actually contain the entity it claims.
      expect(ANSWER.slice(row.char_start, row.char_end).toLowerCase()).toContain(
        row.entity_label.toLowerCase().split(" ")[0]!,
      );
      // And the evidence must contain the mention.
      expect(row.evidence_start).toBeLessThanOrEqual(row.char_start);
      expect(row.evidence_end).toBeGreaterThanOrEqual(row.char_end);
    }
  });

  it("stores a sentiment verdict WITH its evidence on every mention", async () => {
    // STORY-038 AC3: there is no sentiment verdict without the sentence that
    // caused it. The columns are NOT NULL, so this also proves nothing was
    // invented to satisfy them.
    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const rows = await db.query<{ sentiment_label: string; sentiment_method: string; evidence_start: number | null }>(
      "SELECT sentiment_label, sentiment_method, evidence_start FROM mention_facts WHERE result_id = $1",
      [resultId],
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.evidence_start).not.toBeNull();
      expect(["lexicon", "heuristic", "llm_arbiter", "arbiter_rejected"]).toContain(row.sentiment_method);
    }
  });

  it("classifies HubSpot as recommended and Salesforce past a contrastive pivot", async () => {
    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const rows = await db.query<{ entity_label: string; position_class: string; prominence: number }>(
      "SELECT entity_label, position_class, prominence FROM mention_facts WHERE result_id = $1",
      [resultId],
    );
    const brand = rows.rows.find((row) => row.entity_label === "HubSpot")!;
    const competitor = rows.rows.find((row) => row.entity_label === "Salesforce")!;

    expect(brand.position_class).toBe("recommendation");
    expect(competitor.position_class).toBe("caveat");
    // Placement beats being mentioned: the recommended brand outranks the
    // competitor the answer pivots away from.
    expect(Number(brand.prominence)).toBeGreaterThan(Number(competitor.prominence));
  });

  it("classifies an owned citation as owned, on a SUBDOMAIN", async () => {
    const resultId = await seedCapture(ANSWER);
    await run(handler(), job(resultId));

    const citations = await db.query<{ domain: string; is_owned: boolean; normalized_url: string }>(
      "SELECT domain, is_owned, normalized_url FROM citation_facts WHERE result_id = $1 ORDER BY slot_index",
      [resultId],
    );

    const owned = citations.rows.find((row) => row.domain === "hubspot.com");
    expect(owned?.is_owned).toBe(true);
    // And the tracking parameter is gone from the G2 one.
    expect(citations.rows.some((row) => row.normalized_url.includes("utm_source"))).toBe(false);
  });

  it("IS IDEMPOTENT — a second parse produces the same rows, not double them", async () => {
    // A re-parse is a normal operation; §8 is titled "Re-parse, not
    // re-capture". A mention has no natural key that survives a normaliser
    // change moving every offset, so the facts are deleted and rewritten.
    const resultId = await seedCapture(ANSWER);
    const process = handler();
    await run(process, job(resultId));

    const first = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM mention_facts WHERE result_id = $1", [resultId]);
    await run(process, job(resultId, true));
    const second = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM mention_facts WHERE result_id = $1", [resultId]);

    expect(second.rows[0]!.n).toBe(first.rows[0]!.n);
  });

  it("SHORT-CIRCUITS an unchanged re-parse, and `force` overrides it", async () => {
    const resultId = await seedCapture(ANSWER);
    const process = handler();
    await run(process, job(resultId));
    await db.query("DELETE FROM mention_facts WHERE result_id = $1", [resultId]);

    // Nothing changed, so the prior parse still holds and no work is redone.
    await run(process, job(resultId));
    const skipped = await db.query("SELECT 1 FROM mention_facts WHERE result_id = $1", [resultId]);
    expect(skipped.rowCount).toBe(0);

    // `force` is what a re-parse endpoint sends, and it must recompute.
    await run(process, job(resultId, true));
    const forced = await db.query("SELECT 1 FROM mention_facts WHERE result_id = $1", [resultId]);
    expect(forced.rowCount).toBeGreaterThan(0);
  });

  it("re-parses when a COMPETITOR IS ADDED, because the alias set changed", async () => {
    const resultId = await seedCapture(ANSWER);
    const process = handler();
    await run(process, job(resultId));

    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1, $2, $3, 'Zoho CRM', 'zoho.com', ARRAY[]::text[], 'user')`,
      [randomUUID(), workspaceId, projectId],
    );
    await run(process, job(resultId));

    // Zoho was `other` before and is a tracked competitor now.
    const zoho = await db.query<{ entity_type: string }>(
      "SELECT entity_type FROM mention_facts WHERE result_id = $1 AND entity_label = 'Zoho CRM'",
      [resultId],
    );
    expect(zoho.rows[0]?.entity_type).toBe("competitor");
  });

  it("[STORY-135 AC8] answer_captures.sentiment_label and sentiment_score stay NULL when the brand is unmentioned — never 'absent'", async () => {
    const absent = await seedCapture("## Best CRMs\n\n1. Salesforce — deeper reporting.\n2. Zoho CRM — cheapest at scale.");
    await run(handler(), job(absent));

    const row = await db.query<{ status: string; brand_present: boolean; sentiment_label: string | null; sentiment_score: string | null }>(
      "SELECT status, brand_present, sentiment_label, sentiment_score FROM answer_captures WHERE id = $1",
      [absent],
    );
    expect(row.rows[0]!.status).toBe("parsed");
    expect(row.rows[0]!.brand_present).toBe(false);
    expect(row.rows[0]!.sentiment_label).toBeNull();
    expect(row.rows[0]!.sentiment_score).toBeNull();

    // Control: the same column is populated when the brand IS mentioned, so the NULL above is the absence and not a column that is never written.
    const present = await seedCapture(ANSWER);
    await run(handler(), job(present));
    const control = await db.query<{ sentiment_label: string | null; sentiment_score: string | null }>(
      "SELECT sentiment_label, sentiment_score FROM answer_captures WHERE id = $1",
      [present],
    );
    expect(control.rows[0]!.sentiment_label).not.toBeNull();
    expect(control.rows[0]!.sentiment_score).not.toBeNull();
  });

  it("[STORY-135 AC8] a forced re-parse that finds the brand ABSENT clears the previous label and score — a stale sentiment is not kept", async () => {
    const id = await seedCapture(ANSWER);
    const process = handler();
    await run(process, job(id));
    const before = await db.query<{ brand_present: boolean; sentiment_label: string | null; sentiment_score: string | null }>(
      "SELECT brand_present, sentiment_label, sentiment_score FROM answer_captures WHERE id = $1",
      [id],
    );
    expect(before.rows[0]!.brand_present).toBe(true);
    expect(before.rows[0]!.sentiment_label).not.toBeNull();
    expect(before.rows[0]!.sentiment_score).not.toBeNull();

    // The brand is no longer HubSpot, so the same stored answer no longer mentions it.
    await db.query("UPDATE projects SET name = 'Pipedrive' WHERE id = $1", [projectId]);
    await run(process, job(id, true));

    const after = await db.query<{ brand_present: boolean; sentiment_label: string | null; sentiment_score: string | null }>(
      "SELECT brand_present, sentiment_label, sentiment_score FROM answer_captures WHERE id = $1",
      [id],
    );
    expect(after.rows[0]!.brand_present).toBe(false);
    expect(after.rows[0]!.sentiment_label).toBeNull();
    expect(after.rows[0]!.sentiment_score).toBeNull();
  });

  it("leaves a FAILED capture alone — it has no text and is not a parse", async () => {
    // `blocked` and `failed` carry an error code, and turning them into
    // `parsed` would erase the distinction the matrix depends on.
    const resultId = await seedCapture("", { status: "failed", payload: { text: "" } });
    await run(handler(), job(resultId));

    const row = await db.query<{ status: string }>("SELECT status FROM answer_captures WHERE id = $1", [resultId]);
    expect(row.rows[0]!.status).toBe("failed");
    expect((await db.query("SELECT 1 FROM mention_facts WHERE result_id = $1", [resultId])).rowCount).toBe(0);
  });

  it("marks a text-less capture parsed rather than leaving it stuck", async () => {
    // A suppressed (L1/L2) row carries an excerpt and no payload text. Leaving
    // it `captured` would keep its run below 100% and keep the job returning.
    const resultId = await seedCapture("x", { payload: { text: "" } });
    await run(handler(), job(resultId));

    const row = await db.query<{ status: string }>("SELECT status FROM answer_captures WHERE id = $1", [resultId]);
    expect(row.rows[0]!.status).toBe("parsed");
  });

  it("skips a capture that no longer exists rather than retrying it", async () => {
    await expect(run(handler(), job(randomUUID()))).resolves.toBeUndefined();
  });

  it("writes NOTHING when the parse throws — the facts and the capture land together", async () => {
    // Stage 6's single transaction, proven by rollback: the handler runs
    // inside the caller's transaction, so a failure after the mentions are
    // written must leave the capture unparsed too.
    const resultId = await seedCapture(ANSWER);
    await expect(
      withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await handler()(tx, job(resultId));
        throw new Error("fails after the parse");
      }),
    ).rejects.toThrow("fails after the parse");

    const capture = await db.query<{ status: string }>("SELECT status FROM answer_captures WHERE id = $1", [resultId]);
    expect(capture.rows[0]!.status).toBe("captured");
    expect((await db.query("SELECT 1 FROM mention_facts WHERE result_id = $1", [resultId])).rowCount).toBe(0);
  });

  // STORY-037 AC10 — the alert's trigger condition existed and nothing called it. `.invalid` is reserved (RFC 6761)
  // and can never resolve, so every one of these citations fails resolution whatever the machine's network.
  it("[STORY-037 AC10] a parse whose citations all fail to resolve reaches the pager, naming the engine", async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://dead-${String(i)}.invalid/page`);
    const resultId = await seedCapture(["## Sources", "", ...urls.map((url, i) => `${String(i + 1)}. ${url}`)].join("\n"));
    const pages: { message: string; context: Record<string, unknown> }[] = [];
    const alerts = new ParseAlertMonitor({ pager: { page: (message, context) => void pages.push({ message, context }) } });

    await run(handler({ alerts }), job(resultId));

    expect(pages).toHaveLength(1);
    expect(pages[0]!.context).toMatchObject({ alert: "citation_resolution_failure", engineKey: "google_ai_mode", attempted: 25, failed: 25 });
    expect(JSON.stringify(pages[0])).not.toContain("dead-"); // no citation content in the alert
  });

  it("[STORY-037 AC10] a pager that throws never fails the parse it observed", async () => {
    const resultId = await seedCapture(ANSWER);
    const alerts = { observe: () => { throw new Error("pager down"); } } as unknown as ParseAlertMonitor;
    await expect(run(handler({ alerts }), job(resultId))).resolves.toBeUndefined();
    const row = await db.query<{ status: string }>("SELECT status FROM answer_captures WHERE id = $1", [resultId]);
    expect(row.rows[0]!.status).toBe("parsed");
  });
  // The monitor's meters are cumulative counters: observing before COMMIT counts a parse that a retry then runs again.
  it("[STORY-037 AC10] the alert monitor observes only AFTER the job commits — a rolled-back attempt is not counted", async () => {
    const resultId = await seedCapture(ANSWER);
    const observed: string[] = [];
    const alerts = { observe: (observation: { engineKey: string }) => void observed.push(observation.engineKey) } as unknown as ParseAlertMonitor;

    await expect(
      withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await handler({ alerts })(tx, job(resultId));
        expect(observed, "nothing may be observed before COMMIT").toEqual([]);
        throw new Error("attempt fails after the parse; the job is retried");
      }),
    ).rejects.toThrow("attempt fails");
    expect(observed).toEqual([]); // the rolled-back attempt left no trace in the meters

    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => handler({ alerts })(tx, job(resultId)));
    expect(observed).toEqual(["google_ai_mode"]); // the retry that committed is counted exactly once
  });

  it("[STORY-037 AC10] a monitor that throws AFTER commit never fails or un-parses the job", async () => {
    const resultId = await seedCapture(ANSWER);
    const alerts = { observe: () => { throw new Error("pager down"); } } as unknown as ParseAlertMonitor;
    await expect(
      withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => handler({ alerts })(tx, job(resultId))),
    ).resolves.toBeUndefined();
    const row = await db.query<{ status: string }>("SELECT status FROM answer_captures WHERE id = $1", [resultId]);
    expect(row.rows[0]!.status).toBe("parsed");
  });
  // ---- STORY-091 audit B2 - scoring-models s2.5: a refusal is a measurement; a blocked or failed cell is not ----------
  async function seedEmpty(status: string, flags: string[], text: string | null = ""): Promise<string> {
    const id = await seedCapture("x", { status });
    await db.query("UPDATE answer_captures SET payload = $2::jsonb, flags = $3, response_excerpt = NULL WHERE id = $1", [
      id,
      JSON.stringify(text === null ? { format: "markdown" } : { format: "markdown", text }),
      flags,
    ]);
    return id;
  }
  const presenceOf = async (id: string) =>
    (await db.query<{ status: string; brand_present: boolean | null; sov: string | null; flags: string[] }>(
      "SELECT status, brand_present, sov, flags FROM answer_captures WHERE id = $1",
      [id],
    )).rows[0]!;

  it("[s2.5 refusal] an engine refusal (empty text + engine_refused_to_answer) parses as brand_present = false, sov = 0, no mentions", async () => {
    const id = await seedEmpty("captured", ["engine_refused_to_answer"]);
    await run(handler(), job(id));
    const row = await presenceOf(id);
    expect(row).toMatchObject({ status: "parsed", brand_present: false });
    expect(Number(row.sov)).toBe(0);
    expect(row.flags).toContain("engine_refused_to_answer");
    expect((await db.query("SELECT 1 FROM mention_facts WHERE result_id = $1", [id])).rowCount).toBe(0);
  });

  it("[s2.5 empty answer] an empty answer with no flag is also brand_present = false, not NULL", async () => {
    const id = await seedEmpty("captured", []);
    await run(handler(), job(id));
    expect(await presenceOf(id)).toMatchObject({ status: "parsed", brand_present: false });
  });

  it("[s2.5 truncated] an empty answer that was cut off (truncated) is a token-budget failure, not an answer: brand_present stays NULL", async () => {
    const id = await seedEmpty("captured", []);
    await db.query("UPDATE answer_captures SET truncated = true WHERE id = $1", [id]);
    await run(handler(), job(id));
    expect(await presenceOf(id)).toMatchObject({ brand_present: null, sov: null });
  });

  it("[s2.5 missing source] an L2 cell whose source is gone stays rematch_unavailable with NULL, not an empty answer", async () => {
    const id = await seedReused("l2", { source: randomUUID() });
    await run(handler(), job(id));
    expect(await presenceOf(id)).toMatchObject({ status: "skipped", brand_present: null });
    expect((await presenceOf(id)).flags).toContain("rematch_unavailable");
  });

  it("[s2.5 blocked/failed] blocked and failed cells stay NULL and are out of the denominator", async () => {
    const blocked = await seedEmpty("blocked", []);
    const failed = await seedEmpty("failed", []);
    await run(handler(), job(blocked));
    await run(handler(), job(failed));
    expect(await presenceOf(blocked)).toMatchObject({ status: "blocked", brand_present: null });
    expect(await presenceOf(failed)).toMatchObject({ status: "failed", brand_present: null });
  });

  /** A reused row as the planner writes it: `skipped`, a cache layer, and either its own payload (L1) or `{}` plus a source (L2). */
  async function seedReused(layer: "l1" | "l2", over: { ownText?: string; source?: string }): Promise<string> {
    const id = await seedCapture("x", { status: "skipped" });
    await db.query("UPDATE answer_captures SET cache_layer = $2, source_result_id = $3, payload = $4::jsonb, response_excerpt = NULL WHERE id = $1", [
      id,
      layer,
      over.source ?? null,
      JSON.stringify(over.ownText === undefined ? {} : { format: "markdown", text: over.ownText }),
    ]);
    return id;
  }

  it("[s2.5 agreement] per-prompt presence and the rollup agree: the refusal is in the denominator and not present; blocked is out", async () => {
    const present = await seedCapture(ANSWER);
    const refused = await seedEmpty("captured", ["engine_refused_to_answer"]);
    const blocked = await seedEmpty("blocked", []);
    // Audit round 2 - reused cells whose source answered with nothing are measurements too, and stay `skipped`.
    const l1Empty = await seedReused("l1", { ownText: "" });
    const refusedSource = await seedEmpty("captured", ["engine_refused_to_answer"]);
    const l2Refused = await seedReused("l2", { source: refusedSource });
    for (const id of [present, refused, blocked, l1Empty, refusedSource, l2Refused]) await run(handler(), job(id));
    expect(await presenceOf(l1Empty)).toMatchObject({ status: "skipped", brand_present: false });
    expect(Number((await presenceOf(l1Empty)).sov)).toBe(0);
    expect((await presenceOf(l1Empty)).flags).not.toContain("rematch_unavailable");
    expect(await presenceOf(l2Refused)).toMatchObject({ status: "skipped", brand_present: false });
    expect(Number((await presenceOf(l2Refused)).sov)).toBe(0);
    expect((await presenceOf(l2Refused)).flags).toContain("engine_refused_to_answer");
    expect((await presenceOf(l2Refused)).flags).not.toContain("rematch_unavailable");

    const rows = await db.query<{ id: string; brand_present: boolean | null }>(
      "SELECT id, brand_present FROM answer_captures WHERE project_id = $1 AND status IN ('parsed','captured','skipped')",
      [projectId],
    );
    const perPromptDenominator = rows.rows.filter((row) => row.brand_present !== null).length;
    const perPromptPresent = rows.rows.filter((row) => row.brand_present === true).length;

    const aggregates = await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
      aggregateRange(tx, projectId, "2000-01-01", "2100-01-01", "UTC", null),
    );
    const brand = aggregates.find((row) => row.entityType === "brand")!;
    expect(perPromptDenominator).toBe(5); // present, refused, L1-empty, the refused source, the L2 row; blocked is out
    expect(brand.cellsTotal).toBe(perPromptDenominator);
    expect(brand.cellsPresent).toBe(perPromptPresent);
  });
});
