import type { Job } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { growthMapResponseSchema, scorecardsResponseSchema } from "../../contracts/analytics/index.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { RealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { normalGrounded } from "../../src/lib/engines/gemini/fixtures/gemini-recorded.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureExecuteHandler, type ParseJobPayload } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// NEW-A-7 AC4 — a Gemini deep scan changes `scorecards.engines[gemini]` and the growth map's latest
// day WITHOUT the hourly rollup cron.
//
// WHAT IS REAL: the registry's real Gemini adapter (bound because GEMINI_API_KEY is set), the real
// `capture.execute`, `capture.parse` and `rollup.metric_daily` handlers, each run in its own tenant
// transaction as `nominara_app` (RLS in force), and the real ApiModule answering both GETs over HTTP
// with its guards, interceptors and response validation.
//
// WHAT IS NOT: (1) the BullMQ hop between the handlers — each handler's injected `enqueue*` seam
// records the job and this spec runs it next, which is exactly what the queue does; the worker boot
// itself is NEW-A-17. (2) The vendor: global `fetch` answers with the RECORDED generateContent
// response, so no key is spent and nothing leaves the machine. (3) The citation redirect fetch
// (`guardedFetch`), which would resolve DNS: it returns a distinct final host per wrapper URL.
// Nothing here calls the rollup cron or `rollUpDay` directly.

const guarded = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/lib/net/guarded-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/net/guarded-fetch.js")>();
  return {
    ...actual,
    guardedFetch: async (url: string) => {
      guarded.calls += 1;
      const token = url.slice(url.lastIndexOf("/") + 1).replace(/[^a-z0-9]/gu, "");
      return { status: 200, headers: {}, body: Buffer.alloc(0), finalUrl: `https://${token}.example.org/page` };
    },
  };
});

const FAKE_KEY = "e2e-fake-gemini-key-not-a-secret";
const publisher: RealtimePublisher = { toWorkspace: () => undefined, memberChanged: () => undefined };

interface Queued {
  kind: "parse" | "rollup";
  /** The callback that queued it: capture.execute (finalisation) or capture.parse (parse completion). */
  source: "execute" | "parse";
  workspaceId: string;
  payload: Record<string, unknown>;
}

describe("NEW-A-7 AC4 · Gemini capture -> parse -> rollup -> GET /scorecards and /growth-map, no cron", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }),
  });
  let pool: Pool;
  let sessions: SessionService;
  let geminiRequests: number;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });

  beforeEach(() => {
    process.env.GEMINI_API_KEY = FAKE_KEY;
    geminiRequests = 0;
    guarded.calls = 0;
    vi.stubGlobal("fetch", async (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      // Only the vendor generate call is answered (matched by its method, not its host: the STORY-027 scenario 8 scanner bans live engine hostnames in test/**).
      if (!url.includes(":generateContent")) throw new Error(`unexpected network call: ${url}`);
      geminiRequests += 1;
      return new Response(JSON.stringify(normalGrounded), { status: 200, headers: { "content-type": "application/json" } });
    });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
  });

  afterEach(async () => {
    vi.stubGlobal("fetch", originalFetch);
    delete process.env.GEMINI_API_KEY;
    await pool.end();
  });

  const cookieOf = (t: Pick<SessionTokens, "accessToken" | "csrfToken">): string =>
    `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

  interface Scenario {
    workspaceId: string;
    projectId: string;
    promptIds: string[];
    cookie: string;
  }

  async function scenario(prompts = 2): Promise<Scenario> {
    const db = harness.db();
    const userId = uuidV7();
    await db.query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`,
      [userId, `${userId}@example.test`],
    );
    const tokens = await sessions.createSession(userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("business"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);

    const projectId = uuidV7();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'HubSpot','p-e2e','https://hubspot.com','hubspot.com')`,
      [projectId, workspaceId],
    );
    // gemini is in the seeded catalogue (min plan business), so the business workspace is entitled to it.
    const promptIds: string[] = [];
    for (let i = 0; i < prompts; i++) {
      const id = uuidV7();
      promptIds.push(id);
      const text = `best crm for a 50 person startup ${String(i)}`;
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
         VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration',false,'active')`,
        [id, workspaceId, projectId, text, Buffer.from(text, "utf8")],
      );
    }
    return { workspaceId, projectId, promptIds, cookie: cookieOf(entered) };
  }

  const get = (s: Scenario, path: string) =>
    harness.app().inject({ method: "GET", url: apiUrl(`/projects/${s.projectId}/${path}`), headers: { cookie: s.cookie } });

  async function scorecards(s: Scenario) {
    const res = await get(s, "scorecards?timeframe=7d");
    expect(res.statusCode, res.body).toBe(200);
    return scorecardsResponseSchema.parse((res.json() as { data: unknown }).data);
  }
  async function growthMap(s: Scenario) {
    const res = await get(s, "growth-map?timeframe=7d");
    expect(res.statusCode, res.body).toBe(200);
    return growthMapResponseSchema.parse((res.json() as { data: unknown }).data);
  }

  /** Runs one queued job in its own tenant transaction as the runtime role. */
  async function inTenant(workspaceId: string, fn: (tx: import("pg").ClientBase) => Promise<unknown>): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query("SET LOCAL ROLE nominara_app");
        await fn(tx);
      });
    } finally {
      client.release();
    }
  }

  /** A deep scan: one run, one cell per prompt, driven to quiescence with no cron and no direct rollUpDay. */
  async function deepScan(s: Scenario): Promise<{ runId: string; ran: string[]; rollupSources: string[] }> {
    const runId = uuidV7();
    await harness.db().query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells)
       VALUES ($1,$2,$3,'manual',ARRAY['gemini'],$4)`,
      [runId, s.workspaceId, s.projectId, s.promptIds.length],
    );
    const queue: Queued[] = [];
    // VALKEY_CACHE_URL is what the production handler builds its spend meter on (E2E-B6).
    const context = { pool: undefined, env: { VALKEY_CACHE_URL: cacheValkey.url } } as unknown as QueueHandlerContext;
    const execute = createCaptureExecuteHandler(context, {
      cache: new InMemoryCacheAdapter(),
      realtime: publisher,
      enqueueParse: async (p: ParseJobPayload) => {
        queue.push({ kind: "parse", source: "execute", workspaceId: p.workspaceId, payload: { ...p } });
      },
      enqueueRollup: async (_q, workspaceId, payload) => {
        queue.push({ kind: "rollup", source: "execute", workspaceId, payload });
      },
    });
    const parse = createCaptureParseHandler(context, {
      enqueueRollup: async (_q, workspaceId, payload) => {
        queue.push({ kind: "rollup", source: "parse", workspaceId, payload });
      },
    });
    const rollup = createRollupMetricDailyHandler(context, { enqueueVerifyPresence: async () => undefined });
    const asJob = (payload: Record<string, unknown>): Job => ({ data: { payload: { kid: "k", ...payload } } }) as unknown as Job;

    const ran: string[] = [];
    const rollupSources: string[] = [];
    for (const [sampleIndex, promptId] of s.promptIds.entries()) {
      await inTenant(s.workspaceId, (tx) =>
        execute(
          tx,
          asJob({
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            runId,
            promptId,
            promptText: `best crm for a 50 person startup ${String(sampleIndex)}`,
            engineKey: "gemini",
            sampleIndex,
            adapterVersion: "1.0.0",
            ttlSeconds: 3600,
            locale: "en-US",
            personaHint: null,
          }),
        ),
      );
      ran.push("execute");
    }
    // The queue, drained in order. A job enqueued by another job is appended and runs after it.
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      ran.push(next.kind);
      if (next.kind === "rollup") rollupSources.push(next.source);
      const job = asJob({ ...next.payload, workspaceId: next.workspaceId, ...(next.kind === "parse" ? { force: false } : {}) });
      await inTenant(next.workspaceId, (tx) => (next.kind === "parse" ? parse(tx, job) : rollup(tx, job)));
    }
    // Which callback asked for each rollup, in the order they were requested.
    return { runId, ran, rollupSources };
  }

  it("NEW-A-7 AC4 · before the scan Gemini has no measurement; after it, scorecards.engines[gemini] and the growth map's latest day carry the scan", async () => {
    const s = await scenario(2);

    const before = await scorecards(s);
    const beforeGemini = before.engines.find((e) => e.engine_key === "gemini");
    expect(beforeGemini, "an enabled engine appears even with no rows").toBeDefined();
    expect(beforeGemini!.metrics.cells_total).toBe(0);
    expect(beforeGemini!.metrics.presence_rate, "nothing measured is null, not 0").toBeNull();
    expect(beforeGemini!.data_source, "nothing measured has no provenance").toBeNull();
    const growthBefore = await growthMap(s);
    expect(growthBefore.series.every((series) => series.points.every((p) => p.cells === 0))).toBe(true);

    const { ran, rollupSources } = await deepScan(s);

    // The chain really ran: two vendor calls, citations resolved, and one rollup job,
    // requested by the parse completion path and by nothing else.
    expect(geminiRequests).toBe(2);
    expect(guarded.calls).toBeGreaterThan(0);
    expect(ran.filter((k) => k === "rollup")).toHaveLength(1);
    // Finalisation (capture.execute) comes before parsing, so a rollup it requested would run on no facts.
    expect(rollupSources, "the rollup was requested by parse, not by capture.execute").toEqual(["parse"]);

    const after = await scorecards(s);
    const gemini = after.engines.find((e) => e.engine_key === "gemini")!;
    expect(gemini.metrics.cells_total).toBe(2);
    expect(gemini.metrics.presence_rate).not.toBeNull();
    expect(gemini.metrics.mentions_total).toBeGreaterThan(0);
    expect(gemini.metrics.citations_total).toBeGreaterThan(0);
    expect(gemini.data_source).toBe("live");

    const growth = await growthMap(s);
    const brand = growth.series.find((series) => series.entity_type === "brand")!;
    const latest = brand.points.at(-1)!;
    expect(latest.cells).toBe(2);
    expect(latest.visibility_score).not.toBeNull();
    expect(brand.data_source).toBe("live");
    expect(growth.engines?.find((e) => e.engine_key === "gemini")?.data_source).toBe("live");

    // The rollup wrote it: the day's metric_daily rows exist for this project and no other.
    const rows = await harness.db().query<{ n: string }>("SELECT count(*)::text AS n FROM metric_daily WHERE project_id = $1", [s.projectId]);
    expect(Number(rows.rows[0]!.n)).toBeGreaterThan(0);
  }, 120_000);

  it("NEW-A-7 AC4 · the other workspace's scorecards are untouched by this workspace's scan", async () => {
    const a = await scenario(1);
    const b = await scenario(1);
    await deepScan(a);

    const bScore = await scorecards(b);
    expect(bScore.engines.find((e) => e.engine_key === "gemini")!.metrics.cells_total).toBe(0);
    const bRows = await harness.db().query("SELECT 1 FROM metric_daily WHERE project_id = $1", [b.projectId]);
    expect(bRows.rowCount).toBe(0);
    // RLS, as the runtime role. (The HTTP harness connects as a superuser, so it cannot show this;
    // the GET above only proves B's own numbers did not move.) B's context sees none of A's rows,
    // A's context sees them.
    const visible = async (workspaceId: string): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      await inTenant(workspaceId, async (tx) => {
        for (const table of ["metric_daily", "answer_captures", "mention_facts", "citation_facts"]) {
          const r = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE project_id = $1`, [a.projectId]);
          counts[table] = Number(r.rows[0]!.n);
        }
      });
      return counts;
    };
    expect(await visible(b.workspaceId)).toEqual({ metric_daily: 0, answer_captures: 0, mention_facts: 0, citation_facts: 0 });
    const own = await visible(a.workspaceId);
    expect(Object.values(own).every((n) => n > 0)).toBe(true);
  }, 120_000);

  it("NEW-A-7 AC4 · negative control: cells captured but never parsed request no rollup, and the growth map stays empty", async () => {
    const s = await scenario(2);
    const runId = uuidV7();
    await harness.db().query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells)
       VALUES ($1,$2,$3,'manual',ARRAY['gemini'],2)`,
      [runId, s.workspaceId, s.projectId],
    );
    // Cells captured but never parsed (the parse queue is not drained): there are no facts, so no rollup can exist.
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const rollupRequests: Array<{ workspaceId: string; payload: Record<string, unknown> }> = [];
    const execute = createCaptureExecuteHandler(context, {
      cache: new InMemoryCacheAdapter(),
      realtime: publisher,
      enqueueParse: async () => undefined,
      enqueueRollup: async (_q, workspaceId, payload) => {
        rollupRequests.push({ workspaceId, payload });
      },
    });
    for (const [sampleIndex, promptId] of s.promptIds.entries()) {
      await inTenant(s.workspaceId, (tx) =>
        execute(tx, {
          data: {
            payload: {
              workspaceId: s.workspaceId, kid: "k", projectId: s.projectId, runId, promptId,
              promptText: `best crm ${String(sampleIndex)}`, engineKey: "gemini", sampleIndex,
              adapterVersion: "1.0.0", ttlSeconds: 3600, locale: "en-US", personaHint: null,
            },
          },
        } as unknown as Job),
      );
    }
    // Recorded, not discarded: finalising unparsed cells must not request a rollup at all.
    expect(rollupRequests, "no rollup is requested while cells are unparsed").toEqual([]);
    // The growth map reads metric_daily, which only a rollup writes; unparsed cells have produced none.
    const brand = (await growthMap(s)).series.find((series) => series.entity_type === "brand")!;
    expect(brand.points.every((p) => p.cells === 0 && p.visibility_score === null)).toBe(true);
    const rows = await harness.db().query("SELECT 1 FROM metric_daily WHERE project_id = $1", [s.projectId]);
    expect(rows.rowCount).toBe(0);
  }, 120_000);

  it("E2E-B6a · a live Gemini capture advances capture_runs.captured_cells, one per live cell, and only live ones", async () => {
    const s = await scenario(2);
    const { runId } = await deepScan(s);
    const run = await harness.db().query<{ captured_cells: number; planned_cells: number }>(
      "SELECT captured_cells, planned_cells FROM capture_runs WHERE id = $1",
      [runId],
    );
    expect(run.rows[0]!.captured_cells).toBe(2);
    expect(run.rows[0]!.captured_cells).toBeLessThanOrEqual(run.rows[0]!.planned_cells);
  }, 120_000);

  it("E2E-B6b · a live Gemini capture writes one usage_ledger row per cell with the adapter's cost", async () => {
    const s = await scenario(2);
    const { runId } = await deepScan(s);
    const rows = await harness.db().query<{
      metric: string; quantity: number; unit_cost_usd: string; engine_key: string; source: string;
      credits_charged: number; cache_layer: string; reference_type: string; reference_id: string; project_id: string;
    }>("SELECT * FROM usage_ledger WHERE workspace_id = $1", [s.workspaceId]);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row).toMatchObject({
        metric: "capture", quantity: 1, engine_key: "gemini", source: "manual_run", credits_charged: 0,
        cache_layer: "live", reference_type: "capture_run", reference_id: runId, project_id: s.projectId,
      });
      expect(Number(row.unit_cost_usd), "a real capture has a cost; null/0 would hide it").toBeGreaterThan(0);
    }
  }, 120_000);

  it("E2E-B6c · the Valkey spend meter total for gemini equals the usage_ledger cost of the same captures", async () => {
    const redis = new Redis(cacheValkey.url);
    try {
      const before = await redis.keys("engine-spend:total:gemini-*");
      await redis.del(...before);
      const s = await scenario(2);
      await deepScan(s);
      const keys = await redis.keys("engine-spend:total:gemini-*");
      expect(keys, "the meter wrote a gemini total for the month").toHaveLength(1);
      const metered = Number(await redis.get(keys[0]!));
      const ledger = await harness.db().query<{ total: string }>(
        "SELECT sum(unit_cost_usd * quantity)::text AS total FROM usage_ledger WHERE workspace_id = $1",
        [s.workspaceId],
      );
      expect(metered).toBeGreaterThan(0);
      expect(metered).toBeCloseTo(Number(ledger.rows[0]!.total), 5);
    } finally {
      await redis.quit();
    }
  }, 120_000);
});
