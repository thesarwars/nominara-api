import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { lockNodeScope } from "../../src/lib/geo/alignment/scope-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { citationGapSchema, conceptGapSchema, displacedBySchema } from "../../contracts/analytics/displacement-event.schema.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import { asTenantJob } from "../support/tenant-job.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
const parseContextSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/lib/parser/parse-capture.js", async (original) => {
  const actual = await original<typeof import("../../src/lib/parser/parse-capture.js")>();
  return { ...actual, loadParseContext: (...args: Parameters<typeof actual.loadParseContext>) => { parseContextSpy.calls += 1; return actual.loadParseContext(...args); } };
});
import { backfillProjectDisplacements, refreshProjectDisplacements } from "../../src/lib/rollup/refresh-project-displacements.js";
import { mapSerpAnswer } from "../../src/lib/engines/serp/serp-mapper.js";
import { aiModePriced } from "../../src/lib/engines/serp/fixtures/serp-recorded.js";

// NEW-C-3 — STORY-056 scenarios 8, 9, 10 (and the persisted halves of 1, 5, 6,
// 7) and STORY-057 scenarios 1, 2, 3. Scenario 11 (the recovery milestone) and 12 (detection lag) are here;
// scenario 13 (the no-cooldown alert) belongs to STORY-068's catalog (owner decision 2026-10-27).

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

const spans = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }));

describe("NEW-C-3 · refreshProjectDisplacements", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let worker: Client;
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
    const password = resolvePassword("nominara_worker", {});
    await db.query(`ALTER ROLE nominara_worker PASSWORD ${db.escapeLiteral(password)}`);
    worker = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_worker",
      password,
    });
    await worker.connect();
  }, 300_000);

  afterAll(async () => {
    await worker.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE displacement_events, semantic_nodes, geo_alignments, milestones, tasks, project_source_index, source_domains, mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, projects, workspaces, engines CASCADE",
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
    prompt?: string;
    engine?: string;
    present: boolean | null;
    position?: number | null;
    cls?: string; // the brand's position class
    render?: string;
    status?: string;
    flags?: string[];
    text?: string; // payload.text; "" is an empty answer
    elements?: unknown[]; // payload.structured_elements: what the adapter stored (STORY-057 AC3)
    rivalLabel?: string; // the competitor's mention label (default "Rival")
    rival?: { position: number; cls?: string };
    other?: { label: string; position: number };
  }

  async function capture(spec: CaptureSpec): Promise<string> {
    const id = randomUUID();
    const engine = spec.engine ?? "gemini";
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
          normalizer_version, content_hash, brand_present, brand_rank_position, status, flags, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1','n1',$8,$9,$10,$11,$12::text[],$13::jsonb)`,
      [id, workspaceId, projectId, randomUUID(), spec.prompt ?? promptId, engine, spec.at, createHash("sha256").update(id).digest(), spec.present, spec.position ?? null, spec.status ?? "parsed", spec.flags ?? [], JSON.stringify({ ...(spec.text === undefined ? {} : { text: spec.text }), ...(spec.elements === undefined ? {} : { structured_elements: spec.elements }) })],
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
    if (spec.rival) await mention("competitor", rivalId, spec.rivalLabel ?? "Rival", spec.rival.position, spec.rival.cls ?? "ranked", "described");
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

  // Owner decision 57a - a refused or empty answer counts as "not mentioned" in presence but is NO OBSERVATION for displacement.
  it("STORY-056 · decision 57a: present, refused, present again opens no event and records no recovery", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, text: "", flags: ["engine_refused_to_answer"] });
    await run(D2);
    expect(await events()).toHaveLength(0);
    await capture({ at: `${D3}T10:00:00Z`, present: true, position: 1 });
    await run(D3);
    expect(await events()).toHaveLength(0);
  });

  it("STORY-056 · decision 57a: an EMPTY answer with no flag is no observation either", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, text: "" });
    await run(D2);
    expect(await events()).toHaveLength(0);
  });

  it("STORY-056 · decision 57a: a reused (L2) row that resolved to an empty answer is no observation - and stays so after its source is deleted", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    const source = await capture({ at: `${D1}T12:00:00Z`, present: null, engine: "chatgpt", text: "" });
    // The parse handler denormalises the resolution onto the reused row's OWN flags; the detector reads nothing else.
    const reused = await capture({ at: `${D2}T10:00:00Z`, present: false, status: "skipped", flags: ["empty_answer"] });
    await db.query("UPDATE answer_captures SET cache_layer = 'l2', source_result_id = $2 WHERE id = $1", [reused, source]);
    await db.query("DELETE FROM answer_captures WHERE id = $1", [source]); // retention dropped the source
    await run(D2);
    expect(await events()).toHaveLength(0);
  });

  it("STORY-056 · decision 57a: an L1 empty row (own payload text, empty_answer flag) is no observation", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, status: "skipped", flags: ["empty_answer"], text: "" });
    await run(D2);
    expect(await events()).toHaveLength(0);
  });

  it("STORY-056 · decision 57a: an L2 row whose source is truncated-empty (unscored, rematch_unavailable) is no observation", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    const source = await capture({ at: `${D1}T12:00:00Z`, present: null, engine: "chatgpt", text: "" });
    await db.query("UPDATE answer_captures SET truncated = true WHERE id = $1", [source]);
    const reused = await capture({ at: `${D2}T10:00:00Z`, present: null, status: "skipped", flags: ["rematch_unavailable"] });
    await db.query("UPDATE answer_captures SET cache_layer = 'l2', source_result_id = $2 WHERE id = $1", [reused, source]);
    await run(D2);
    expect(await events()).toHaveLength(0);
  });

  it("STORY-056 · decision 57a: a refused row that is the only earlier row leaves the next observation with no baseline", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: false, text: "", flags: ["engine_refused_to_answer"] });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    expect(await events()).toHaveLength(0);
  });

  it.each([["a BOM", "\uFEFF"], ["a space", " "], ["a no-break space", "\u00A0"]])(
    "[audit r4 AC2] STORY-056: %s-only answer is no observation by its FLAG (the parse stamps empty_answer), and by the text for a legacy unflagged row",
    async (_label, text) => {
      for (const flags of [["empty_answer"], []]) {
        await db.query("DELETE FROM answer_captures WHERE project_id = $1", [projectId]);
        await db.query("DELETE FROM displacement_events WHERE project_id = $1", [projectId]);
        await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
        await capture({ at: `${D2}T10:00:00Z`, present: false, text, flags });
        await run(D2);
        expect(await events(), JSON.stringify({ text, flags })).toHaveLength(0);
      }
    },
  );

  it("STORY-056 · decision 57a: a WHITESPACE-only answer is an empty answer - no observation, no baseline", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, text: "\n  " });
    await run(D2);
    expect(await events()).toHaveLength(0);
    // ... and as the only earlier row it leaves no baseline either.
    await db.query("DELETE FROM answer_captures WHERE project_id = $1", [projectId]);
    await capture({ at: `${D1}T10:00:00Z`, present: false, text: " " });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    expect(await events()).toHaveLength(0);
  });

  it("STORY-056 · decision 57a: a refused answer does not close an open event, and is not the baseline of the next one", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    expect((await events())[0]!.recovered_at).toBeNull();
    await capture({ at: `${D3}T10:00:00Z`, present: false, text: "", flags: ["engine_refused_to_answer"] });
    await run(D3);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recovered_at).toBeNull();
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

  // CP2 QA, STORY-056 criterion 4. scoring-models.md section 9 names
  // `rank_of_topic_by_intent` but defines no ordering rule. The plan's reading,
  // FLAGGED as a spec question for the owner: rank 1 for EVERY prompt, whether or
  // not it sits in a topic cluster. The earlier code ranked clusters by
  // commercial_intent without saying so; this pins the stated reading.
  it("CP2 STORY-056 · rank_of_topic_by_intent is 1 for every prompt, even one in a lower-intent cluster (flagged spec reading)", async () => {
    const high = randomUUID();
    const low = randomUUID();
    await db.query(
      `INSERT INTO topic_clusters (id, workspace_id, project_id, label, commercial_intent)
       VALUES ($1,$3,$4,'High intent',0.9), ($2,$3,$4,'Low intent',0.4)`,
      [high, low, workspaceId, projectId],
    );
    await db.query(`UPDATE tracked_prompts SET cluster_id = $1 WHERE id = $2`, [low, promptId]);
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, cls: "recommendation" });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/best" });
    await run(D2);
    // Same hand computation as #6: 1 / rank = 1, so 98. Ranking the clusters would give rank 2 and 93.
    expect((await events())[0]!.impact_score).toBeCloseTo(98, 4);
  });

  // ---- STORY-056 #11 — the recovery milestone ----------------------------------------------------------------------

  /** A task linked to the (only) event, completed `completedAt` (null = still open). */
  async function linkTask(status: string, completedAt: string | null): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, completed_at)
       VALUES ($1,$2,$3,$4,'content',sha256(random()::text::bytea),'t','d',$5,$6::timestamptz)`,
      [id, workspaceId, projectId, `T-${id.slice(0, 8)}`, status, completedAt],
    );
    await db.query(`UPDATE displacement_events SET task_id = $1 WHERE project_id = $2`, [id, projectId]);
    return id;
  }

  const recoveryMilestones = async (): Promise<Array<Record<string, unknown>>> =>
    (await db.query(`SELECT * FROM milestones WHERE project_id = $1 AND kind = 'displacement_recovered'`, [projectId])).rows;

  async function lostThenRecovered(): Promise<{ eventId: string; restoredAt: string }> {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await run(D2);
    return { eventId: (await db.query<{ id: string }>(`SELECT id FROM displacement_events WHERE project_id = $1`, [projectId])).rows[0]!.id, restoredAt: `${D3}T10:00:00Z` };
  }

  it("STORY-056 #11 · a recovery that follows a completed task emits a displacement_recovered milestone at the recovery instant", async () => {
    const { eventId, restoredAt } = await lostThenRecovered();
    const taskId = await linkTask("done", `${D2}T18:00:00Z`);
    await capture({ at: restoredAt, present: true, position: 1, engine: "gemini" });
    await run(D3);
    const [m, ...rest] = await recoveryMilestones();
    expect(rest).toHaveLength(0);
    expect(m!.workspace_id).toBe(workspaceId);
    expect((m!.occurred_at as Date).toISOString()).toBe(new Date(restoredAt).toISOString());
    expect(m!.severity).toBe("positive");
    expect(m!.source_type).toBe("system");
    expect(m!.source_id).toBe(eventId);
    expect(m!.affected_engines).toEqual(["gemini"]);
    expect(m!.created_by).toBeNull();
    expect(JSON.stringify(m)).not.toContain(taskId); // the pin names the event, not the task
  });

  it("STORY-056 #11 · re-running the recovery (or a dirty-date reprocess) never pins a second milestone", async () => {
    const { restoredAt } = await lostThenRecovered();
    await linkTask("done", `${D2}T18:00:00Z`);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    await run(D3);
    await run(D2);
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(1);
  });

  it("STORY-056 #11 · a recovery with no linked task emits no milestone", async () => {
    const { restoredAt } = await lostThenRecovered();
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect((await events())[0]!.recovered_at).not.toBeNull();
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it.each(["todo", "in_progress", "dismissed"])("STORY-056 #11 · a linked task that is %s (not completed) emits no milestone", async (status) => {
    const { restoredAt } = await lostThenRecovered();
    await linkTask(status, null);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it.each(["dismissed", "in_progress"])("STORY-056 #11 · a %s task carrying a stale completed_at before the recovery is not a completed task: no milestone", async (status) => {
    const { restoredAt } = await lostThenRecovered();
    await linkTask(status, `${D2}T18:00:00Z`);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it("STORY-056 #11 · a task completed AFTER the recovery did not cause it: no milestone", async () => {
    const { restoredAt } = await lostThenRecovered();
    await linkTask("done", `${D3}T12:00:00Z`);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it("STORY-056 #11 · a task completed at the very instant of recovery is not 'before' it: no milestone (strict <)", async () => {
    const { restoredAt } = await lostThenRecovered();
    await linkTask("done", restoredAt);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it("STORY-056 #11 · a soft-deleted linked task emits no milestone", async () => {
    const { restoredAt } = await lostThenRecovered();
    const taskId = await linkTask("done", `${D2}T18:00:00Z`);
    await db.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [taskId]);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it("STORY-056 #11 · a capture that does not restore the slot emits no milestone", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 2 });
    await capture({ at: `${D2}T10:00:00Z`, present: true, position: 5, rival: { position: 1 } });
    await run(D2);
    await linkTask("done", `${D2}T18:00:00Z`);
    await capture({ at: `${D3}T10:00:00Z`, present: true, position: 4 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it("STORY-056 #11 · a plan of several tasks pins when ANY of its tasks was completed before the recovery, though the linked first task was dismissed", async () => {
    const { eventId, restoredAt } = await lostThenRecovered();
    await linkTask("dismissed", null); // displacement_events.task_id holds only the plan's FIRST task
    const second = randomUUID();
    await db.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, completed_at, source_displacement_id)
       VALUES ($1,$2,$3,$4,'authority',sha256(random()::text::bytea),'t2','d','done',$5::timestamptz,$6)`,
      [second, workspaceId, projectId, `T-${second.slice(0, 8)}`, `${D2}T18:00:00Z`, eventId],
    );
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(1);
  });

  it("STORY-056 #11 · a sibling task born of the event that is dismissed or completed AFTER the recovery pins nothing", async () => {
    const { eventId, restoredAt } = await lostThenRecovered();
    await linkTask("dismissed", null);
    for (const [status, at] of [["dismissed", null], ["done", `${D3}T12:00:00Z`]] as const) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, completed_at, source_displacement_id)
         VALUES ($1,$2,$3,$4,'authority',sha256(random()::text::bytea),'t2','d',$5,$6::timestamptz,$7)`,
        [id, workspaceId, projectId, `T-${id.slice(0, 8)}`, status, at, eventId],
      );
    }
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect(await recoveryMilestones()).toHaveLength(0);
  });

  it("STORY-056 #11 · pin is portal-visible, explicitly", async () => {
    const { restoredAt } = await lostThenRecovered();
    await linkTask("done", `${D2}T18:00:00Z`);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    expect((await recoveryMilestones())[0]!.visible_in_portal).toBe(true);
  });

  it("STORY-056 #11 · the pinned log line carries the workspace id, and no workspace name", async () => {
    const lines: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(m));
    const { restoredAt } = await lostThenRecovered();
    await linkTask("done", `${D2}T18:00:00Z`);
    await capture({ at: restoredAt, present: true, position: 1 });
    await run(D3);
    spy.mockRestore();
    const pinned = lines.find((l) => (l as { event?: string }).event === "displacement_recovery_milestone_pinned") as { workspaceId?: string };
    expect(pinned.workspaceId).toBe(workspaceId);
  });

  describe("STORY-056 #11 · the recovery pin as the runtime role, under RLS", () => {
    const runAsWorker = (ws: string): Promise<number> =>
      withTenantContext(worker, { workspaceId: ws, actorId: randomUUID() } as never, (tx) => refreshProjectDisplacements(tx, projectId, D3, "UTC"));

    it("STORY-056 #11 · the connection is subject to RLS (so the cases below cannot pass vacuously)", async () => {
      const role = await worker.query<{ rolbypassrls: boolean; rolsuper: boolean }>("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user");
      expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    });

    it("STORY-056 #11 · positive control: in its own workspace's context the pin lands with that workspace_id", async () => {
      const { restoredAt } = await lostThenRecovered();
      await linkTask("done", `${D2}T18:00:00Z`);
      await capture({ at: restoredAt, present: true, position: 1 });
      await runAsWorker(workspaceId);
      const [m, ...rest] = await recoveryMilestones();
      expect(rest).toHaveLength(0);
      expect(m!.workspace_id).toBe(workspaceId);
    });

    it("STORY-056 #11 · a completed task in ANOTHER workspace (linked by task_id and by source_displacement_id) is invisible and pins nothing", async () => {
      const { eventId, restoredAt } = await lostThenRecovered();
      const otherWs = randomUUID();
      const otherProject = randomUUID();
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W2',$2,'growth','UTC')", [otherWs, `w-${otherWs.slice(0, 8)}`]);
      await db.query(
        `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'Other',$3,'https://other.com','other.com')`,
        [otherProject, otherWs, `p-${otherProject.slice(0, 8)}`],
      );
      const foreign = async (sourceDisplacement: string | null): Promise<string> => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, completed_at, source_displacement_id)
           VALUES ($1,$2,$3,$4,'content',sha256(random()::text::bytea),'t','d','done',$5::timestamptz,$6)`,
          [id, otherWs, otherProject, `T-${id.slice(0, 8)}`, `${D2}T18:00:00Z`, sourceDisplacement],
        );
        return id;
      };
      await foreign(eventId);
      await db.query(`UPDATE displacement_events SET task_id = $1 WHERE id = $2`, [await foreign(null), eventId]);
      await capture({ at: restoredAt, present: true, position: 1 });
      await runAsWorker(workspaceId);
      expect((await events())[0]!.recovered_at).not.toBeNull();
      expect(await recoveryMilestones()).toHaveLength(0);
    });
  });

  // ---- STORY-056 #12 — detection lag --------------------------------------------------------------------------------

  const LAG_METRIC = "nominara_rollup_displacement_detection_lag_seconds";
  const LAG_OBJECTIVE_SECONDS = 20 * 60; // edge-cases-and-slos.md #27: p95 <= 20 min

  describe("STORY-056 #12 · detection lag", () => {
    let lines: unknown[];
    beforeEach(() => {
      lines = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(m));
      spans.reset();
    });
    afterEach(() => vi.restoreAllMocks());
    const lagLines = (): Array<{ metric: string; value: number }> =>
      lines.filter((l): l is { metric: string; value: number } => typeof l === "object" && l !== null && (l as { metric?: string }).metric === LAG_METRIC);

    async function lossTwoMinutesAgo(): Promise<string> {
      const afterAt = new Date(Date.now() - 2 * 60_000);
      await capture({ at: new Date(afterAt.getTime() - 3_600_000).toISOString(), present: true, position: 1 });
      await capture({ at: afterAt.toISOString(), present: false, rival: { position: 1 } });
      return afterAt.toISOString().slice(0, 10);
    }

    it("STORY-056 #12 · observes the lag as detected_at minus captured_at once per new event (a measurement; the SLO p95 proof needs the production histogram)", async () => {
      await run(await lossTwoMinutesAgo());
      const observed = lagLines();
      expect(observed).toHaveLength(1);
      expect(observed[0]!.value).toBeGreaterThan(100);
      expect(observed[0]!.value).toBeLessThan(LAG_OBJECTIVE_SECONDS);
    });

    it("STORY-056 #12 · the observed value is detected_at minus captured_at as stored, not a second clock", async () => {
      await run(await lossTwoMinutesAgo());
      const stored = (
        await db.query<{ lag: number }>(
          `SELECT extract(epoch FROM (e.detected_at - a.captured_at))::float8 AS lag FROM displacement_events e JOIN answer_captures a ON a.id = e.after_result_id`,
        )
      ).rows[0]!.lag;
      expect(lagLines()[0]!.value).toBeCloseTo(stored, 3);
    });

    it("STORY-056 #12 · a re-run updates the existing event and observes no further lag (idempotent, no double count)", async () => {
      const date = await lossTwoMinutesAgo();
      await run(date);
      await run(date);
      expect(lagLines()).toHaveLength(1);
    });

    const rollupJob = (payload: Record<string, unknown>): Job =>
      ({ data: { payload: { workspaceId, kid: "k", projectId, ...payload } } }) as unknown as Job;
    const rollupHandler = () => createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext);

    it("STORY-056 #12 · a single-date rollup job (the live path) observes the lag", async () => {
      const date = await lossTwoMinutesAgo();
      await asTenantJob(db, workspaceId, () => rollupHandler()(db, rollupJob({ metricDate: date })));
      expect(lagLines()).toHaveLength(1);
    });

    it("STORY-056 #12 · a fromDate/toDate rebuild job observes no lag, so a rebuild cannot put days-old lags into the p95 series", async () => {
      const date = await lossTwoMinutesAgo();
      await asTenantJob(db, workspaceId, () => rollupHandler()(db, rollupJob({ fromDate: date, toDate: date })));
      expect(await events()).toHaveLength(1);
      expect(lagLines()).toHaveLength(0);
    });

    it("STORY-056 #12 · a transaction that rolls back after the refresh observes nothing; its retry observes the event once", async () => {
      const date = await lossTwoMinutesAgo();
      const ctx = { workspaceId, actorId: randomUUID() } as never;
      await expect(
        withTenantContext(worker, ctx, async (tx) => {
          await refreshProjectDisplacements(tx, projectId, date, "UTC");
          throw new Error("a later rollup step failed");
        }),
      ).rejects.toThrow("a later rollup step failed");
      expect(await events()).toHaveLength(0);
      expect(lagLines()).toHaveLength(0);
      await withTenantContext(worker, ctx, (tx) => refreshProjectDisplacements(tx, projectId, date, "UTC"));
      expect(lagLines()).toHaveLength(1);
    });

    it("STORY-056 #12 · a cell with no loss observes no lag", async () => {
      await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
      await capture({ at: `${D2}T10:00:00Z`, present: true, position: 1 });
      await run(D2);
      expect(lagLines()).toHaveLength(0);
    });

    it("STORY-056 #12 · the lag line carries no workspace name, prompt text or engine answer text", async () => {
      await run(await lossTwoMinutesAgo());
      const text = JSON.stringify(lines);
      expect(text).not.toContain("Acme");
      expect(text).not.toContain("Rival");
    });

    it("STORY-056 · the refresh runs inside a displacement.refresh span carrying the project id and the event count", async () => {
      await run(await lossTwoMinutesAgo());
      const span = spans.getFinishedSpans().find((s) => s.name === "displacement.refresh");
      expect(span).toBeDefined();
      expect(span!.attributes["nominara.project_id"]).toBe(projectId);
      expect(span!.attributes["nominara.displacement.events"]).toBe(1);
    });
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
    expect(gap).toEqual([{ url: "https://rival.com/guide", domain: "rival.com", source_class: "vendor_owned", held_by: ["Rival"], brand_present: null, scope: "answer" }]);
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

  // ---- STORY-057 AC4/AC5: the concept gap, from the analysed semantic nodes of the prompt's cluster -----------------------------

  const clusterId = randomUUID();

  async function inCluster(cluster: string | null): Promise<void> {
    await db.query(`UPDATE tracked_prompts SET cluster_id = $2 WHERE id = $1`, [promptId, cluster]);
  }

  async function node(phrase: string, over: { ratio?: number; present?: boolean; evidence?: string; cluster?: string | null; rank?: number | null; collapsed?: boolean; project?: string } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO semantic_nodes (id, workspace_id, project_id, prompt_cluster_id, phrase, phrase_normalized, node_type, corpus_doc_ratio,
          present_in_content, evidence_url, evidence_snippet, priority_rank)
       VALUES ($1,$2,$3,$4,$5,$6,'capability',$7,$8,$9,'snippet',$10)`,
      [id, workspaceId, over.project ?? projectId, over.cluster === undefined ? clusterId : over.cluster, phrase, phrase.toLowerCase(), over.ratio ?? 0.6,
        over.present ?? false, over.evidence ?? "https://rival.com/p", over.rank === undefined ? null : over.rank],
    );
    if (over.collapsed === true) {
      const keeper = await node(`${phrase} keeper`, { ratio: 0.9 });
      await db.query(`UPDATE semantic_nodes SET collapsed_into_id = $2 WHERE id = $1`, [id, keeper]);
    }
    return id;
  }

  /** The analysis that judged the nodes: `analyseNodes` sets coverage_ratio; `extractSemanticNodes` clears it. Nine sources = not a thin corpus. */
  async function analysed(cluster: string | null = clusterId, sources = 9): Promise<void> {
    await db.query(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, coverage_ratio, centroid_source_count)
       VALUES ($1,$2,'https://acme.com/p',$3,'{gemini}','m',0.5,$4)`,
      [workspaceId, projectId, cluster, sources],
    );
  }

  /** The displacement: the rival takes the slot citing `cited` (default: the nodes' default evidence page). */
  async function lossWithConcepts(cited: string[] = ["https://rival.com/p"]): Promise<void> {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    for (const [i, url] of cited.entries()) await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url, slot: i + 1 });
    await run(D2);
  }
  const conceptGap = async () => conceptGapSchema.parse((await events())[0]!.concept_gap);

  it("STORY-057 #6 · a concept above the prevalence threshold and absent from the page is stored with its prevalence and evidence URL", async () => {
    await inCluster(clusterId);
    await node("role based access", { ratio: 0.6, evidence: "https://rival.com/rbac", rank: 1 });
    await analysed();
    await lossWithConcepts(["https://rival.com/rbac"]);
    expect(await conceptGap()).toEqual([{ concept: "role based access", prevalence: 0.6, evidence_url: "https://rival.com/rbac" }]);
  });

  it("STORY-057 #7 · a concept below the threshold is not included, and 0.30 exactly is", async () => {
    await inCluster(clusterId);
    await node("below the line", { ratio: 0.29 });
    await node("on the line", { ratio: 0.3 });
    await analysed();
    await lossWithConcepts();
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["on the line"]);
  });

  it("STORY-057 #8 · a concept with no usable evidence is dropped, not stored with a caveat", async () => {
    await inCluster(clusterId);
    await node("no evidence at all", { evidence: "" });
    await node("evidence is not a url", { evidence: "see the docs" });
    await node("evidenced", { evidence: "https://rival.com/ok" });
    await analysed();
    await lossWithConcepts(["https://rival.com/ok"]);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["evidenced"]);
  });

  it("STORY-057 · a concept the page already holds, or a collapsed near-duplicate, is not a gap", async () => {
    await inCluster(clusterId);
    await node("already there", { present: true });
    await node("collapsed copy", { collapsed: true });
    await analysed();
    await lossWithConcepts(["https://rival.com/p"]);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["collapsed copy keeper"]);
  });

  it("STORY-057 · nodes no analysis has judged are not 'absent': present_in_content defaults to false, so unjudged means no claim", async () => {
    await inCluster(clusterId);
    await node("never judged", {});
    await lossWithConcepts();
    expect(await conceptGap()).toEqual([]);
  });

  it("STORY-057 review 1 · a re-extraction un-judges the nodes, and a later touch of an alignment's updated_at does not make them judged again", async () => {
    await inCluster(clusterId);
    await node("page already has this", {});
    await analysed();
    // Re-extraction: nodes reset to absent with a fresh computed_at, and every alignment's coverage_ratio cleared.
    await db.query(`UPDATE semantic_nodes SET present_in_content = false, computed_at = now() WHERE project_id = $1`, [projectId]);
    await db.query(`UPDATE geo_alignments SET coverage_ratio = NULL WHERE project_id = $1`, [projectId]);
    // A centroid / alignment recompute touches the row without re-judging presence.
    await db.query(`UPDATE geo_alignments SET centroid_source_count = centroid_source_count WHERE project_id = $1`, [projectId]);
    await lossWithConcepts();
    expect(await conceptGap()).toEqual([]);
  });

  it("review r2 (STORY-192) · a finished alignment keeps its coverage when a later session opens, so a PENDING alignment of the scope un-judges the nodes: no gap is claimed from nodes the extraction reset", async () => {
    await inCluster(clusterId);
    await node("page already has this", {});
    await analysed();
    // The second session's extraction reset the nodes to absent but did not touch the FINISHED alignment's coverage_ratio; its own row is still pending.
    await db.query(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, analysis_state)
       VALUES ($1,$2,'https://acme.com/other',$3,'{gemini}','m','pending')`,
      [workspaceId, projectId, clusterId],
    );
    await lossWithConcepts();
    expect(await conceptGap()).toEqual([]);
  });

  it("STORY-057 review 2 · the concept read waits out an in-flight extraction of the scope: a commit between the judged check and the node read cannot leave a stale diagnosis", async () => {
    await inCluster(clusterId);
    await node("page already has this", {});
    await analysed();
    // An extraction is in flight: it holds the scope lock and has cleared the judgement, but has not committed.
    const extractor = new Client({ connectionString: container.getConnectionUri() });
    await extractor.connect();
    try {
      await extractor.query("BEGIN");
      await lockNodeScope(extractor, projectId, clusterId);
      await extractor.query(`UPDATE geo_alignments SET coverage_ratio = NULL, recommendations = '[]'::jsonb, updated_at = now() WHERE project_id = $1`, [projectId]);
      await extractor.query(`UPDATE semantic_nodes SET present_in_content = false, priority_rank = NULL, computed_at = now() WHERE project_id = $1`, [projectId]);
      const refreshing = (async () => {
        await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
        const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
        await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/p", slot: 1 });
        await run(D2);
        return true;
      })();
      const settledEarly = await Promise.race([refreshing, new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
      // The refresh must be waiting on the scope, not reading around the writer's uncommitted state.
      expect(settledEarly).toBe(false);
      await extractor.query("COMMIT");
      await refreshing;
    } finally {
      await extractor.query("ROLLBACK").catch(() => undefined);
      await extractor.end();
    }
    expect(await conceptGap()).toEqual([]);
  });

  it("STORY-057 review 3 · HAZARD: the refresh takes its shared scope locks up front in hash order, so an embed batch locking two scopes in that order cannot deadlock with it (no 40P01)", async () => {
    // Two clusters, ordered by the hash of their lock key: `lo` sorts before `hi`.
    const [a, b] = [randomUUID(), randomUUID()];
    const hashes = await db.query<{ cluster: string; h: string }>(
      `SELECT c AS cluster, hashtextextended($1::text || ':' || c::text, 0)::text AS h FROM unnest($2::text[]) c`,
      [projectId, [a, b]],
    );
    const sorted = [...hashes.rows].sort((x, y) => (BigInt(x.h) < BigInt(y.h) ? -1 : 1));
    const lo = sorted[0]!.cluster;
    const hi = sorted[1]!.cluster;
    const secondPrompt = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, cluster_id)
       VALUES ($1,$2,$3,'q2',sha256('q2'::bytea),'recommendation','decision','active',$4)`,
      [secondPrompt, workspaceId, projectId, lo],
    );
    await inCluster(hi);
    // The first displaced cell (by captured_at) is in `hi`, the second in `lo`: per-cell locking would take S(hi) then S(lo).
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await capture({ at: `${D1}T10:30:00Z`, prompt: secondPrompt, present: true, position: 1 });
    await capture({ at: `${D2}T11:00:00Z`, prompt: secondPrompt, present: false, rival: { position: 1 } });
    // The embed batch's order: X(lo) first, then X(hi).
    const embedder = new Client({ connectionString: container.getConnectionUri() });
    await embedder.connect();
    try {
      await embedder.query("BEGIN");
      await lockNodeScope(embedder, projectId, lo);
      const refreshing = run(D2).then(
        () => undefined,
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 800));
      const embedding = embedder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))", [projectId, hi]).then(
        () => undefined,
        (e: unknown) => e,
      );
      await embedding;
      await embedder.query("COMMIT");
      const refreshError = await refreshing;
      expect(embedder).toBeDefined();
      expect(refreshError, "the refresh finished without a deadlock").toBeUndefined();
    } finally {
      await embedder.query("ROLLBACK").catch(() => undefined);
      await embedder.end();
      await db.query("ROLLBACK").catch(() => undefined);
    }
    expect(await events()).toHaveLength(2);
  }, 30_000);

  it("STORY-057 review 1 · FR-CO-03(d): a node whose evidence URL the displacer did not cite on the after-capture is not in the gap", async () => {
    await inCluster(clusterId);
    await node("covered by the cited source", { evidence: "https://rival.com/cited" });
    await node("covered only by an earlier source", { evidence: "https://rival.com/earlier" });
    await analysed();
    await lossWithConcepts(["https://rival.com/cited"]);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["covered by the cited source"]);
  });

  it("STORY-057 review 1 · a thin corpus (< 8 sources) keeps only priority ranks 1-3, a null rank dropped; a full corpus keeps all", async () => {
    await inCluster(clusterId);
    await node("rank two", { rank: 2 });
    await node("rank four", { rank: 4 });
    await node("no rank", { rank: null });
    await analysed(clusterId, 2);
    await lossWithConcepts();
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["rank two"]);
    await db.query(`TRUNCATE displacement_events`);
    await db.query(`UPDATE geo_alignments SET centroid_source_count = 8 WHERE project_id = $1`, [projectId]);
    await run(D2);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["rank two", "rank four", "no rank"]);
  });

  it("STORY-057 · only the prompt's own cluster counts: another cluster's nodes, and a prompt with no corpus, give an empty gap", async () => {
    await inCluster(clusterId);
    await node("other cluster", { cluster: randomUUID() });
    await analysed();
    await lossWithConcepts();
    expect(await conceptGap()).toEqual([]);
  });

  it("STORY-057 · another project's nodes never leak into the gap", async () => {
    const otherProject = randomUUID();
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'Other',$3,'https://o.com','o.com')`, [otherProject, workspaceId, `p-${otherProject.slice(0, 8)}`]);
    await inCluster(clusterId);
    await node("theirs", { project: otherProject });
    await db.query(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, coverage_ratio) VALUES ($1,$2,'https://o.com/p',$3,'{gemini}','m',0.5)`,
      [workspaceId, otherProject, clusterId],
    );
    await lossWithConcepts();
    expect(await conceptGap()).toEqual([]);
  });

  it("STORY-057 AC10 · the stored gap is stable: a re-run after the corpus changed keeps the diagnosis, and an empty gap is filled once the corpus exists", async () => {
    await inCluster(clusterId);
    await lossWithConcepts();
    expect(await conceptGap()).toEqual([]);
    await node("first", { ratio: 0.5 });
    await analysed();
    await run(D2);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["first"]);
    await node("second", { ratio: 0.9 });
    await analysed();
    await run(D2);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["first"]);
  });

  it("STORY-057 · the concept gap is logged as counts only: kept and dropped, never the phrase or the evidence URL", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(JSON.stringify(m)));
    await inCluster(clusterId);
    await node("secret phrase", { ratio: 0.5, evidence: "https://rival.com/secret-path" });
    await node("weak phrase", { ratio: 0.1 });
    await node("unevidenced phrase", { evidence: "" });
    await analysed();
    await lossWithConcepts();
    spy.mockRestore();
    const line = lines.find((l) => l.includes("nominara_displacement_concept_gap_entries_total"));
    expect(line).toBeDefined();
    const all = lines.join("\n");
    expect(all).toContain("dropped_below_threshold");
    expect(all).toContain("dropped_no_evidence");
    expect(all).not.toContain("secret phrase");
    expect(all).not.toContain("secret-path");
  });

  // ---- STORY-057 AC3: the citation gap scoped to the passage, from the stored raw capture's structured_elements ---------------------

  async function engine(key: string, mode: string): Promise<void> {
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1,$1,'v',$2,'1',86400,'medium','free','active') ON CONFLICT (key) DO NOTHING`,
      [key, mode],
    );
  }
  const element = (kind: string, description: string, links: string[]) => ({ kind, description, links: links.map((url) => ({ url })) });

  async function elementLoss(engineKey: string, elements: unknown[] | undefined, cited: string[], rivalLabel = "Rival"): Promise<void> {
    await engine(engineKey, "licensed_serp");
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, engine: engineKey });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 }, engine: engineKey, ...(elements === undefined ? {} : { elements }), rivalLabel });
    for (const [i, url] of cited.entries()) await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url, slot: i + 1, engine: engineKey });
    await run(D2);
  }
  const gapOf = async () => citationGapSchema.parse((await events())[0]!.citation_gap);

  it("STORY-057 #4 / AC3 / 99i · on an engine with per-element references the whole gap is kept and each source is LABELLED: passage, or outside_passage", async () => {
    await elementLoss(
      "google_aio",
      [
        element("ai_overview_element", "Rival is the strongest pick for a small team", ["https://rival.com/pick"]),
        element("ai_overview_element", "Another vendor also cites us", ["https://rival.com/elsewhere"]),
      ],
      ["https://rival.com/pick", "https://rival.com/elsewhere"],
    );
    const gap = await gapOf();
    expect(gap.map((g) => [g.url, g.scope])).toEqual([["https://rival.com/elsewhere", "outside_passage"], ["https://rival.com/pick", "passage"]]);
  });

  it("STORY-057 #5 / AC3 · an engine without per-element references stays answer-scoped, and says so on the entry", async () => {
    await elementLoss("gemini", undefined, ["https://rival.com/pick", "https://rival.com/elsewhere"]);
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/elsewhere", "answer"], ["https://rival.com/pick", "answer"]]);
  });

  it("STORY-057 AC3 · elements exist but none names the competitor: answer-scoped, never guessed", async () => {
    await elementLoss("google_aio", [element("ai_overview_element", "Nobody is named here", ["https://rival.com/pick"])], ["https://rival.com/pick"]);
    expect((await gapOf()).map((g) => g.scope)).toEqual(["answer"]);
  });

  it("STORY-057 AC3 · the passage cites a URL the competitor does not hold (another domain): it never enters the gap", async () => {
    await elementLoss("google_aio", [element("ai_overview_element", "Rival wins", ["https://rival.com/pick", "https://reddit.com/r/x"])], ["https://rival.com/pick"]);
    expect((await gapOf()).map((g) => g.url)).toEqual(["https://rival.com/pick"]);
  });

  it("STORY-057 AC3 · a passage that names the competitor but cites nothing: the whole gap stays, every source outside_passage (the passage WAS located)", async () => {
    await elementLoss("google_aio", [element("ai_overview_element", "Rival wins", []), element("ai_overview_element", "other", ["https://rival.com/pick"])], ["https://rival.com/pick"]);
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/pick", "outside_passage"]]);
  });

  it("STORY-057 AC3 · a malformed stored element is skipped, not a failed rollup; the valid ones still scope the gap", async () => {
    await elementLoss(
      "google_aio",
      [{ kind: "ai_overview_element" }, "junk", element("ai_overview_element", "Rival wins", ["https://rival.com/pick"])],
      ["https://rival.com/pick", "https://rival.com/other"],
    );
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/other", "outside_passage"], ["https://rival.com/pick", "passage"]]);
  });

  it("STORY-057 AC3 · the element link is matched to the stored citation by its raw URL as well as its normalised form", async () => {
    await engine("google_aio", "licensed_serp");
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, engine: "google_aio" });
    const after = await capture({
      at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 }, engine: "google_aio",
      elements: [element("ai_overview_element", "Rival wins", ["https://www.rival.com/pick/?utm_source=x"])],
    });
    // The parser stored the NORMALISED url (www, tracking parameter and trailing slash gone); the element holds the raw one.
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/pick", slot: 1, engine: "google_aio" });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/other", slot: 2, engine: "google_aio" });
    await run(D2);
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/other", "outside_passage"], ["https://rival.com/pick", "passage"]]);
  });

  it("STORY-057 AC3 review · the passage is found with the parser's matcher: 'HP' is not inside 'shape', and 'Box' is not inside 'inbox'", async () => {
    await db.query(`UPDATE competitors SET name = 'HP' WHERE id = $1`, [rivalId]);
    await elementLoss(
      "google_aio",
      [element("ai_overview_element", "A good shape for your inbox", ["https://rival.com/wrong"]), element("ai_overview_element", "HP laptops lead", ["https://rival.com/right"])],
      ["https://rival.com/wrong", "https://rival.com/right"],
      "HP",
    );
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/right", "passage"], ["https://rival.com/wrong", "outside_passage"]]);
  });

  it("STORY-057 AC3 review · only a lookalike substring in the text: no passage is located, so the gap stays answer-scoped", async () => {
    await db.query(`UPDATE competitors SET name = 'HP' WHERE id = $1`, [rivalId]);
    await elementLoss("google_aio", [element("ai_overview_element", "A good shape", ["https://rival.com/wrong"])], ["https://rival.com/wrong"], "HP");
    expect((await gapOf()).map((g) => g.scope)).toEqual(["answer"]);
  });

  it("STORY-057 AC3 review · a label that is a prefix of another rival's name: 'Zoho CRM' belongs to the longer rival, not to 'Zoho'", async () => {
    await db.query(`UPDATE competitors SET name = 'Zoho' WHERE id = $1`, [rivalId]);
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source) VALUES ($1,$2,$3,'Zoho CRM','zohocrm.com',ARRAY[]::text[],'user')`,
      [randomUUID(), workspaceId, projectId],
    );
    await elementLoss(
      "google_aio",
      [element("ai_overview_element", "Zoho CRM is great", ["https://rival.com/crm"]), element("ai_overview_element", "Zoho itself is cheap", ["https://rival.com/zoho"])],
      ["https://rival.com/crm", "https://rival.com/zoho"],
      "Zoho",
    );
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/crm", "outside_passage"], ["https://rival.com/zoho", "passage"]]);
  });

  it("STORY-057 AC3 review · an alias of the competitor names the passage", async () => {
    await db.query(`UPDATE competitors SET aliases = ARRAY['RVL'] WHERE id = $1`, [rivalId]);
    await elementLoss("google_aio", [element("ai_overview_element", "RVL is the pick", ["https://rival.com/alias"]), element("ai_overview_element", "other", ["https://rival.com/x"])], ["https://rival.com/alias", "https://rival.com/x"]);
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/alias", "passage"], ["https://rival.com/x", "outside_passage"]]);
  });

  it("STORY-057 AC3 review · a negative alias suppresses the match, as it does in the parser", async () => {
    await db.query(`UPDATE projects SET negative_aliases = ARRAY['rival territory'] WHERE id = $1`, [projectId]);
    await elementLoss("google_aio", [element("ai_overview_element", "Deep in rival territory", ["https://rival.com/x"])], ["https://rival.com/x"]);
    expect((await gapOf()).map((g) => g.scope)).toEqual(["answer"]);
  });

  it("STORY-057 AC3 · SerpApi fixture (recorded AI Mode answer): every citation of the answer stays in the gap, and the ones in the passage naming the competitor are labelled passage", async () => {
    // The recorded answer through the SerpApi mapper, stored the way the adapter stores an element (kind, links, description).
    const elements: { kind: string; description: string; links: { url: string }[] }[] = mapSerpAnswer(aiModePriced as never).elements.map((e) => ({
      kind: e.kind === "table" ? "table_element" : e.kind === "product" ? "shopping_element" : "ai_overview_element",
      description: e.kind === "product" ? (e.product?.title ?? e.text) : e.text,
      links: e.links.map((l) => ({ url: l.url })),
    }));
    const linksOf = (label: string) => elements.filter((e) => e.description?.includes(label) === true).flatMap((e) => e.links.map((l) => l.url));
    const everyUrl = [...new Set(elements.flatMap((e) => e.links.map((l) => l.url)))];
    const soundcore = [...new Set(linksOf("Soundcore Life Q30"))];
    expect(soundcore.length).toBeGreaterThan(0);
    expect(everyUrl.length).toBeGreaterThan(soundcore.length); // the answer cites more than this passage does

    await db.query(`UPDATE competitors SET root_domain = 'google.com', name = 'Soundcore Life Q30' WHERE id = $1`, [rivalId]);
    await engine("google_ai_mode", "licensed_serp");
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, engine: "google_ai_mode" });
    const after = await capture({
      at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 }, engine: "google_ai_mode", elements, rivalLabel: "Soundcore Life Q30",
    });
    for (const [i, url] of everyUrl.entries()) await cite(after, `${D2}T10:00:00Z`, { domain: "google.com", url, slot: i + 1, engine: "google_ai_mode" });
    await run(D2);
    const gap = await gapOf();
    expect(gap.map((g) => g.url).sort()).toEqual([...everyUrl].sort());
    expect(gap.filter((g) => g.scope === "passage").map((g) => g.url).sort()).toEqual([...soundcore].sort());
    expect(gap.filter((g) => g.scope === "outside_passage").length).toBe(everyUrl.length - soundcore.length);
  });

  it("STORY-057 AC3 · observability: a counter per scope outcome, counts only", async () => {
    const lines: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(m));
    await elementLoss("google_aio", [element("ai_overview_element", "Rival wins", ["https://rival.com/pick"])], ["https://rival.com/pick"]);
    spy.mockRestore();
    const line = lines.find((l) => typeof l === "object" && l !== null && (l as { event?: string }).event === "displacements_refreshed") as Record<string, unknown>;
    expect(line.passage_scoped_gaps).toBe(1);
    expect(line.outside_passage_gaps).toBe(0);
    expect(line.answer_scoped_gaps).toBe(0);
    expect(JSON.stringify(line)).not.toMatch(/rival\.com|Rival/);
  });

  it("STORY-057 AC3 review · an element with links but no text is unlocatable: what it cites is answer-scoped, not silently outside the passage", async () => {
    await elementLoss(
      "google_aio",
      [element("ai_overview_element", "Rival wins", ["https://rival.com/pick"]), { kind: "ai_overview_element", links: [{ url: "https://rival.com/unknown" }] }, element("ai_overview_element", "other", ["https://rival.com/x"])],
      ["https://rival.com/pick", "https://rival.com/unknown", "https://rival.com/x"],
    );
    expect((await gapOf()).map((g) => [g.url, g.scope])).toEqual([["https://rival.com/pick", "passage"], ["https://rival.com/unknown", "answer"], ["https://rival.com/x", "outside_passage"]]);
  });

  it("STORY-057 AC3 review · LABEL DRIFT: a competitor renamed since the capture was parsed is not found by the matcher, so the gap falls back to answer scope", async () => {
    await engine("google_aio", "licensed_serp");
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, engine: "google_aio" });
    const after = await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 }, engine: "google_aio", rivalLabel: "Old Name", elements: [element("ai_overview_element", "Old Name wins", ["https://rival.com/pick"])] });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/pick", slot: 1, engine: "google_aio" });
    await run(D2);
    expect((await gapOf()).map((g) => g.scope)).toEqual(["answer"]); // the competitor is now named "Rival": "Old Name" matches nothing
  });

  it("STORY-057 AC3 review · a capture with no structured elements never loads the parse context (the matcher is lazy)", async () => {
    parseContextSpy.calls = 0;
    await elementLoss("gemini", undefined, ["https://rival.com/pick"]);
    expect(parseContextSpy.calls).toBe(0);
    parseContextSpy.calls = 0;
    await db.query("TRUNCATE displacement_events");
    await db.query(`UPDATE answer_captures SET payload = jsonb_set(payload, '{structured_elements}', '[{"kind":"ai_overview_element","description":"Rival","links":[]}]'::jsonb)`);
    await run(D2);
    expect(parseContextSpy.calls).toBe(1); // loaded once for the refresh, however many events
  });

  it("decision 99i · the passage view is DISPLAY ONLY: an AIO event whose rival holds 5 sources across the answer but whose passage cites 1 has the SAME impact_score and citation count as without elements (scoring v1, as on b570603e)", async () => {
    const urls = [1, 2, 3, 4, 5].map((i) => `https://rival.com/s${i}`);
    await elementLoss("google_aio", [element("ai_overview_element", "Rival wins", [urls[0]!]), element("ai_overview_element", "other", urls.slice(1))], urls);
    const withElements = (await events())[0]!;
    expect(citationGapSchema.parse(withElements.citation_gap)).toHaveLength(5); // the whole-answer gap, not the passage's 1
    expect(citationGapSchema.parse(withElements.citation_gap).filter((g) => g.scope === "passage")).toHaveLength(1);
    await db.query("TRUNCATE displacement_events");
    await db.query(`UPDATE answer_captures SET payload = payload - 'structured_elements'`);
    await run(D2);
    const without = (await events())[0]!;
    expect(withElements.impact_score).toBe(without.impact_score);
    expect(citationGapSchema.parse(without.citation_gap)).toHaveLength(5);
    expect((await db.query<{ v: string }>(`SELECT scoring_version AS v FROM displacement_events`)).rows[0]!.v).toBe("v1");
  });

  it("decision 99i · concept_gap is derived from the WHOLE-answer gap: a concept evidenced by a source cited outside the passage is kept", async () => {
    await inCluster(clusterId);
    await node("role based access", { ratio: 0.6, evidence: "https://rival.com/rbac", rank: 1 });
    await analysed();
    await engine("google_aio", "licensed_serp");
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1, engine: "google_aio" });
    const after = await capture({
      at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 }, engine: "google_aio",
      elements: [element("ai_overview_element", "Rival wins", ["https://rival.com/pick"]), element("ai_overview_element", "other", ["https://rival.com/rbac"])],
    });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/pick", slot: 1, engine: "google_aio" });
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/rbac", slot: 2, engine: "google_aio" });
    await run(D2);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["role based access"]);
  });

  it("decision 99i · a re-rollup of an existing event keeps concept_gap evidence consistent with the citation gap it is derived from", async () => {
    await inCluster(clusterId);
    await node("role based access", { ratio: 0.6, evidence: "https://rival.com/rbac", rank: 1 });
    await analysed();
    await lossWithConcepts(["https://rival.com/rbac"]);
    expect((await conceptGap()).map((c) => c.evidence_url)).toEqual(["https://rival.com/rbac"]);
    // The after-capture's citations change (a re-parse): the evidence source is no longer cited.
    await db.query(`DELETE FROM citation_facts WHERE normalized_url = 'https://rival.com/rbac'`);
    const after = (await db.query<{ id: string }>(`SELECT id FROM answer_captures WHERE project_id = $1 ORDER BY captured_at DESC LIMIT 1`, [projectId])).rows[0]!.id;
    await cite(after, `${D2}T10:00:00Z`, { domain: "rival.com", url: "https://rival.com/new", slot: 5 });
    await run(D2);
    const gapUrls = new Set(citationGapSchema.parse((await events())[0]!.citation_gap).map((g) => g.url));
    expect(gapUrls.has("https://rival.com/new")).toBe(true);
    for (const c of await conceptGap()) expect(gapUrls.has(c.evidence_url)).toBe(true);
  });

  // ---- decision 99f: a draft alignment does not count as judged ----------------------------------------------------------------------

  async function alignment(over: { draft_state?: string | null; coverage?: number | null; updated?: string; target?: string }): Promise<void> {
    await db.query(
      `INSERT INTO geo_alignments (workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, coverage_ratio, centroid_source_count, draft_state, updated_at)
       VALUES ($1,$2,$3,$4,'{gemini}','m',$5,9,$6,$7::timestamptz)`,
      [workspaceId, projectId, over.target ?? "https://acme.com/p", clusterId, over.coverage === undefined ? 0.5 : over.coverage, over.draft_state ?? null, over.updated ?? "2026-10-01T00:00:00Z"],
    );
  }

  it("decision 99f · an alignment whose coverage came from an unsaved draft does not count as judged: no concept gap is claimed from draft presence", async () => {
    await inCluster(clusterId);
    await node("role based access", { ratio: 0.6, evidence: "https://rival.com/rbac", rank: 1 });
    await alignment({ draft_state: "ready" });
    await lossWithConcepts(["https://rival.com/rbac"]);
    expect(await conceptGap()).toEqual([]);
  });

  it("decision 99f · a live-judged alignment made stale by a LATER draft analysis of the scope is not judged either (the shared nodes carry the draft's presence)", async () => {
    await inCluster(clusterId);
    await node("role based access", { ratio: 0.6, evidence: "https://rival.com/rbac", rank: 1 });
    await alignment({ updated: "2026-10-01T00:00:00Z" });
    await alignment({ draft_state: "ready", updated: "2026-10-02T00:00:00Z", target: "https://acme.com/other" });
    await lossWithConcepts(["https://rival.com/rbac"]);
    expect(await conceptGap()).toEqual([]);
  });

  it("decision 99f · draft -> live re-analysis -> judged: the draft keeps the gap out, and the live analysis (which clears the session's draft marker and touches it) lets it be claimed", async () => {
    await inCluster(clusterId);
    await node("role based access", { ratio: 0.6, evidence: "https://rival.com/rbac", rank: 1 });
    await alignment({ draft_state: "ready" });
    await lossWithConcepts(["https://rival.com/rbac"]);
    expect(await conceptGap()).toEqual([]);
    await db.query(`UPDATE geo_alignments SET draft_state = NULL, updated_at = now() WHERE project_id = $1`, [projectId]);
    await db.query(`UPDATE displacement_events SET concept_gap = '[]'::jsonb`);
    await run(D2);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["role based access"]);
  });

  it("decision 99f · a live analysis AFTER the draft re-judges the nodes on the page: judged again, and the gap is claimed", async () => {
    await inCluster(clusterId);
    await node("role based access", { ratio: 0.6, evidence: "https://rival.com/rbac", rank: 1 });
    await alignment({ draft_state: "ready", updated: "2026-10-01T00:00:00Z" });
    await alignment({ updated: "2026-10-02T00:00:00Z", target: "https://acme.com/other" });
    await lossWithConcepts(["https://rival.com/rbac"]);
    expect((await conceptGap()).map((c) => c.concept)).toEqual(["role based access"]);
  });

  it("the rollup handler persists displacements for the date it rolls up", async () => {
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    const handler = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext);
    const job = { data: { payload: { workspaceId, kid: "k", projectId, metricDate: D2 } } } as unknown as Job;
    await asTenantJob(db, workspaceId, () => handler(db, job));
    await asTenantJob(db, workspaceId, () => handler(db, job));
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

  it("STORY-056 #12 · a backfill (demo seed) pass emits no outcome-ok lag line, so its days-old events cannot skew the SLO p95", async () => {
    const lines: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(m));
    await capture({ at: `${D1}T10:00:00Z`, present: true, position: 1 });
    await capture({ at: `${D2}T10:00:00Z`, present: false, rival: { position: 1 } });
    await db.query("BEGIN");
    await backfillProjectDisplacements(db, projectId, "UTC", D1, D3);
    await db.query("COMMIT");
    spy.mockRestore();
    expect(lines.filter((l) => typeof l === "object" && l !== null && (l as { metric?: string }).metric === LAG_METRIC)).toHaveLength(0);
    expect(await events()).toHaveLength(1);
  });
});
