import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { GEO_FRESHNESS_OBJECTIVE_SECONDS, GEO_WINDOWS, observeGeoFreshness, refreshProjectGeoWindows } from "../../src/lib/rollup/refresh-project-geo.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-062 AC12 / scenario 11 — recomputation is scheduled per project and per
// window, and the freshness objective (edge-cases-and-slos #28: daily, p95 <= 30
// min per project, measured on `geo_analyses.computed_at`) is met.
//
// WHAT THIS PROVES, PLAINLY: (1) `computed_at` is the moment a row was WRITTEN (clock_timestamp), not the transaction start, so a
// slow recompute shows up on it; (2) `observeGeoFreshness`, which the rollup handler calls after COMMIT with the job's enqueue
// time, measures trigger-to-visible and breaches when a run is slower than the objective; (3) the compute step's own duration is a
// separate metric (`nominara_geo_recompute_duration_seconds`). It does NOT prove the production p95; that is observed on
// `nominara_geo_recompute_freshness_seconds`. The handler wiring is proven in rollup-sweeps.spec.ts.

const AS_OF = new Date("2026-10-01T12:00:00Z");
const IN_WINDOW = "2026-09-20T10:00:00Z";
const TEXT = "Acme is clunky and the pricing is steep [thread](https://reddit.com/r/crm/1) today.";
const SECRET_WORKSPACE_NAME = "SECRET-WORKSPACE-NAME";

describe("STORY-062 AC12 · GEO recompute freshness", () => {
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
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function mention(label: "positive" | "negative"): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
       VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00',$7::jsonb,'parsed')`,
      [id, workspaceId, projectId, randomUUID(), randomUUID(), IN_WINDOW, JSON.stringify({ format: "markdown", text: TEXT })],
    );
    await db.query(
      `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
         occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,
         evidence_start,evidence_end,negative_reasons,position_class)
       VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Acme','Acme',0,0,4,0,0.5,$6,0,0.5,'lexicon',0,41,$7::text[],'neutral_list')`,
      [workspaceId, projectId, id, randomUUID(), IN_WINDOW, label, label === "negative" ? ["complaint_thread_cited"] : []],
    );
  }

  beforeEach(async () => {
    await db.query("TRUNCATE geo_analyses, mention_facts, answer_captures, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,$2,$3,'growth','UTC')", [
      workspaceId,
      SECRET_WORKSPACE_NAME,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://acme.com','acme.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    for (let i = 0; i < 30; i++) await mention("positive");
    for (let i = 0; i < 2; i++) await mention("negative");
  });

  const refresh = () =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => refreshProjectGeoWindows(tx, projectId, { asOf: AS_OF }));

  it("[F1] the objective is the reference's 30 minutes and every served window is scheduled", () => {
    expect(GEO_FRESHNESS_OBJECTIVE_SECONDS).toBe(30 * 60);
    expect([...GEO_WINDOWS]).toEqual([7, 30, 90]);
  });

  it("[F2] scenario 11 · computed_at is the write time: a recompute that takes N seconds stamps rows N seconds after the trigger, inside the objective", async () => {
    const trigger = (await db.query<{ t: Date }>("SELECT clock_timestamp() AS t")).rows[0]!.t;
    await withTenantContext(db, { workspaceId, actorId: randomUUID() }, async (tx) => {
      await tx.query("SELECT pg_sleep(1.2)"); // queue wait / earlier rollup steps: transaction start is now 1.2 s in the past
      await refreshProjectGeoWindows(tx, projectId, { asOf: AS_OF });
    });
    const rows = (await db.query<{ analysis: string; window_days: number; computed_at: Date }>("SELECT analysis, window_days, computed_at FROM geo_analyses")).rows;
    expect(rows).toHaveLength(15); // structure + entity + sentiment + divergence + topics (STORY-061), three windows
    expect(new Set(rows.map((r) => r.window_days))).toEqual(new Set([7, 30, 90]));
    for (const r of rows) {
      const lagSeconds = (r.computed_at.getTime() - trigger.getTime()) / 1000;
      expect(lagSeconds).toBeGreaterThanOrEqual(1.2); // fails when computed_at = now() (transaction start)
      expect(lagSeconds).toBeLessThanOrEqual(GEO_FRESHNESS_OBJECTIVE_SECONDS);
    }
  });

  it("[F2b] scenario 11 · freshness is trigger-to-visible: a run that waited past the objective breaches it, exactly 30 minutes does not", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    const spy = vi.spyOn(Logger.prototype, "log");
    try {
      expect(observeGeoFreshness(workspaceId, projectId, now - 31 * 60_000, now)).toBe(31 * 60);
      expect(observeGeoFreshness(workspaceId, projectId, now - 30 * 60_000, now)).toBe(30 * 60);
      expect(observeGeoFreshness(workspaceId, projectId, now - 60_000, now)).toBe(60);
      const lines = spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((l) => l.metric === "nominara_geo_recompute_freshness_seconds");
      expect(lines.map((l) => l.within_objective)).toEqual(["false", "true", "true"]);
      expect(lines[0]!.workspace_id).toBe(workspaceId);
      // project_id is a per-project cardinality bomb as a metric label: it rides a separate event line instead.
      expect(lines.every((l) => !("project_id" in l))).toBe(true);
      const events = spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((l) => l.event === "geo.freshness");
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ workspace_id: workspaceId, project_id: projectId, lag_seconds: 31 * 60 });
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_WORKSPACE_NAME);
    } finally {
      spy.mockRestore();
    }
  });

  it("[F3] a recompute refreshes computed_at rather than leaving the stale row, and still holds one row per window", async () => {
    await refresh();
    const first = (await db.query<{ computed_at: Date }>("SELECT max(computed_at) AS computed_at FROM geo_analyses")).rows[0]!.computed_at;
    await refresh();
    const second = (await db.query<{ computed_at: Date }>("SELECT min(computed_at) AS computed_at FROM geo_analyses")).rows[0]!.computed_at;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(Number((await db.query("SELECT count(*) FROM geo_analyses")).rows[0].count)).toBe(15); // structure + entity + sentiment + divergence + topics (STORY-061), three windows
  });

  it("[F4] observability · a geo.refresh span, the compute-duration measure and a log line with the project ID, never the workspace's name or answer text", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    const spy = vi.spyOn(Logger.prototype, "log");
    try {
      await refresh();
      const lines = spy.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const measure = lines.find((l) => l.metric === "nominara_geo_recompute_duration_seconds");
      expect(measure).toBeDefined();
      expect("project_id" in measure!, "project_id is not a metric label").toBe(false);
      expect(lines.find((l) => l.event === "geo.recompute")).toMatchObject({ project_id: projectId, workspace_id: workspaceId, windows: 3 });
      expect(measure!.workspace_id).toBe(workspaceId);
      expect(lines.find((l) => l.metric === "nominara_geo_recompute_freshness_seconds")).toBeUndefined(); // compute time is not freshness
      expect(measure!.value).toBeGreaterThanOrEqual(0);
      expect(measure!.windows).toBe(3);
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).not.toContain(SECRET_WORKSPACE_NAME);
      expect(logged).not.toContain("clunky");
    } finally {
      spy.mockRestore();
    }
    const span = exporter.getFinishedSpans().find((s) => s.name === "geo.refresh");
    expect(span).toBeDefined();
    expect(span!.attributes["nominara.geo_refresh.windows"]).toBe(3);
  });
});
