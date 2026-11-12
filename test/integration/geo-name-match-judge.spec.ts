import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoEntityDetailSchema } from "../../contracts/analytics/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { writeEntityNodes, type EntityCheck } from "../../src/lib/geo/entity.js";
import { JUDGE_WINDOW } from "../../src/lib/geo/name-match-judge/constants.js";
import type { NameMatchJudge, NameMatchQuery, NameMatchVerdict } from "../../src/lib/geo/name-match-judge/port.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createGeoAnalyzeHandler, type GeoAnalyzeDeps } from "../../src/lib/queue/handlers/geo-analyze.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor, phasesOf } from "../../src/lib/queue/worker-factory.js";
import { normalize } from "../../src/lib/parser/normalize.js";
import { createRollupMetricDailyHandler, type EnqueueNameMatchJudge } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { refreshProjectGeo } from "../../src/lib/rollup/refresh-project-geo.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { GeoService } from "../../src/modules/geo/geo.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-191 - the model name-match judge, end to end, under the RUNTIME role (`nominara_app`, no BYPASSRLS), through the real `createJobProcessor`
// (signature verified first, prepare and commit as separate tenant transactions around a run that holds neither a transaction nor a client).

const KEYS = { current: { kid: "k1", key: Buffer.from("name-match-judge-test-signing-key-32") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "geo.analyze")!;
const VERSION = "fixture-model:name-match-v1";
const AS_OF = new Date("2026-11-10T12:00:00Z");
const IN_WINDOW = "2026-11-01T10:00:00Z";

const ALL_PRESENT: EntityCheck[] = (["wikidata", "wikipedia", "g2", "crunchbase", "linkedin", "github", "category_directory"] as const).map((node) => ({ node, url: `https://${node}.example/acme`, missingFields: [] }));

/** The fixture model: records what it was shown, answers by rule. Never a real API. */
class FixtureJudge implements NameMatchJudge {
  readonly model = "fixture-model";
  constructor(
    readonly version: string = VERSION,
    private readonly rule: (q: NameMatchQuery) => NameMatchVerdict = () => "not_about_brand",
    private readonly onCall: () => Promise<void> = async () => {},
  ) {}
  readonly shown: NameMatchQuery[] = [];
  calls = 0;
  async judge(queries: readonly NameMatchQuery[]): Promise<readonly NameMatchVerdict[]> {
    this.calls += 1;
    this.shown.push(...queries);
    await this.onCall();
    return queries.map(this.rule);
  }
}
const open = { tryAcquire: async () => ({ granted: true, retryAfterMs: 0 }) };

describe("STORY-191 · the name-match judging job", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appPool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    appPool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 8 });
  }, 300_000);

  afterAll(async () => {
    await appPool.end();
    await db.end();
    await container.stop();
  });

  async function seedWorkspace(name: string): Promise<{ ws: string; project: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(`INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain,category_slug) VALUES ($1,$2,$3,$4,'https://notion.so','notion.so','crm')`, [project, ws, name, `p-${randomUUID().slice(0, 8)}`]);
    return { ws, project };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE name_match_verdicts, geo_analyses, entity_nodes, corpus_passages, answer_captures, mention_facts, competitors, projects, workspaces CASCADE");
    ({ ws: workspaceId, project: projectId } = await seedWorkspace("Notion"));
  });

  /** `n` brand name matches in `raw` (adapter text as stored), the span located by its first occurrence. Returns the mention ids. */
  async function matchesIn(n: number, raw: string, span: string, ws = workspaceId, project = projectId, alias = "notion"): Promise<string[]> {
    const start = normalize(raw).indexOf(span);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,content_hash,payload,status)
         VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','v1','v1','\\x00',$7::jsonb,'parsed')`,
        [id, ws, project, randomUUID(), randomUUID(), IN_WINDOW, JSON.stringify({ format: "markdown", text: raw })],
      );
      const mention = await db.query<{ id: string }>(
        `INSERT INTO mention_facts (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_label,matched_alias,
           occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,position_class,answer_form)
         VALUES ($1,$2,$3,$4,'gemini',$5,'brand','Notion',$8,0,$6,$7,0,0.5,'neutral',0,0.5,'lexicon','recommendation','narrative') RETURNING id`,
        [ws, project, id, randomUUID(), IN_WINDOW, start, start + span.length, alias],
      );
      ids.push(mention.rows[0]!.id);
    }
    return ids;
  }

  const verdicts = async () => (await db.query("SELECT * FROM name_match_verdicts ORDER BY mention_fact_id")).rows;
  const idleInTransaction = async (): Promise<number> =>
    Number((await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'nominara_app' AND state LIKE 'idle in transaction%'")).rows[0].n);

  async function deliver(deps: GeoAnalyzeDeps, ws = workspaceId, project = projectId, judgeVersion = VERSION): Promise<void> {
    const context = { pool: appPool, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => appPool.connect(),
      releaseClient: (client) => (client as unknown as { release(): void }).release(),
      process: createGeoAnalyzeHandler(context, { bucket: open, ...deps }),
    });
    const payload = { kind: "name_match_judge", projectId: project, judgeVersion, day: "2026-11-12", workspaceId: ws, kid: "k1" };
    await process({ data: signQueueJobPayload(payload, KEYS.current.key), attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job);
  }

  const inTx = <T>(fn: (tx: Client) => Promise<T>) => withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => fn(tx as unknown as Client)) as Promise<T>;
  const refresh = (judge: string) => inTx((tx) => refreshProjectGeo(tx, projectId, { asOf: AS_OF, judge }));
  const detailOf = async () =>
    geoEntityDetailSchema.parse((await withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new GeoService(new TasksService(new NoopRealtimePublisher())).analysis(projectId, "entity", { timeframe: "30d" }))).detail);

  it("AC2 · the registered geo.analyze handler is PHASED, and the model is awaited with NO transaction open and NO pooled client checked out", async () => {
    expect(phasesOf(createGeoAnalyzeHandler({ pool: appPool, env: {} } as unknown as QueueHandlerContext))).toBeDefined();
    await matchesIn(3, "Notion is a concept.", "Notion");
    const during: { idle: number; checkedOut: number }[] = [];
    const judge = new FixtureJudge(VERSION, () => "not_about_brand", async () => {
      during.push({ idle: await idleInTransaction(), checkedOut: appPool.totalCount - appPool.idleCount });
    });
    await deliver({ judge });
    expect(judge.calls).toBe(1);
    expect(during).toEqual([{ idle: 0, checkedOut: 0 }]);
    expect(await verdicts()).toHaveLength(3);
  });

  it("AC3 · each verdict is stored with the judge's identity and version, for the match, in the workspace; the match itself is untouched", async () => {
    const [mention] = await matchesIn(1, "Notion is a concept.", "Notion");
    const before = (await db.query("SELECT * FROM mention_facts WHERE id = $1", [mention])).rows[0];
    await deliver({ judge: new FixtureJudge() });
    const [row] = await verdicts();
    expect(row).toMatchObject({ mention_fact_id: mention, workspace_id: workspaceId, project_id: projectId, judge_version: VERSION, judge_model: "fixture-model", verdict: "not_about_brand" });
    expect((await db.query("SELECT * FROM mention_facts WHERE id = $1", [mention])).rows[0]).toEqual(before);
  });

  it("AC4 (red first) · a capitalised common word at the start of a sentence, one in a heading and a lowercase-only brand are SENT to the model, and what it says is what A2 reads", async () => {
    await matchesIn(1, "Notion is a concept in philosophy.", "Notion");
    await matchesIn(1, "## Notion\n\nSome text.", "Notion");
    await db.query("UPDATE projects SET name = 'monday', brand_aliases = '{}' WHERE id = $1", [projectId]);
    await matchesIn(1, "See you on monday then.", "monday", workspaceId, projectId, "monday");
    const judge = new FixtureJudge(VERSION, (q) => (q.span === "monday" ? "about_brand" : "not_about_brand"));
    await deliver({ judge });
    expect(judge.shown.map((q) => q.span).sort()).toEqual(["Notion", "Notion", "monday"]);
    expect((await verdicts()).map((v) => v.verdict).sort()).toEqual(["about_brand", "not_about_brand", "not_about_brand"]);
  });

  it("the model is asked ONLY about matches the heuristic leaves ambiguous: a mid-sentence use, a URL and a lowercase common word are never sent", async () => {
    await matchesIn(2, "We use Notion daily for work.", "Notion");
    await matchesIn(2, "Open https://www.notion.so/x now", "notion");
    await matchesIn(2, "That is a notion we like.", "notion");
    await matchesIn(1, "Notion is first.", "Notion");
    const judge = new FixtureJudge();
    await deliver({ judge });
    expect(judge.shown).toHaveLength(1);
    expect(await verdicts()).toHaveLength(1);
  });

  it("AC6 · only the span and a window of at most JUDGE_WINDOW each side leave the process, never the rest of the answer", async () => {
    const tail = "TAIL-OF-THE-ANSWER-NEVER-SENT";
    const head = "HEAD-OF-THE-ANSWER-NEVER-SENT";
    const raw = `${head} ${"a ".repeat(200)}. Notion is a concept ${"b ".repeat(200)} ${tail}`;
    await matchesIn(1, raw, "Notion");
    const judge = new FixtureJudge();
    await deliver({ judge });
    expect(judge.shown).toHaveLength(1);
    const q = judge.shown[0]!;
    expect(q.before.length).toBeLessThanOrEqual(JUDGE_WINDOW.before);
    expect(q.after.length).toBeLessThanOrEqual(JUDGE_WINDOW.after);
    expect(JSON.stringify(judge.shown)).not.toContain(tail);
    expect(JSON.stringify(judge.shown)).not.toContain(head);
  });

  it("a re-run judges only NEW matches, and a change of judge re-judges every one", async () => {
    await matchesIn(4, "Notion is a concept.", "Notion");
    const first = new FixtureJudge();
    await deliver({ judge: first });
    expect(first.shown).toHaveLength(4);

    const again = new FixtureJudge();
    await deliver({ judge: again });
    expect(again.calls).toBe(0);

    await matchesIn(2, "Notion is a concept.", "Notion");
    const incremental = new FixtureJudge();
    await deliver({ judge: incremental });
    expect(incremental.shown).toHaveLength(2);

    const changed = new FixtureJudge("other-model:name-match-v1");
    await deliver({ judge: changed }, workspaceId, projectId, "other-model:name-match-v1");
    expect(changed.shown).toHaveLength(6);
    expect((await verdicts()).filter((v) => v.judge_version === "other-model:name-match-v1")).toHaveLength(6);
  });

  it("a redelivery racing a first delivery writes each verdict once (ON CONFLICT DO NOTHING)", async () => {
    await matchesIn(5, "Notion is a concept.", "Notion");
    await Promise.all([deliver({ judge: new FixtureJudge() }), deliver({ judge: new FixtureJudge() })]);
    expect(await verdicts()).toHaveLength(5);
  });

  it("a job queued for another judge version than this process is bound to does nothing (no model call, no rows)", async () => {
    await matchesIn(3, "Notion is a concept.", "Notion");
    const judge = new FixtureJudge("current:name-match-v1");
    await deliver({ judge }, workspaceId, projectId, "stale:name-match-v1");
    expect(judge.calls).toBe(0);
    expect(await verdicts()).toHaveLength(0);
  });

  const usage = async (ws = workspaceId) => Number((await db.query("SELECT COALESCE(sum(matches_sent), 0)::int AS n FROM name_match_judge_usage WHERE workspace_id = $1", [ws])).rows[0].n);

  it("AC7 · the per-workspace monthly cap: a workspace at its cap is not judged and costs no model call, while another workspace is unaffected", async () => {
    await matchesIn(6, "Notion is a concept.", "Notion");
    const other = await seedWorkspace("Notion");
    await matchesIn(6, "Notion is a concept.", "Notion", other.ws, other.project);
    const j1 = new FixtureJudge();
    await deliver({ judge: j1, monthlyCap: 4 });
    expect(j1.shown).toHaveLength(4);
    expect(await verdicts()).toHaveLength(4);
    expect(await usage()).toBe(4);
    const j2 = new FixtureJudge();
    await deliver({ judge: j2, monthlyCap: 4 });
    expect(j2.calls, "the cap is spent").toBe(0);
    const j3 = new FixtureJudge();
    await deliver({ judge: j3, monthlyCap: 4 }, other.ws, other.project);
    expect(j3.shown).toHaveLength(4);
    // Last month's meter does not count against this month's cap.
    await db.query("UPDATE name_match_judge_usage SET month = (month - interval '1 month')::date WHERE workspace_id = $1", [workspaceId]);
    const j4 = new FixtureJudge();
    await deliver({ judge: j4, monthlyCap: 4 });
    expect(j4.shown).toHaveLength(2);
  });

  it("FIX ROUND (major) · N concurrent jobs across a workspace's projects with the cap at N-1 NEVER overshoot: the budget is reserved atomically before any model call", async () => {
    const N = 8;
    const projects = [projectId];
    for (let i = 1; i < N; i++) projects.push((await db.query<{ id: string }>(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES (gen_random_uuid(),$1,'Notion',$2,'https://notion.so','notion.so') RETURNING id`,
      [workspaceId, `p-${randomUUID().slice(0, 8)}`],
    )).rows[0]!.id);
    for (const p of projects) await matchesIn(1, "Notion is a concept.", "Notion", workspaceId, p);
    const judges = projects.map(() => new FixtureJudge());
    await Promise.all(projects.map((p, i) => deliver({ judge: judges[i]!, monthlyCap: N - 1 }, workspaceId, p)));
    const sent = judges.reduce((n, j) => n + j.shown.length, 0);
    expect(sent).toBe(N - 1);
    expect(await usage()).toBe(N - 1);
    expect(await verdicts()).toHaveLength(N - 1);
  }, 60_000);

  it("FIX ROUND (major) · a billed batch that FAILS is counted: the model was called, so the meter moves although no verdict is stored, and the cap then holds", async () => {
    await matchesIn(5, "Notion is a concept.", "Notion");
    const failing = new FixtureJudge(VERSION, () => "not_about_brand", async () => {
      throw new Error("provider 500");
    });
    await deliver({ judge: failing, monthlyCap: 5 });
    expect(failing.calls).toBe(1);
    expect(await verdicts()).toHaveLength(0);
    expect(await usage(), "the 5 matches sent are metered").toBe(5);
    const next = new FixtureJudge();
    await deliver({ judge: next, monthlyCap: 5 });
    expect(next.calls, "the cap is spent by the failed attempt").toBe(0);
  });

  it("FIX ROUND · what a job reserved but never sent (a closed bucket) is given back, so a later job can use it", async () => {
    await matchesIn(3, "Notion is a concept.", "Notion");
    const closed = new FixtureJudge();
    await deliver({ judge: closed, bucket: { tryAcquire: async () => ({ granted: false, retryAfterMs: 1 }) }, monthlyCap: 10 });
    expect(closed.calls).toBe(0);
    expect(await usage()).toBe(0);
    const later = new FixtureJudge();
    await deliver({ judge: later, monthlyCap: 3 });
    expect(later.shown).toHaveLength(3);
  });

  it("AC7 · the engine bucket is asked for a token before every model call, and a closed bucket means no model call at all", async () => {
    await matchesIn(3, "Notion is a concept.", "Notion");
    const asked: number[] = [];
    const judge = new FixtureJudge();
    await deliver({ judge, bucket: { tryAcquire: async () => (asked.push(1), { granted: false, retryAfterMs: 1 }) } });
    expect(asked.length).toBeGreaterThan(0);
    expect(judge.calls).toBe(0);
    expect(await verdicts()).toHaveLength(0);
  });

  it("RLS · a verdict is invisible to another workspace, and a job signed for another workspace that names this project judges nothing", async () => {
    await matchesIn(3, "Notion is a concept.", "Notion");
    await deliver({ judge: new FixtureJudge() });
    const other = await seedWorkspace("Notion");
    const client = await appPool.connect();
    try {
      const seen = await withTenantContext(client, { workspaceId: other.ws, actorId: randomUUID() }, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM name_match_verdicts")).rows[0].n);
      expect(seen).toBe(0);
    } finally {
      client.release();
    }
    const judge = new FixtureJudge("x:name-match-v1");
    await db.query("TRUNCATE name_match_verdicts");
    await deliver({ judge }, other.ws, projectId, "x:name-match-v1");
    expect(judge.calls).toBe(0);
    expect(await verdicts()).toHaveLength(0);
  });

  describe("AC5 · A2 disambiguation risk over JUDGED matches", () => {
    it("the heuristic alone passes sentence-initial common words as the brand (risk 0); the model's verdicts expose them (HIGH), and the alias task surfaces", async () => {
      await matchesIn(30, "Notion is a concept in philosophy.", "Notion");
      await matchesIn(10, "We use Notion daily for work.", "Notion");
      await refresh("heuristic-v1");
      expect(await detailOf()).toMatchObject({ disambiguation: { level: "low", risk: 0, name_matches: 40 } });

      await deliver({ judge: new FixtureJudge(VERSION, (q) => (q.before === "" ? "not_about_brand" : "about_brand")) });
      await refresh(VERSION);
      const detail = await detailOf();
      expect(detail.disambiguation).toMatchObject({ level: "high", name_matches: 40, not_about_brand: 30, unjudged: 0 });
      expect(detail.authority.suppressed).toBe(true);
    });

    it("a lowercase-only brand is MEASURED once the model has judged its matches (it was unmeasured under v1)", async () => {
      await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, ALL_PRESENT.map((c) => c.url!)));
      await db.query("UPDATE projects SET name = 'monday', brand_aliases = '{}' WHERE id = $1", [projectId]);
      await matchesIn(40, "See you on monday then.", "monday", workspaceId, projectId, "monday");
      await refresh("heuristic-v1");
      expect((await detailOf()).disambiguation).toMatchObject({ level: "unmeasured", unjudged: 40 });
      await deliver({ judge: new FixtureJudge(VERSION, () => "about_brand") });
      await refresh(VERSION);
      expect((await detailOf()).disambiguation).toMatchObject({ level: "low", risk: 0, unjudged: 0, name_matches: 40 });
    });

    it("the 30-match minimum is over JUDGED matches: 40 matches of which the model judged 25 and could not decide 15 is UNMEASURED, never low", async () => {
      await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, ALL_PRESENT.map((c) => c.url!)));
      await matchesIn(40, "Notion is a concept.", "Notion");
      let n = 0;
      await deliver({ judge: new FixtureJudge(VERSION, () => (n++ < 25 ? "about_brand" : "unjudged")) });
      await refresh(VERSION);
      expect((await detailOf()).disambiguation).toMatchObject({ level: "unmeasured", risk: null, name_matches: 40, unjudged: 15 });
    });

    it("a match the model could not decide is never guessed to be about the brand, and an ambiguous match NOT YET judged is unjudged under a model judge, not the heuristic's guess", async () => {
      await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, ALL_PRESENT.map((c) => c.url!)));
      await matchesIn(31, "Notion is a concept.", "Notion");
      await deliver({ judge: new FixtureJudge(VERSION, () => "unjudged"), monthlyCap: 100 });
      await refresh(VERSION);
      expect((await detailOf()).disambiguation).toMatchObject({ unjudged: 31, level: "unmeasured" });
      // Matches no job has reached yet: unjudged, not the heuristic's about_brand.
      await db.query("TRUNCATE name_match_verdicts");
      await refresh(VERSION);
      expect((await detailOf()).disambiguation).toMatchObject({ unjudged: 31, not_about_brand: 0, level: "unmeasured" });
    });

    it("AC8 · the guard is lifted by the model judge: all nodes checked, low judged risk, model judge in force publishes; the same rows under the heuristic do not", async () => {
      await inTx((tx) => writeEntityNodes(tx, projectId, ALL_PRESENT, ALL_PRESENT.map((c) => c.url!)));
      await matchesIn(35, "Notion is a concept.", "Notion");
      await deliver({ judge: new FixtureJudge(VERSION, () => "about_brand") });
      await refresh(VERSION);
      expect((await detailOf()).authority).toMatchObject({ suppressed: false, reason: null });
      expect(Number((await db.query("SELECT score FROM geo_analyses WHERE project_id = $1 AND analysis = 'entity' AND window_days = 30", [projectId])).rows[0].score)).toBe(100);
      await refresh("heuristic-v1");
      expect((await db.query("SELECT score FROM geo_analyses WHERE project_id = $1 AND analysis = 'entity' AND window_days = 30", [projectId])).rows[0].score).toBeNull();
    });
  });

  describe("the producer: the daily rollup queues the job AFTER its commit, and only when a model judge is bound", () => {
    async function rollup(env: Record<string, unknown>): Promise<{ queued: { workspaceId: string; payload: Parameters<EnqueueNameMatchJudge>[1]; key: string }[] }> {
      const queued: { workspaceId: string; payload: Parameters<EnqueueNameMatchJudge>[1]; key: string }[] = [];
      const handler = createRollupMetricDailyHandler({ pool: undefined, env } as unknown as QueueHandlerContext, {
        enqueueTaskGenerate: async () => undefined,
        enqueueVerifyPresence: async () => undefined,
        enqueueNameMatchJudge: async (workspaceId, payload, key) => void queued.push({ workspaceId, payload, key }),
      });
      await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await handler(tx, { id: "j", timestamp: Date.now(), data: { payload: { workspaceId, kid: "k", projectId, metricDate: "2026-11-09", reason: "closed_day" } } } as unknown as Job);
      });
      // afterCommit hooks start the enqueue without awaiting it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { queued };
    }

    it("a keyed model judge: one job for the project, signed for the workspace, under the judge's version and the day's key", async () => {
      const { queued } = await rollup({ NAME_MATCH_JUDGE: "gemini", NAME_MATCH_JUDGE_MODEL: "gemini-2.5-flash", GEMINI_API_KEY: "k" });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ workspaceId, payload: { kind: "name_match_judge", projectId, judgeVersion: "gemini-2.5-flash:name-match-v1" } });
      expect(queued[0]!.key).toBe(`geo:${projectId}:name-match:gemini-2.5-flash:name-match-v1.${queued[0]!.payload.day}`);
    });

    it("no judge bound (the default), or a model configured WITHOUT a key: nothing is queued, and the heuristic guard holds", async () => {
      expect((await rollup({})).queued).toHaveLength(0);
      expect((await rollup({ NAME_MATCH_JUDGE: "gemini", NAME_MATCH_JUDGE_MODEL: "gemini-2.5-flash" })).queued).toHaveLength(0);
    });
  });
});
