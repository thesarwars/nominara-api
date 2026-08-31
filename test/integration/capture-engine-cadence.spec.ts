import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job, Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { CADENCE_JITTER_MAX_MS } from "../../src/lib/capture/dispatch-cells.js";
import { CYCLE_DAYS, resolveDueEngines } from "../../src/lib/capture/engine-cadence.js";
import { FAIR_USE_METRIC } from "../../src/lib/capture/fair-use.js";
import {
  claimDueProjects,
  dispatchScheduledRun,
  nextRunAfter,
  planScheduledRun,
  type ScheduleContext,
} from "../../src/lib/capture/scheduler.js";

// STORY-033 AC4, AC5, AC6, AC9 — per-engine due-ness and the seam that
// carries it into a run.
//
// The AC4 tests all take the same shape on purpose: TWO engines on ONE
// project, with different cadences and different coverage histories, so that
// a "resolve one due-ness and apply it to every engine" implementation — the
// most likely wrong one — fails. A single-engine test cannot distinguish it.
const CYCLE_MS = CYCLE_DAYS * 24 * 60 * 60 * 1000;
const PERIOD = "2026-08-01";
const NOW = new Date("2026-08-20T12:00:00.000Z");

describe("STORY-033 · per-engine cadence, and the run that records it", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let cache: InMemoryCacheAdapter;
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

  beforeEach(async () => {
    await db.query("TRUNCATE workspaces, engines, usage_counters CASCADE");
    cache = new InMemoryCacheAdapter();
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain,
                             cadence, priority_prompt_limit, next_run_at, locale)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 'weekly', 10, $4, 'en-US')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`, new Date(NOW.getTime() - 60_000)],
    );
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value)
       VALUES ($1, $2, $3, 100000)`,
      [workspaceId, FAIR_USE_METRIC, PERIOD],
    );
  });

  /** `cadence` is the raw `cadence_by_plan` value — the test states it exactly as the column holds it. */
  async function addEngine(
    key: string,
    cadence: Record<string, Record<string, number>>,
    options: { enabled?: boolean; minPlan?: string; status?: string } = {},
  ): Promise<void> {
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status, cadence_by_plan)
       VALUES ($1, $1, 'v', 'api', '1.0.0', 3600, 'medium', $2, $3, $4::jsonb)`,
      [key, options.minPlan ?? "free", options.status ?? "active", JSON.stringify(cadence)],
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, $3, $4, 1)`,
      [workspaceId, projectId, key, options.enabled ?? true],
    );
  }

  /** A completed run covering `engines`, `agoMs` before NOW. */
  async function addRun(engines: string[], agoMs: number, status = "completed"): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status, created_at)
       VALUES ($1, $2, $3, 'scheduled', $4::text[], $5, $6)`,
      [id, workspaceId, projectId, engines, status, new Date(NOW.getTime() - agoMs)],
    );
    return id;
  }

  async function addPrompt(text: string, priority = false): Promise<void> {
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                    intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', $6, 'active')`,
      [randomUUID(), workspaceId, projectId, text, Buffer.from(text, "utf8"), priority],
    );
  }

  const scheduleContext: ScheduleContext = {
    periodStart: PERIOD,
    normalizerVersion: "v1",
    captureMode: "api",
    env: "test",
    sharedCacheEnabled: true,
  };

  async function dueKeys(kind: "full" | "priority" = "full", now = NOW): Promise<string[]> {
    const due = await resolveDueEngines(db, { projectId, kind, now });
    return due.map((engine) => engine.engineKey);
  }

  // ── AC4 ────────────────────────────────────────────────────────────────

  it("an engine never covered is due, whatever its cadence", async () => {
    await addEngine("perplexity", { growth: { full: 4 } });
    expect(
      await dueKeys(),
      "a newly enabled engine must not wait a full interval, or a project's first run covers nothing",
    ).toEqual(["perplexity"]);
  }, 30_000);

  // THE AC4 TEST. Two engines, two cadences, one project, one moment.
  it("resolves due-ness INDEPENDENTLY per engine", async () => {
    // 26/cycle -> due every ~1.15 days. 4/cycle -> due every 7.5 days.
    await addEngine("perplexity", { growth: { full: 26 } });
    await addEngine("claude", { growth: { full: 4 } });
    // Both covered two days ago: the fast engine is due again, the slow one is not.
    await addRun(["perplexity", "claude"], 2 * 24 * 60 * 60 * 1000);

    expect(
      await dueKeys(),
      "a single project's run covers the engines that are due and not the ones that are not",
    ).toEqual(["perplexity"]);
  }, 30_000);

  it("an engine covered inside its own interval is not due; past it, it is", async () => {
    await addEngine("claude", { growth: { full: 4 } });
    const interval = CYCLE_MS / 4;

    await addRun(["claude"], interval * 0.9);
    expect(await dueKeys(), "inside the interval").toEqual([]);

    await addRun(["claude"], interval * 1.1);
    // The LATEST coverage still sits inside the interval, so the older run
    // past it must not make the engine due — max(), not any().
    expect(await dueKeys(), "the most recent coverage decides, not the oldest").toEqual([]);
  }, 30_000);

  it("fails closed: an engine with no cadence entry for this plan is never due", async () => {
    await addEngine("perplexity", { growth: { full: 4 } });
    await addEngine("claude", { starter: { full: 4 } }); // no `growth` key
    expect(
      await dueKeys(),
      "no cadence for the plan means the plan does not schedule this engine — never a default",
    ).toEqual(["perplexity"]);
  }, 30_000);

  it("fails closed: a cadence of zero is not due, and does not divide by zero", async () => {
    await addEngine("claude", { growth: { full: 0 } });
    expect(await dueKeys()).toEqual([]);
  }, 30_000);

  it("the kind selects the cadence: an engine with no priority cadence is not due for a priority run", async () => {
    await addEngine("perplexity", { growth: { full: 4, priority: 26 } });
    await addEngine("claude", { growth: { full: 4 } });
    expect(await dueKeys("full"), "both have a full cadence").toEqual(["claude", "perplexity"]);
    expect(await dueKeys("priority"), "only one has a priority cadence").toEqual(["perplexity"]);
  }, 30_000);

  it("a disabled project engine is never due", async () => {
    await addEngine("perplexity", { growth: { full: 4 } });
    await addEngine("claude", { growth: { full: 4 } }, { enabled: false });
    expect(await dueKeys()).toEqual(["perplexity"]);
  }, 30_000);

  it("an engine above the workspace's plan is never due, however due its cadence says it is", async () => {
    await addEngine("perplexity", { growth: { full: 4 } });
    await addEngine("claude", { growth: { full: 26 } }, { minPlan: "enterprise" });
    expect(
      await dueKeys(),
      "cadence must not be able to schedule an engine the entitlement excludes",
    ).toEqual(["perplexity"]);
  }, 30_000);

  it("a non-active engine is never due", async () => {
    await addEngine("claude", { growth: { full: 4 } }, { status: "beta" });
    expect(await dueKeys()).toEqual([]);
  }, 30_000);

  // A failed run captured nothing. Counting it as coverage would push the
  // next real capture a whole interval away on the strength of work that
  // never happened — the failure mode is silent staleness.
  it.each([["failed"], ["canceled"]])("a %s run does not count as coverage", async (status) => {
    await addEngine("claude", { growth: { full: 4 } });
    await addRun(["claude"], 60_000, status);
    expect(await dueKeys(), `a ${status} run captured nothing`).toEqual(["claude"]);
  }, 30_000);

  it("a run covering a different engine does not make this one covered", async () => {
    await addEngine("perplexity", { growth: { full: 4 } });
    await addEngine("claude", { growth: { full: 4 } });
    await addRun(["perplexity"], 60_000);
    expect(
      await dueKeys(),
      "engine_keys is the record of what a run covered — a run is not coverage of everything enabled",
    ).toEqual(["claude"]);
  }, 30_000);

  // ── The seam: AC5, AC6, AC9 ────────────────────────────────────────────

  async function claimAndPlan(options: {
    readonly trigger?: "scheduled" | "verification";
    readonly kind?: "full" | "priority";
    readonly now?: Date;
  } = {}) {
    await db.query("BEGIN");
    try {
      const [project] = await claimDueProjects(db, options.now ?? NOW);
      const scheduled = await planScheduledRun(db, cache, project!, scheduleContext, {
        runId: randomUUID(),
        trigger: options.trigger ?? "scheduled",
        kind: options.kind ?? "full",
        now: options.now ?? NOW,
      });
      await db.query("COMMIT");
      return scheduled;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  it("AC5 — the run row records EXACTLY the engines covered, and not the ones that were not due", async () => {
    await addEngine("perplexity", { growth: { full: 26 } });
    await addEngine("claude", { growth: { full: 4 } });
    await addRun(["perplexity", "claude"], 2 * 24 * 60 * 60 * 1000);
    await addPrompt("what is the best crm");

    const scheduled = await claimAndPlan();

    const row = await db.query<{ engine_keys: string[] }>(
      "SELECT engine_keys FROM capture_runs WHERE id = $1",
      [scheduled!.runId],
    );
    expect(
      row.rows[0]!.engine_keys,
      "a per-engine cadence is reconstructable only if the row records the covered set exactly",
    ).toEqual(["perplexity"]);
    expect(scheduled!.engineKeys, "and what the caller is told must be the same set").toEqual(["perplexity"]);
  }, 30_000);

  it("AC6 — the project's cadence reaches dispatch, so cells are jittered across ITS window", async () => {
    await db.query("UPDATE projects SET cadence = 'daily' WHERE id = $1", [projectId]);
    await addEngine("perplexity", { growth: { full: 26 } });
    await addPrompt("what is the best crm");

    const scheduled = await claimAndPlan();
    expect(scheduled!.plan.cadence, "the plan carries the project's cadence, not a default").toBe("daily");

    const delays: number[] = [];
    const queue = {
      addBulk: (jobs: { opts: { delay: number } }[]) => {
        for (const job of jobs) delays.push(job.opts.delay);
        return Promise.resolve([] as Job[]);
      },
    } as unknown as Queue;
    // The REAL topology entry, not a fixture: capture.execute carries a dual
    // priority, and a hand-made entry would let the scheduler get away with
    // not choosing a lane.
    const entry = QUEUE_TOPOLOGY.find((candidate) => candidate.name === "capture.execute")!;

    await dispatchScheduledRun(queue, entry, scheduled!);

    expect(delays.length, "every live cell is dispatched").toBeGreaterThan(0);
    for (const delay of delays) {
      expect(delay, "within §5's window for THIS cadence").toBeLessThanOrEqual(CADENCE_JITTER_MAX_MS.daily);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    // The bound that matters: `daily` is 0–900 s, and `weekly` — the project's
    // value before the UPDATE above — is 0–3600 s. A scheduler that passed a
    // hardcoded or defaulted cadence would still produce delays "in range" for
    // the wider window, so the narrow one is what the assertion uses.
    expect(CADENCE_JITTER_MAX_MS.daily).toBeLessThan(CADENCE_JITTER_MAX_MS.weekly);
  }, 30_000);

  it("AC9 — a verification run goes through the same path and charges nothing", async () => {
    await addEngine("perplexity", { growth: { full: 26 } });
    await addPrompt("what is the best crm");

    const scheduled = await claimAndPlan({ trigger: "verification" });

    expect(scheduled!.trigger).toBe("verification");
    expect(scheduled!.plan.charge.charged, "platform-initiated re-measurement is never charged").toBe(false);
    expect(
      scheduled!.plan.charge.reason,
      "refused by TRIGGER, not merely because the wallet does not exist yet",
    ).toMatch(/not charged/iu);

    const row = await db.query<{ trigger: string }>("SELECT trigger FROM capture_runs WHERE id = $1", [
      scheduled!.runId,
    ]);
    expect(row.rows[0]!.trigger, "and it is the same run table, not a second path").toBe("verification");
  }, 30_000);

  // ── AC3 still holds through the seam ───────────────────────────────────

  it("advances next_run_at before returning, so a dispatch can never precede it", async () => {
    await addEngine("perplexity", { growth: { full: 26 } });
    await addPrompt("what is the best crm");

    await claimAndPlan();

    const row = await db.query<{ next_run_at: Date }>("SELECT next_run_at FROM projects WHERE id = $1", [
      projectId,
    ]);
    expect(row.rows[0]!.next_run_at.getTime(), "weekly is 4 runs per 30-day cycle — 7.5 days").toBe(
      nextRunAfter("weekly", NOW)!.getTime(),
    );
  }, 30_000);

  // Without this the project is re-claimed every tick for the rest of the
  // interval, occupying a batch slot and starving the projects behind it.
  it("a project with nothing due is still advanced, and writes no run", async () => {
    await addEngine("claude", { growth: { full: 4 } });
    await addRun(["claude"], 60_000);

    const before = await db.query<{ c: string }>("SELECT count(*) c FROM capture_runs WHERE project_id = $1", [
      projectId,
    ]);
    const scheduled = await claimAndPlan();
    const after = await db.query<{ c: string }>("SELECT count(*) c FROM capture_runs WHERE project_id = $1", [
      projectId,
    ]);

    expect(scheduled, "nothing due is not a run").toBeNull();
    expect(after.rows[0]!.c, "and it must not write an empty run row").toBe(before.rows[0]!.c);

    const row = await db.query<{ next_run_at: Date }>("SELECT next_run_at FROM projects WHERE id = $1", [
      projectId,
    ]);
    expect(row.rows[0]!.next_run_at.getTime(), "but it IS rescheduled").toBe(nextRunAfter("weekly", NOW)!.getTime());
  }, 30_000);

  // ── AC10 — a cadence change is pinned so a chart can annotate it ────────

  async function cadenceMilestones(): Promise<{ title: string; detail: string; kind: string }[]> {
    const rows = await db.query<{ title: string; detail: string; kind: string }>(
      "SELECT title, detail, kind FROM milestones WHERE project_id = $1 ORDER BY occurred_at, detail",
      [projectId],
    );
    return rows.rows;
  }

  it("AC10 — changing a project's cadence pins a milestone naming the change", async () => {
    await db.query("UPDATE projects SET cadence = 'daily' WHERE id = $1", [projectId]);

    const pins = await cadenceMilestones();
    expect(pins).toHaveLength(1);
    expect(pins[0]!.kind).toBe("annotation");
    expect(
      pins[0]!.detail,
      "the pin must name BOTH ends — 'cadence changed' cannot explain a trend break on its own",
    ).toBe("weekly to daily");
  }, 30_000);

  // The whole point of the annotation is that a frequency change is not a
  // measurement change. A pin on every unrelated settings save would bury the
  // one that explains something.
  it("writing the same cadence pins nothing", async () => {
    await db.query("UPDATE projects SET cadence = 'weekly' WHERE id = $1", [projectId]);
    expect(await cadenceMilestones()).toHaveLength(0);
  }, 30_000);

  it("an unrelated project edit pins nothing", async () => {
    await db.query("UPDATE projects SET name = 'renamed' WHERE id = $1", [projectId]);
    expect(await cadenceMilestones()).toHaveLength(0);
  }, 30_000);

  // Guards the decision to leave source_id NULL. Pinning the project id there
  // would collide with ux_milestones_source on the second change and turn an
  // annotation into a constraint on the customer's own settings.
  it("a cadence changed twice pins twice, and the second does not collide", async () => {
    await db.query("UPDATE projects SET cadence = 'daily' WHERE id = $1", [projectId]);
    await db.query("UPDATE projects SET cadence = 'hourly' WHERE id = $1", [projectId]);

    const pins = await cadenceMilestones();
    expect(pins.map((pin) => pin.detail).sort()).toEqual(["daily to hourly", "weekly to daily"]);
  }, 30_000);

  it("§5's intervals are derived from runs-per-cycle, not from calendar weeks", () => {
    // 4 runs per 30-day cycle is 7.5 days. A calendar week would give 4.3 runs
    // per cycle and quietly overrun every plan's stated figure.
    expect(nextRunAfter("weekly", NOW)!.getTime() - NOW.getTime()).toBe(CYCLE_MS / 4);
    expect(nextRunAfter("twice_weekly", NOW)!.getTime() - NOW.getTime()).toBe(CYCLE_MS / 8);
    expect(nextRunAfter("daily", NOW)!.getTime() - NOW.getTime()).toBe(CYCLE_MS / 30);
    expect(nextRunAfter("hourly", NOW)!.getTime() - NOW.getTime()).toBe(CYCLE_MS / 720);
    expect(nextRunAfter("manual", NOW), "a manual project is not scheduled at all").toBeNull();
  });
});
