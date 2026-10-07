import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { citationGapSchema, conceptGapSchema, displacedBySchema } from "../../contracts/analytics/displacement-event.schema.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { backfillProjectDisplacements, refreshProjectDisplacements } from "../../src/lib/rollup/refresh-project-displacements.js";

// NEW-C-3 — STORY-056 scenarios 8, 9, 10 (and the persisted halves of 1, 5, 6,
// 7) and STORY-057 scenarios 1, 2, 3. Scenarios 11 and 13 are deferred.

const D1 = "2026-10-05";
const D2 = "2026-10-06";
const D3 = "2026-10-07";

interface EventRow {
  kind: string;
  before_result_id: string;
  after_result_id: string;
  before_position: number | null;
  after_position: number | null;
  displaced_by: unknown;
  citation_gap: unknown;
  concept_gap: unknown;
  impact_score: number;
  recovered_at: Date | null;
  acknowledged_at: Date | null;
}

describe("NEW-C-3 · refreshProjectDisplacements", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let rivalId: string;

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
      "TRUNCATE displacement_events, project_source_index, source_domains, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    rivalId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'Acme',$3,'https://acme.com','acme.com')`,
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1,$2,$3,'Rival','rival.com',ARRAY[]::text[],'user')`,
      [rivalId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','decision','active')`,
      [promptId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ('gemini','g','v','api','1',86400,'medium','free','active'), ('chatgpt','c','v','api','1',86400,'medium','free','active')`,
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count, weight)
       VALUES ($1,$2,'gemini',true,1,1), ($1,$2,'chatgpt',true,1,1)`,
      [workspaceId, projectId],
    );
  });

  interface CaptureSpec {
    at: string;
    engine?: string;
    present: boolean | null;
    position?: number | null;
    cls?: string; // the brand's position class
    render?: string;
    status?: string;
    rival?: { position: number; cls?: string };
    other?: { label: string; position: number };
  }

  async function capture(spec: CaptureSpec): Promise<string> {
    const id = randomUUID();
    const engine = spec.engine ?? "gemini";
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
          normalizer_version, content_hash, brand_present, brand_rank_position, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1','n1',$8,$9,$10,$11)`,
      [id, workspaceId, projectId, randomUUID(), promptId, engine, spec.at, createHash("sha256").update(id).digest(), spec.present, spec.position ?? null, spec.status ?? "parsed"],
    );
    const mention = async (type: string, entityId: string | null, label: string, position: number, cls: string, render: string): Promise<void> => {
      await db.query(
        `INSERT INTO mention_facts
           (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, entity_type, entity_id, entity_label, matched_alias,
            occurrence_index, char_start, char_end, first_token_index, prominence, list_position, sentiment_label, sentiment_score,
            sentiment_confidence, sentiment_method, position_class, render_form)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$9,0,0,1,0,0.7,$10,'neutral',0,0.9,'lexicon',$11,$12)`,
        [workspaceId, projectId, id, promptId, engine, spec.at, type, entityId, label, position, cls, render],
      );
    };
    if (spec.present === true) await mention("brand", null, "Acme", spec.position ?? 1, spec.cls ?? "ranked", spec.render ?? "described");
    if (spec.rival) await mention("competitor", rivalId, "Rival", spec.rival.position, spec.rival.cls ?? "ranked", "described");
    if (spec.other) await mention("other", null, spec.other.label, spec.other.position, "ranked", "described");
    return id;
  }

  async function cite(resultId: string, at: string, over: { domain: string; url?: string; owned?: boolean; slot?: number; sourceClass?: string | null; engine?: string }): Promise<void> {
    const url = over.url ?? `https://${over.domain}/${randomUUID().slice(0, 6)}`;
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash,
          domain, is_owned, is_competitor, source_class, http_status, position_weight)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$8,$9,$10,$11,false,$12,200,1)`,
      [workspaceId, projectId, resultId, promptId, over.engine ?? "gemini", at, over.slot ?? 1, url, createHash("sha256").update(url).digest(), over.domain, over.owned ?? false, over.sourceClass ?? null],
    );
  }

  const run = async (date: string): Promise<void> => {
    await db.query("BEGIN");
    await refreshProjectDisplacements(db, projectId, date, "UTC");
    await db.query("COMMIT");
  };

  const events = async (): Promise<EventRow[]> =>
    (await db.query<EventRow>(`SELECT * FROM displacement_events WHERE project_id = $1 ORDER BY detected_at, kind`, [projectId])).rows;

  it("STORY-056 #1 · present then absent persists a presence_lost event naming both captures", async () => {
    const before = await capture({ at: `${D1}T10:00:00Z`, present: true, position: 2 });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    const [event, ...rest] = await events();
    expect(rest).toHaveLength(0);
    expect(event!.kind).toBe("presence_lost");
    expect(event!.before_result_id).toBe(before);
    expect(event!.after_result_id).toBe(after);
    expect(event!.before_position).toBe(2);
    expect(event!.after_position).toBeNull();
  });

  it("STORY-056 #5 · an UNTRACKED entity that took the slot is persisted in displaced_by", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, other: { label: "Stranger Inc", position: 1 } });
    await run(D2);
    const [event] = await events();
    const displacedBy = displacedBySchema.parse(event!.displaced_by);
    expect(displacedBy.map((e) => [e.entity_label, e.is_tracked, e.entity_id])).toEqual([["Stranger Inc", false, null]]);
  });

  it("STORY-056 #8 · re-running the same pair creates no duplicate", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    await run(D2);
    await run(D2);
    expect(await events()).toHaveLength(1);
  });

  it("STORY-056 #9 · reprocessing a dirty date, in any order, creates no duplicate and keeps acknowledgement", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    await db.query(`UPDATE displacement_events SET acknowledged_at = now() WHERE project_id = $1`, [projectId]);
    await capture({ at: `${D3}T10:00:00Z`, present: false, rival: { position: 1 } }); // a late fact on a later day
    await run(D3);
    await run(D2); // the earlier day is dirtied and re-run after the later one
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.acknowledged_at).not.toBeNull();
  });

  it("STORY-056 #10 · a later capture restoring presence sets recovered_at, leaves the open feed, and the row is retained", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    const restored = `${D3}T10:00:00Z`;
    await capture({ at: restored, present: true, position: 1 });
    await run(D3);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recovered_at?.toISOString()).toBe(new Date(restored).toISOString());
    const open = await db.query(`SELECT 1 FROM displacement_events WHERE project_id = $1 AND recovered_at IS NULL`, [projectId]);
    expect(open.rowCount).toBe(0);
    await run(D3);
    expect((await events())[0]!.recovered_at?.toISOString()).toBe(new Date(restored).toISOString());
  });

  it("STORY-056 #10 · a position loss recovers only when the position is regained, not on any later capture", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 2 });
    await capture({ at: `${D2}T10:00:00Z`, present: true, position: 5, rival: { position: 1 } });
    await run(D2);
    await capture({ at: `${D3}T10:00:00Z`, present: true, position: 4 }); // better, still worse than 2
    await run(D3);
    expect((await events())[0]!.recovered_at).toBeNull();
    await capture({ at: `${D3}T14:00:00Z`, present: true, position: 2 });
    await run(D3);
    expect((await events())[0]!.recovered_at).not.toBeNull();
  });

  it("STORY-056 · a capture with an unknown brand outcome (null) neither opens nor recovers an event", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: null });
    await run(D2);
    expect(await events()).toHaveLength(0);
    await capture({ at: `${D2}T12:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    // the pair is against the previous capture of the cell, the null one included in time order but never a baseline
    expect((await events()).every((e) => e.recovered_at === null)).toBe(true);
  });

  it("STORY-056 · cells are independent: another engine's capture is never the 'previous' capture", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, engine: "chatgpt" });
    await capture({ at: `${D2}T10:00:00Z`, present: false, engine: "gemini" });
    await run(D2);
    expect(await events()).toHaveLength(0);
  });

  it("STORY-056 #6 · the persisted impact score is the hand-computed value (presence lost, decision prompt, one-citation gap)", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, cls: "recommendation" });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/best" });
    await run(D2);
    // 100 · (0.35·1 + 0.25·1.00 + 0.20·(0.5·1.0 + 0.5·1) + 0.10·1 + 0.10·(1 − 1/5)) = 98
    expect((await events())[0]!.impact_score).toBeCloseTo(98, 4);
  });

  it("STORY-056 #7 · a smaller citation gap scores higher than a larger one", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, cls: "recommendation" });
    const small = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await cite(small, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/a" });
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, cls: "recommendation", engine: "chatgpt" });
    const large = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 }, engine: "chatgpt" });
    for (let i = 1; i <= 5; i++) await cite(large, `${D2}T10:00:00Z`, { domain: "rival.com", url: `https://rival.com/${i}`, slot: i, engine: "chatgpt" });
    await run(D2);
    const byEngine = new Map((await db.query<{ engine_key: string; impact_score: number }>(`SELECT engine_key, impact_score FROM displacement_events`)).rows.map((r) => [r.engine_key, r.impact_score]));
    expect(byEngine.get("gemini")!).toBeGreaterThan(byEngine.get("chatgpt")!);
  });

  it("STORY-057 #1 · the citation gap lists url, domain, class and holders for slots the displacer holds", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/guide", sourceClass: "vendor_owned" });
    await run(D2);
    const gap = citationGapSchema.parse((await events())[0]!.citation_gap);
    expect(gap).toEqual([{ url: "https://rival.com/guide", domain: "rival.com", source_class: "vendor_owned", held_by: ["Rival"], brand_present: null }]);
  });

  it("STORY-057 #2 · a citation the competitor does not hold NEVER appears in the gap", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/held", slot: 1 });
    await cite(after, `${D2}T10:00:00Z`, { domain: "reddit.com", url: "https://reddit.com/r/x/unrelated", slot: 2 }); // on the answer, not the rival's
    await cite(after, `${D2}T10:00:00Z`, { domain: "acme.com", url: "https://acme.com/own", owned: true, slot: 3 });
    // a citation the rival held on the BEFORE capture only is not on the after-capture
    const beforeRow = (await db.query<{ id: string }>(`SELECT id FROM answer_captures WHERE project_id = $1 ORDER BY captured_at LIMIT 1`, [projectId])).rows[0]!.id;
    await cite(beforeRow, `${D1}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/old" });
    await run(D2);
    const gap = citationGapSchema.parse((await events())[0]!.citation_gap);
    expect(gap.map((g) => g.url)).toEqual(["https://rival.com/held"]);
  });

  it("STORY-057 #2 · an untracked displacer holds no attributable citation, so the gap is empty rather than guessed", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, other: { label: "Stranger Inc", position: 1 } });
    await cite(after, `${D2}T10:00:00Z`, { domain: "stranger.io", url: "https://stranger.io/x" });
    await run(D2);
    expect((await events())[0]!.citation_gap).toEqual([]);
  });

  it("STORY-057 #3 · brand presence on a gap domain comes from the verified source index, and null when unverified", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await cite(after, `${D2}T10:00:00Z`, { domain: "g2.com", url: "https://g2.com/rival", slot: 1, sourceClass: "review_marketplace" });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/x", slot: 2 });
    // the rival holds g2.com on this capture: attribute by domain match for g2 via a second competitor domain
    await db.query(`UPDATE competitors SET root_domain = NULL WHERE id = $1`, [rivalId]);
    await run(D2);
    // with no competitor domain nothing is attributable at all
    expect((await events())[0]!.citation_gap).toEqual([]);

    await db.query(`UPDATE competitors SET root_domain = 'rival.com' WHERE id = $1`, [rivalId]);
    const sd = await db.query<{ id: string }>(
      `INSERT INTO source_domains (workspace_id, domain, display_name, source_class, is_seedable) VALUES ($1,'rival.com','rival.com','vendor_owned',false) RETURNING id`,
      [workspaceId],
    );
    await db.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, citation_count,
         distinct_prompts, distinct_urls, avg_position_weight, context_weight, rank_position, brand_present_on_domain, verified_at, scoring_version)
       VALUES ($1,$2,$3,'all','2026-09-07',30,1,1,1,1,1,1,true,now(),'v1')`,
      [workspaceId, projectId, sd.rows[0]!.id],
    );
    await run(D2);
    const gap = citationGapSchema.parse((await events())[0]!.citation_gap);
    expect(gap.map((g) => [g.domain, g.brand_present])).toEqual([["rival.com", true]]);
  });

  it("STORY-057 · concept_gap is stored as [] (no corpus exists until STORY-058) and parses", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    expect(conceptGapSchema.parse((await events())[0]!.concept_gap)).toEqual([]);
  });

  it("the rollup handler persists displacements for the date it rolls up", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    const handler = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext);
    const job = { data: { payload: { workspaceId, kid: "k", projectId, metricDate: D2 } } } as unknown as Job;
    await handler(db, job);
    await handler(db, job);
    expect(await events()).toHaveLength(1);
  });

  it("backfill over existing captures finds the same events and is idempotent", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await capture({ at: `${D3}T10:00:00Z`, present: true, position: 1 });
    await db.query("BEGIN");
    await backfillProjectDisplacements(db, projectId, "UTC", D1, D3);
    await backfillProjectDisplacements(db, projectId, "UTC", D1, D3);
    await db.query("COMMIT");
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recovered_at).not.toBeNull();
  });
});
