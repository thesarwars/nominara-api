import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { geoEntityDetailSchema, type GeoFinding } from "../../contracts/analytics/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { PageFetchResult, PageFetcher } from "../../src/lib/geo/corpus/page-fetcher.js";
import type { ProbeOutcome, ProbeSubject, WikiProfileProbe } from "../../src/lib/geo/entity-probe/wiki-probe.js";
import { PROBE_MIN_INTERVAL_DAYS } from "../../src/lib/geo/entity-probe/job.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createGeoAnalyzeHandler, type GeoAnalyzeDeps } from "../../src/lib/queue/handlers/geo-analyze.handler.js";
import { createRollupMetricDailyHandler, type EnqueueEntityProbe } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import { createTaskGenerateHandler } from "../../src/lib/queue/handlers/task-generate.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor, phasesOf } from "../../src/lib/queue/worker-factory.js";
import { refreshProjectGeo } from "../../src/lib/rollup/refresh-project-geo.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-060 E1/E3/E7 (owner decision 99b) - the profile probe job end to end, under the RUNTIME role (`nominara_app`, no BYPASSRLS), through the real
// `createJobProcessor`, against FIXTURE probes and pages: nothing here reaches Wikidata, Wikipedia or any site.

const KEYS = { current: { kid: "k1", key: Buffer.from("entity-probe-test-signing-key-32-bytes") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "geo.analyze")!;
const AS_OF = new Date("2026-11-10T12:00:00Z");
const MODEL = "fixture-model:name-match-v1";

const HOME = (sameAs: string[]) =>
  `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: "Acme", sameAs })}</script></head><body><main><h1>Acme</h1></main></body></html>`;
const html = (sameAs: string[]): PageFetchResult => ({ kind: "html", html: HOME(sameAs) });

class FixtureProbe implements WikiProfileProbe {
  calls = 0;
  subject: ProbeSubject | undefined;
  constructor(private readonly outcome: ProbeOutcome, private readonly onCall: () => Promise<void> = async () => {}) {}
  async probe(subject: ProbeSubject): Promise<ProbeOutcome> {
    this.calls += 1;
    this.subject = subject;
    await this.onCall();
    return this.outcome;
  }
}
const PRESENT: ProbeOutcome = {
  checks: [
    { node: "wikidata", url: "https://www.wikidata.org/wiki/Q1", missingFields: [] },
    { node: "wikipedia", url: "https://en.wikipedia.org/wiki/Acme_(company)", missingFields: ["lead_section", "official_website_link"] },
  ],
  unchecked: [],
};
const WIKIDATA_ABSENT: ProbeOutcome = {
  checks: [{ node: "wikidata", url: null, missingFields: [] }, { node: "wikipedia", url: null, missingFields: [] }],
  unchecked: [],
};

describe("STORY-060 E1/E3/E7 · the entity profile probe job", () => {
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

  async function seedWorkspace(): Promise<{ ws: string; project: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(`INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain,brand_aliases) VALUES ($1,$2,'Acme',$3,'https://acme.com','acme.com','{"Acme Inc"}')`, [project, ws, `p-${randomUUID().slice(0, 8)}`]);
    return { ws, project };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE notification_emails, notification_reads, notifications, tasks, ref_counters, geo_analyses, entity_nodes, mention_facts, answer_captures, competitors, projects, workspaces CASCADE");
    ({ ws: workspaceId, project: projectId } = await seedWorkspace());
  });

  const nodes = async () => (await db.query("SELECT node, present, complete, url, missing_fields, in_brand_sameas FROM entity_nodes WHERE project_id = $1 ORDER BY node", [projectId])).rows;
  const idleInTransaction = async (): Promise<number> =>
    Number((await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'nominara_app' AND state LIKE 'idle in transaction%'")).rows[0].n);

  async function deliver(deps: GeoAnalyzeDeps, env: Record<string, unknown> = { NODE_ENV: "test" }, ws = workspaceId, project = projectId): Promise<void> {
    const context = { pool: appPool, env } as unknown as QueueHandlerContext;
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => appPool.connect(),
      releaseClient: (client) => (client as unknown as { release(): void }).release(),
      process: createGeoAnalyzeHandler(context, deps),
    });
    const payload = { kind: "entity_probe", projectId: project, day: "2026-11-12", workspaceId: ws, kid: "k1" };
    await process({ data: signQueueJobPayload(payload, KEYS.current.key), attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job);
  }
  const page = (result: PageFetchResult): PageFetcher => async () => result;

  it("AC · the registered handler is PHASED, and the probe and the home-page fetch are awaited with NO transaction open and NO pooled client checked out", async () => {
    expect(phasesOf(createGeoAnalyzeHandler({ pool: appPool, env: {} } as unknown as QueueHandlerContext))).toBeDefined();
    const during: { idle: number; checkedOut: number }[] = [];
    const observe = async () => void during.push({ idle: await idleInTransaction(), checkedOut: appPool.totalCount - appPool.idleCount });
    await deliver({
      probe: new FixtureProbe(PRESENT, observe),
      fetchPage: async () => {
        await observe();
        return html([]);
      },
    });
    expect(during).toEqual([{ idle: 0, checkedOut: 0 }, { idle: 0, checkedOut: 0 }]);
    expect(await nodes()).toHaveLength(2);
  });

  it("E1 · the two probed nodes are written with presence and completeness separate, and ONLY those two: the other five stay not checked", async () => {
    const probe = new FixtureProbe(PRESENT);
    await deliver({ probe, fetchPage: page(html([])) });
    expect(probe.subject).toEqual({ name: "Acme", aliases: ["Acme Inc"], rootDomain: "acme.com" });
    expect(await nodes()).toEqual([
      { node: "wikidata", present: true, complete: true, url: "https://www.wikidata.org/wiki/Q1", missing_fields: [], in_brand_sameas: false },
      { node: "wikipedia", present: true, complete: false, url: "https://en.wikipedia.org/wiki/Acme_(company)", missing_fields: ["lead_section", "official_website_link"], in_brand_sameas: false },
    ]);
  });

  it("E3 · a profile the brand's home-page JSON-LD links is covered; one it does not link is a link gap", async () => {
    await deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page(html(["https://www.wikidata.org/wiki/Q1", "https://linkedin.com/company/acme"])) });
    expect((await nodes()).map((n) => [n.node, n.in_brand_sameas])).toEqual([["wikidata", true], ["wikipedia", false]]);
  });

  it("E3 · with the home page unreadable the brand's links are UNKNOWN: links already recorded stand, and a profile is never newly called unlinked-by-failure", async () => {
    await deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page(html(["https://www.wikidata.org/wiki/Q1"])) });
    await db.query("UPDATE entity_nodes SET last_checked_at = now() - interval '30 days' WHERE project_id = $1", [projectId]);
    await deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page({ kind: "refused", reason: "robots_disallowed" }) });
    expect((await nodes()).map((n) => [n.node, n.in_brand_sameas])).toEqual([["wikidata", true], ["wikipedia", false]]);
  });

  it("FAIL CLOSED · a node the probe could not check is NOT written (an earlier record stands), and a blocked probe never records absence", async () => {
    await deliver({ probe: new FixtureProbe({ checks: [], unchecked: [{ node: "wikidata", reason: "robots_disallowed" }, { node: "wikipedia", reason: "http_503" }] }), fetchPage: page(html([])) });
    expect(await nodes()).toEqual([]);
    await deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page(html([])) });
    await db.query("UPDATE entity_nodes SET last_checked_at = now() - interval '30 days' WHERE project_id = $1", [projectId]);
    await deliver({ probe: new FixtureProbe({ checks: [PRESENT.checks[1]!], unchecked: [{ node: "wikidata", reason: "http_503" }] }), fetchPage: page(html([])) });
    const wikidata = (await nodes()).find((n) => n.node === "wikidata")!;
    expect(wikidata).toMatchObject({ present: true, url: "https://www.wikidata.org/wiki/Q1" });
  });

  it("a project probed within the last week is skipped (no probe call, no fetch); a stale one is probed again", async () => {
    await deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page(html([])) });
    const again = new FixtureProbe(PRESENT);
    let fetched = 0;
    await deliver({ probe: again, fetchPage: async () => (fetched++, html([])) });
    expect(again.calls).toBe(0);
    expect(fetched).toBe(0);
    await db.query(`UPDATE entity_nodes SET last_checked_at = now() - make_interval(days => ${String(PROBE_MIN_INTERVAL_DAYS + 1)}) WHERE project_id = $1`, [projectId]);
    await deliver({ probe: again, fetchPage: page(html([])) });
    expect(again.calls).toBe(1);
  });

  it("a redelivery racing a first delivery leaves one row per node", async () => {
    await Promise.all([deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page(html([])) }), deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page(html([])) })]);
    expect(await nodes()).toHaveLength(2);
  });

  it("ENTITY_PROFILE_PROBE=none switches the job off: a queued job does nothing, and no network is reached", async () => {
    let fetched = 0;
    await deliver({ fetchPage: async () => (fetched++, html([])) }, { NODE_ENV: "test", ENTITY_PROFILE_PROBE: "none" });
    expect(fetched).toBe(0);
    expect(await nodes()).toEqual([]);
  });

  it("RLS · a job signed for another workspace that names this project probes nothing and writes nothing", async () => {
    const other = await seedWorkspace();
    const probe = new FixtureProbe(PRESENT);
    await deliver({ probe, fetchPage: page(html([])) }, { NODE_ENV: "test" }, other.ws, projectId);
    expect(probe.calls).toBe(0);
    expect(await nodes()).toEqual([]);
  });

  describe("E7 · a missing high-weight node raises its alert and generates its task", () => {
    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const as = <T>(fn: (c: Client) => Promise<T>) => withTenantContext(db, { workspaceId, actorId: randomUUID() }, (c) => fn(c as unknown as Client)) as Promise<T>;
    const refresh = (judge?: string) => as((c) => refreshProjectGeo(c, projectId, { asOf: AS_OF, ...(judge === undefined ? {} : { judge }) }));
    const entityRow = async () => (await db.query("SELECT score, suppression_reason, findings FROM geo_analyses WHERE project_id = $1 AND analysis = 'entity' AND window_days = 30", [projectId])).rows[0];
    const tasks = async () => (await db.query("SELECT * FROM tasks WHERE rule_code = 'TG-ENTITY-NODE' AND project_id = $1", [projectId])).rows;
    const alerts = async () => (await db.query("SELECT * FROM notifications WHERE kind = 'alert.entity_node_missing' AND project_id = $1", [projectId])).rows;
    async function runTaskJob(): Promise<void> {
      const handler = createTaskGenerateHandler(context, { realtime: new NoopRealtimePublisher(), enqueueNotify: async () => undefined });
      const job = { id: randomUUID(), data: { payload: { workspaceId, kid: "test-kid", projectId, metricDate: "2026-11-10" } } } as unknown as Job;
      await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => handler(db, job));
      await new Promise((resolve) => setImmediate(resolve));
    }
    async function addOwner(): Promise<void> {
      const owner = randomUUID();
      await db.query("INSERT INTO users (id,email,email_verified_at) VALUES ($1,$2,now())", [owner, `o-${owner.slice(0, 8)}@example.com`]);
      await db.query("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, owner]);
    }

    it("the probe finds no Wikidata profile: the analysis carries the finding, the score stays WITHHELD, and ONE task and ONE warning alert follow, once", async () => {
      await addOwner();
      await db.query("UPDATE task_generation_rules SET enabled = false WHERE code = 'TG-ENTITY-NODE'");
      await db.query("UPDATE task_generation_rules SET enabled = true WHERE code = 'TG-ENTITY-NODE'"); // restamps the non-retroactive watermark: independent of test order
      await deliver({ probe: new FixtureProbe(WIKIDATA_ABSENT), fetchPage: page(html([])) });
      await refresh(MODEL);
      const row = await entityRow();
      expect(row.score).toBeNull();
      expect((row.findings as GeoFinding[]).map((f) => f.id)).toContain("entity-node-missing-wikidata");
      expect(geoEntityDetailSchema.parse((row.findings as GeoFinding[])[0]!.entity).nodes.filter((n) => n.status === "unchecked")).toHaveLength(5);

      await runTaskJob();
      const [task] = await tasks();
      expect(task).toBeDefined();
      expect(await tasks()).toHaveLength(1);
      const [alert] = await alerts();
      expect(alert).toMatchObject({ severity: "warning", user_id: null });
      expect(alert.payload).toMatchObject({ alert_rule: "entity_node_missing", task_id: task.id });
      await runTaskJob();
      expect(await tasks()).toHaveLength(1);
      expect(await alerts()).toHaveLength(1);
    });

    it("a Wikidata profile that EXISTS raises nothing; so does an UNCHECKED one (a blocked probe), and a missing low-weight Wikipedia page", async () => {
      await db.query("UPDATE task_generation_rules SET enabled = false WHERE code = 'TG-ENTITY-NODE'");
      await db.query("UPDATE task_generation_rules SET enabled = true WHERE code = 'TG-ENTITY-NODE'");
      await deliver({ probe: new FixtureProbe({ checks: [PRESENT.checks[0]!, { node: "wikipedia", url: null, missingFields: [] }], unchecked: [] }), fetchPage: page(html([])) });
      await refresh(MODEL);
      await runTaskJob();
      expect(await tasks()).toHaveLength(0);
      expect(await alerts()).toHaveLength(0);
      await db.query("TRUNCATE entity_nodes");
      await deliver({ probe: new FixtureProbe({ checks: [], unchecked: [{ node: "wikidata", reason: "robots_disallowed" }, { node: "wikipedia", reason: "robots_disallowed" }] }), fetchPage: page(html([])) });
      await refresh(MODEL);
      await runTaskJob();
      expect(await tasks()).toHaveLength(0);
    });

    it("the finding, the task and the alert do not wait for the judge: under the v1 heuristic they fire and the score is withheld all the same", async () => {
      await db.query("UPDATE task_generation_rules SET enabled = false WHERE code = 'TG-ENTITY-NODE'");
      await db.query("UPDATE task_generation_rules SET enabled = true WHERE code = 'TG-ENTITY-NODE'");
      await deliver({ probe: new FixtureProbe(WIKIDATA_ABSENT), fetchPage: page(html([])) });
      await refresh();
      expect((await entityRow()).score).toBeNull();
      await runTaskJob();
      expect(await tasks()).toHaveLength(1);
    });

    it("the probe can NEVER publish a score on its own: with only the two probed nodes checked, under a model judge or the heuristic, the score is null", async () => {
      await deliver({ probe: new FixtureProbe(PRESENT), fetchPage: page(html(["https://www.wikidata.org/wiki/Q1"])) });
      await refresh(MODEL);
      expect((await entityRow()).score).toBeNull();
      expect((await entityRow()).suppression_reason).toMatch(/not been checked|have not been checked/iu);
      await refresh();
      expect((await entityRow()).score).toBeNull();
    });
  });

  describe("the producer: the daily rollup queues the probe AFTER its commit, only when ENTITY_PROFILE_PROBE is wikimedia", () => {
    async function rollup(env: Record<string, unknown>): Promise<{ workspaceId: string; payload: Parameters<EnqueueEntityProbe>[1]; key: string }[]> {
      const queued: { workspaceId: string; payload: Parameters<EnqueueEntityProbe>[1]; key: string }[] = [];
      const handler = createRollupMetricDailyHandler({ pool: undefined, env } as unknown as QueueHandlerContext, {
        enqueueTaskGenerate: async () => undefined,
        enqueueVerifyPresence: async () => undefined,
        enqueueEntityProbe: async (ws, payload, key) => void queued.push({ workspaceId: ws, payload, key }),
      });
      await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await handler(tx, { id: "j", timestamp: Date.now(), data: { payload: { workspaceId, kid: "k", projectId, metricDate: "2026-11-09", reason: "closed_day" } } } as unknown as Job);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return queued;
    }

    it("wikimedia: one job for the project, keyed by project and day", async () => {
      const queued = await rollup({ ENTITY_PROFILE_PROBE: "wikimedia" });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ workspaceId, payload: { kind: "entity_probe", projectId } });
      expect(queued[0]!.key).toBe(`geo:${projectId}:entity-probe:${queued[0]!.payload.day}`);
    });

    it("none, or unset: nothing is queued", async () => {
      expect(await rollup({ ENTITY_PROFILE_PROBE: "none" })).toHaveLength(0);
      expect(await rollup({})).toHaveLength(0);
    });
  });
});
