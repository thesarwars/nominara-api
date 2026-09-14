import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES } from "../../src/lib/rollup/aggregate-day.js";
import { CROSS_ENGINE_KEY, rollUpDay } from "../../src/lib/rollup/roll-up-day.js";
import { denormalizeProject } from "../../src/lib/rollup/denormalize.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { ATTRIBUTE_CAPABLE_ENGINES } from "../../src/lib/parser/rendering.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-042's thirteen scenarios, minus 13 (freshness needs a running fleet).

describe("STORY-042 · rollup.metric_daily", () => {
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

  async function setUp(timezone = "UTC"): Promise<void> {
    await db.query(
      "TRUNCATE metric_daily, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    competitorId = randomUUID();

    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth',$3)", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
      timezone,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1,$2,$3,'Salesforce','salesforce.com',ARRAY[]::text[],'user')`,
      [competitorId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    for (const [engine, weight] of [
      ["google_ai_mode", 3],
      ["chatgpt", 1],
    ] as const) {
      // `project_engines.engine_key` references `engines`, which the catalog
      // seed does not populate (STORY-130 is blocked on six decisions), so the
      // rows are created here.
      await db.query(
        `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                              cache_ttl_seconds, volatility_band, min_plan_key, status)
         VALUES ($1,$1,'v','api','1.0.0',86400,'medium','free','active')
         ON CONFLICT (key) DO NOTHING`,
        [engine],
      );
      await db.query(
        `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count, weight)
         VALUES ($1,$2,$3,true,1,$4)`,
        [workspaceId, projectId, engine, weight],
      );
    }
  }

  beforeEach(async () => {
    await setUp();
  });

  interface CellSpec {
    capturedAt: string;
    engineKey?: string;
    status?: string;
    cacheLayer?: string;
    brandPresent?: boolean;
    sov?: number | null;
  }

  async function addCell(spec: CellSpec): Promise<string> {
    const resultId = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash,
          payload, flags, cache_layer, status, brand_present, sov)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1.0.0','n1',$8,'{}'::jsonb,'{}',$9,$10,$11,$12)`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        spec.engineKey ?? "google_ai_mode",
        spec.capturedAt,
        createHash("sha256").update(resultId).digest(),
        spec.cacheLayer ?? "live",
        spec.status ?? "parsed",
        spec.brandPresent ?? false,
        spec.sov ?? null,
      ],
    );
    return resultId;
  }

  interface MentionSpec {
    entityType?: "brand" | "competitor";
    prominence?: number;
    sentimentScore?: number;
    sentimentLabel?: string;
    renderScore?: number;
    listPosition?: number | null;
  }

  async function addMention(resultId: string, capturedAt: string, spec: MentionSpec = {}): Promise<void> {
    const engine = await db.query<{ engine_key: string }>("SELECT engine_key FROM answer_captures WHERE id = $1", [resultId]);
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          entity_type, entity_id, entity_label, matched_alias, occurrence_index,
          char_start, char_end, first_token_index, prominence, list_position,
          sentiment_label, sentiment_score, sentiment_confidence, sentiment_method, render_score)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,'L','L',0,0,1,0,$9,$10,$11,$12,0.9,'lexicon',$13)`,
      [
        workspaceId,
        projectId,
        resultId,
        promptId,
        engine.rows[0]!.engine_key,
        capturedAt,
        spec.entityType ?? "brand",
        spec.entityType === "competitor" ? competitorId : null,
        spec.prominence ?? 0.8,
        spec.listPosition ?? null,
        spec.sentimentLabel ?? "positive",
        spec.sentimentScore ?? 0.5,
        spec.renderScore ?? 0.4,
      ],
    );
  }

  async function addCitation(resultId: string, capturedAt: string, isOwned: boolean, resolved = true): Promise<void> {
    const engine = await db.query<{ engine_key: string }>("SELECT engine_key FROM answer_captures WHERE id = $1", [resultId]);
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          slot_index, raw_url, normalized_url, url_hash, domain, is_owned, is_competitor,
          http_status, position_weight)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,1,'https://x','https://x',sha256(random()::text::bytea),'x.com',$7,false,$8,1.0)`,
      [workspaceId, projectId, resultId, promptId, engine.rows[0]!.engine_key, capturedAt, isOwned, resolved ? 200 : null],
    );
  }

  function roll(date: string, timezone = "UTC") {
    return rollUpDay(db, workspaceId, projectId, date, timezone);
  }

  async function metricRow(engineKey = "google_ai_mode", entityType = "brand") {
    const rows = await db.query<Record<string, string | null>>(
      `SELECT cells_total::text, cells_present::text, presence_rate::text, sov::text,
              sentiment_score::text, citation_share::text, visibility_score::text,
              rendering_quality::text, live_capture_ratio::text, mentions_total::text,
              avg_rank_position::text
         FROM metric_daily
        WHERE project_id = $1 AND engine_key = $2 AND entity_type = $3`,
      [projectId, engineKey, entityType],
    );
    return rows.rows[0];
  }

  it("Scenario 1 — running twice for one day produces the identical result", async () => {
    // Idempotent upserts are what make dirty-date reprocessing free. Without
    // them, reprocessing would need to detect and reverse the previous
    // contribution — the kind of arithmetic that produces slow drift.
    const at = "2026-09-10T12:00:00Z";
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 0.5 });
    await addMention(cell, at);

    await roll("2026-09-10");
    const first = await metricRow();
    await roll("2026-09-10");
    const second = await metricRow();

    expect(second).toEqual(first);
    const count = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM metric_daily WHERE engine_key = 'google_ai_mode'");
    expect(count.rows[0]!.n).toBe("1");
  });

  it("Scenario 3 — the date is the WORKSPACE's day, not the server's", async () => {
    // 2026-09-11 00:30 UTC is still 2026-09-10 in Los Angeles. A server-local
    // rollup attributes the capture to the wrong day — visibly wrong on a
    // daily chart, and invisible to any test that runs in one timezone.
    await setUp("America/Los_Angeles");
    const at = "2026-09-11T00:30:00Z";
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(cell, at);

    expect(await roll("2026-09-11", "America/Los_Angeles")).toBe(0);
    expect(await roll("2026-09-10", "America/Los_Angeles")).toBeGreaterThan(0);
  });

  it("Scenario 4 — a TWENTY-FIVE-hour day buckets correctly", async () => {
    // 2026-11-01 in Los Angeles: clocks go back at 02:00 local, so the day is
    // 25 hours and runs 07:00Z to 08:00Z the next day. A fixed −7 or −8
    // offset gets one of the two boundary captures wrong; only the tz
    // database gets both right.
    await setUp("America/Los_Angeles");
    const early = "2026-11-01T07:30:00Z"; // 00:30 PDT
    const late = "2026-11-02T07:30:00Z"; // 23:30 PST — still the 1st
    const nextDay = "2026-11-02T08:30:00Z"; // 00:30 PST — the 2nd

    for (const at of [early, late, nextDay]) {
      const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
      await addMention(cell, at);
    }

    await roll("2026-11-01", "America/Los_Angeles");
    expect((await metricRow())!.cells_total).toBe("2");
  });

  it("Scenario 5 — a TWENTY-THREE-hour day buckets correctly", async () => {
    // 2026-03-08 in Los Angeles: clocks spring forward at 02:00 local, so the
    // day is 23 hours and runs 08:00Z to 07:00Z the next day.
    await setUp("America/Los_Angeles");
    const early = "2026-03-08T08:30:00Z"; // 00:30 PST
    const late = "2026-03-09T06:30:00Z"; // 23:30 PDT — still the 8th
    const nextDay = "2026-03-09T07:30:00Z"; // 00:30 PDT — the 9th

    for (const at of [early, late, nextDay]) {
      const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
      await addMention(cell, at);
    }

    await roll("2026-03-08", "America/Los_Angeles");
    expect((await metricRow())!.cells_total).toBe("2");
  });

  it("Scenario 6 — the cross-engine row is weighted from the per-engine rows", async () => {
    // google_ai_mode has weight 3, chatgpt weight 1. A brand present on the
    // heavy engine and absent on the light one should land near 3/4, not 1/2.
    const at = "2026-09-10T12:00:00Z";
    const strong = await addCell({ capturedAt: at, engineKey: "google_ai_mode", brandPresent: true, sov: 1 });
    await addMention(strong, at);
    const weak = await addCell({ capturedAt: at, engineKey: "chatgpt", brandPresent: false, sov: 0 });
    await addMention(weak, at, { prominence: 0.1, sentimentScore: 0 });

    await roll("2026-09-10");

    const blended = await metricRow(CROSS_ENGINE_KEY);
    const heavy = Number((await metricRow("google_ai_mode"))!.visibility_score);
    const light = Number((await metricRow("chatgpt"))!.visibility_score);
    expect(Number(blended!.visibility_score)).toBeCloseTo((3 * heavy + light) / 4, 2);
  });

  it("Scenario 8 — the live-capture ratio reflects the cache mix", async () => {
    const at = "2026-09-10T12:00:00Z";
    for (const layer of ["live", "l1", "l2", "live"]) {
      const cell = await addCell({ capturedAt: at, cacheLayer: layer, brandPresent: true, sov: 0.5 });
      await addMention(cell, at);
    }
    await roll("2026-09-10");
    expect(Number((await metricRow())!.live_capture_ratio)).toBeCloseTo(0.5, 5);
  });

  it("Scenario 9 — a day with no mentions has NULL rendering quality and NULL sentiment, never zero", async () => {
    // The migration that made `sentiment_score` nullable exists for this row.
    // On a 0-100 scale, 0 is maximally negative — a stronger lie than the 50
    // §6 already forbids.
    const at = "2026-09-10T12:00:00Z";
    const cell = await addCell({ capturedAt: at, brandPresent: false, sov: 0 });
    // A competitor mention, so the day has a competitor row too and the two
    // can be told apart.
    await addMention(cell, at, { entityType: "competitor", prominence: 0.5 });

    await roll("2026-09-10");

    // THE BRAND ROW EXISTS, and it used to not — found by STORY-136.
    //
    // This test previously asserted `toBeUndefined()` here, which was an
    // artefact of the entity set being derived from `mention_facts` alone
    // rather than a property anyone wanted: a day on which the engine
    // answered and named the brand in none of its answers produced no brand
    // row, so the day vanished from the rollup and presence rate 0 — the
    // single most important finding the product can report — was
    // indistinguishable from never having asked.
    const brand = (await metricRow("google_ai_mode", "brand"))!;
    expect(brand).toBeDefined();
    expect(Number(brand.cells_total)).toBe(1);
    expect(Number(brand.cells_present)).toBe(0);
    expect(Number(brand.presence_rate)).toBe(0);
    // And the title's own property, now testable on the brand at all:
    expect(brand.sentiment_score).toBeNull();
    expect(brand.rendering_quality).toBeNull();

    const competitor = await metricRow("google_ai_mode", "competitor");
    expect(competitor).toBeDefined();
  });

  it("writes NULL rendering quality for an engine that cannot render attributes", async () => {
    // STORY-039's AC6, surviving into the aggregate: an engine excluded from
    // its own denominator has no rendering figure at all, rather than a zero.
    const at = "2026-09-10T12:00:00Z";
    const cell = await addCell({ capturedAt: at, engineKey: "chatgpt", brandPresent: true, sov: 1 });
    await addMention(cell, at, { renderScore: 0.9 });

    await roll("2026-09-10");
    expect((await metricRow("chatgpt"))!.rendering_quality).toBeNull();
    expect(ATTRIBUTE_CAPABLE_ENGINES).not.toContain("chatgpt");
  });

  it("the aggregate's engine list matches the rendering library's", () => {
    // The predicate is SQL and the rule is TypeScript; this is what stops the
    // two drifting apart silently.
    expect([...AGGREGATE_ATTRIBUTE_CAPABLE_ENGINES].sort()).toEqual([...ATTRIBUTE_CAPABLE_ENGINES].sort());
  });

  it("EXCLUDES a failed cell from the totals, and keeps a refusal in", async () => {
    // §2.5's line: "The engine did not mention you" is data. "We could not
    // ask" is not.
    const at = "2026-09-10T12:00:00Z";
    const good = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(good, at);
    await addCell({ capturedAt: at, status: "failed", brandPresent: false });
    await addCell({ capturedAt: at, status: "parsed", brandPresent: false, sov: 0 });

    await roll("2026-09-10");
    // Two measured cells: the answer and the refusal. Not three.
    expect((await metricRow())!.cells_total).toBe("2");
    expect(Number((await metricRow())!.presence_rate)).toBeCloseTo(0.5, 5);
  });

  it("excludes an UNRESOLVED citation from the share", async () => {
    const at = "2026-09-10T12:00:00Z";
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(cell, at);
    await addCitation(cell, at, true);
    await addCitation(cell, at, false);
    await addCitation(cell, at, false, false); // unresolved — neither owned nor foreign

    await roll("2026-09-10");
    expect(Number((await metricRow())!.citation_share)).toBeCloseTo(0.5, 5);
  });

  it("Scenario 12 — two scoring versions coexist for one day", async () => {
    const at = "2026-09-10T12:00:00Z";
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(cell, at);
    await roll("2026-09-10");

    // A cut-over writes the same day under a new version and must not rewrite
    // history — the version is part of the primary key.
    await db.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date,
                                 cells_total, visibility_score, scoring_version)
       VALUES ($1,$2,'google_ai_mode','brand',$3,'2026-09-10',1,42.5,'v2')`,
      [workspaceId, projectId, projectId],
    );

    const versions = await db.query<{ scoring_version: string }>(
      "SELECT scoring_version FROM metric_daily WHERE engine_key = 'google_ai_mode' AND entity_type = 'brand' ORDER BY scoring_version",
    );
    expect(versions.rows.map((row) => row.scoring_version)).toEqual(["v1", "v2"]);
  });

  it("Scenario 10 — the project's denormalised block is updated", async () => {
    const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(cell, at);
    await roll(at.slice(0, 10));
    await denormalizeProject(db, projectId, "UTC");

    const row = await db.query<{ visibility_blended: string | null; sparkline_30d: unknown; aux_score_current: string | null }>(
      "SELECT visibility_blended::text, sparkline_30d, aux_score_current::text FROM projects WHERE id = $1",
      [projectId],
    );
    expect(Number(row.rows[0]!.visibility_blended)).toBeGreaterThan(0);
    expect(Array.isArray(row.rows[0]!.sparkline_30d)).toBe(true);
    // AC9 lists `aux_score_current`, and it has no producer. NULL rather than
    // 0: "audit score 0" reads as a failed audit, not as no audit.
    expect(row.rows[0]!.aux_score_current).toBeNull();
  });

  it("produces NO delta from an under-sampled window", async () => {
    // §3 and `NFR-ANL-03`: under 30 cells the delta is null, not zero. A zero
    // renders as a flat trend arrow — the most confident-looking thing in the
    // interface.
    const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(cell, at);
    await roll(at.slice(0, 10));
    await denormalizeProject(db, projectId, "UTC");

    const row = await db.query<{ visibility_delta_30d: string | null }>(
      "SELECT visibility_delta_30d::text FROM projects WHERE id = $1",
      [projectId],
    );
    expect(row.rows[0]!.visibility_delta_30d).toBeNull();
  });

  it("Scenario 11 — a rebuild over a range matches the incremental result", async () => {
    // "The rebuild path is the safety net for every scoring change, and it is
    // why the whole aggregation layer is recomputable rather than
    // incremental-only."
    for (const day of ["2026-09-08", "2026-09-09", "2026-09-10"]) {
      const at = `${day}T12:00:00Z`;
      const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 0.7 });
      await addMention(cell, at);
      await roll(day);
    }
    const incremental = await db.query<Record<string, string>>(
      "SELECT metric_date::text, visibility_score::text FROM metric_daily WHERE engine_key = 'google_ai_mode' AND entity_type='brand' ORDER BY metric_date",
    );

    await db.query("DELETE FROM metric_daily");
    await handler()(db, job({ fromDate: "2026-09-01", toDate: "2026-09-30" }));

    const rebuilt = await db.query<Record<string, string>>(
      "SELECT metric_date::text, visibility_score::text FROM metric_daily WHERE engine_key = 'google_ai_mode' AND entity_type='brand' ORDER BY metric_date",
    );
    expect(rebuilt.rows).toEqual(incremental.rows);
  });

  function handler() {
    return createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext);
  }

  function job(over: Record<string, unknown> = {}): Job {
    return {
      data: { payload: { workspaceId, kid: "test-kid", projectId, ...over } },
    } as unknown as Job;
  }

  it("reads the timezone from the WORKSPACE, not the payload", async () => {
    // A payload-supplied zone would let a stale job bucket a day against a
    // timezone the workspace has since changed.
    await setUp("Asia/Tokyo");
    const at = "2026-09-10T16:00:00Z"; // 2026-09-11 01:00 JST
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(cell, at);

    await handler()(db, job({ metricDate: "2026-09-11" }));
    expect((await metricRow())!.cells_total).toBe("1");
  });

  it("skips a project that no longer exists", async () => {
    await expect(
      handler()(db, { data: { payload: { workspaceId, kid: "k", projectId: randomUUID() } } } as unknown as Job),
    ).resolves.toBeUndefined();
  });

  it("Scenario 2 — the advisory lock is held per project", async () => {
    // Proven by observing the lock rather than by racing two clients, which
    // would be a timing test. `pg_advisory_xact_lock` on the same key from a
    // second session would block; that the key is TAKEN is the assertion.
    const at = "2026-09-10T12:00:00Z";
    const cell = await addCell({ capturedAt: at, brandPresent: true, sov: 1 });
    await addMention(cell, at);

    await db.query("BEGIN");
    await handler()(db, job({ metricDate: "2026-09-10" }));
    const locks = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
    );
    await db.query("COMMIT");

    expect(Number(locks.rows[0]!.n)).toBeGreaterThan(0);
  });
});
