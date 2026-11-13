import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createCrawlAuditHandler, type CrawlAuditDeps } from "../../src/lib/queue/handlers/crawl-audit.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import type { GuardedFetchInit, GuardedResponse } from "../../src/lib/net/guarded-fetch.js";
import type { ObjectStoragePort, PutObjectRequest } from "../../src/lib/storage/storage.port.js";
import type { Env } from "../../src/config/env.schema.js";
import { TEST_SIGNING_KEYS } from "../support/queue-test-harness.js";

// KAD-06 / ADR-0003 — `crawl.audit` holds NO transaction and NO pooled connection while it talks to the target or to the object
// store. It runs through the REAL createJobProcessor as the runtime role `nominara_app` (RLS live), over a real pool, and every
// outbound await (site-file fetch, sitemap fetch, page fetch, render, object-store put) asks Postgres whether any backend is
// `idle in transaction` and asks the pool whether any client is checked out. The superuser would bypass RLS and make the
// tenant half of these tests vacuous.

const counters: { name: string; labels: Record<string, string> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/telemetry/metrics.js")>("../../src/lib/telemetry/metrics.js");
  return {
    ...actual,
    incrementCounter: (name: string, labels: Record<string, string> = {}) => {
      counters.push({ name, labels });
      actual.incrementCounter(name, labels);
    },
  };
});

// STORY-051 AC13: the page rules run in the fetch phase, so they too must see no transaction and no checked-out client. The engine is
// wrapped, not replaced: the real evaluation still runs.
const engineHook = vi.hoisted(() => ({ onEvaluate: null as null | (() => Promise<void>) }));
vi.mock("../../src/lib/aux/rules/engine.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/aux/rules/engine.js")>("../../src/lib/aux/rules/engine.js");
  return {
    ...actual,
    // Review round 1: `runPageRules` evaluates page by page (so a rule that crashes on one page cannot take the others down), so the hook sits on the per-page entry.
    evaluateDocument: async (...args: Parameters<typeof actual.evaluateDocument>) => {
      if (engineHook.onEvaluate !== null) await engineHook.onEvaluate();
      return actual.evaluateDocument(...args);
    },
  };
});

const ENTRY = QUEUE_TOPOLOGY.find((e) => e.name === "crawl.audit")!;
const ROBOTS = "User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.xml\n";
const SITEMAP = "<urlset><url><loc>https://acme.com/</loc></url><url><loc>https://acme.com/pricing</loc></url><url><loc>https://acme.com/about</loc></url></urlset>";
const BODY: Record<string, string> = {
  "/": "<html>home</html>",
  "/pricing": "<html>pricing</html>",
  "/about": "<html>about</html>",
  "/robots.txt": ROBOTS,
  "/llms.txt": "# Acme\n- [Docs](https://acme.com/docs)\n",
  "/sitemap.xml": SITEMAP,
};

describe("KAD-06 · crawl.audit holds no transaction and no connection across a network await", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let wsA: string;
  let projA: string;
  let wsB: string;
  let projB: string;
  /** One observation per outbound await: what Postgres and the pool looked like at that instant. */
  let observed: { what: string; idleInTx: number; checkedOut: number }[];
  let fetched: string[];
  let putKeys: string[];
  /** How many times the worker asked the pool for a client. */
  let acquired: number;
  const exporter = new InMemorySpanExporter();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 4 });
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  async function seed(slug: string): Promise<{ ws: string; project: string }> {
    const ws = (await db.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1,$2,'free') RETURNING id", [`W ${slug}`, `w-${slug}`])).rows[0].id as string;
    const project = (
      await db.query("INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,'P',$2,'https://acme.com','acme.com') RETURNING id", [ws, `p-${slug}`])
    ).rows[0].id as string;
    await db.query(
      `INSERT INTO domain_verifications (id, workspace_id, project_id, domain, method, nonce, verified_at, last_checked_at) VALUES ($1,$2,$3,'acme.com','dns_txt','n',now(),now())`,
      [randomUUID(), ws, project],
    );
    return { ws, project };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE workspaces CASCADE");
    await db.query("DROP TRIGGER IF EXISTS poison_findings ON aux_findings");
    await db.query("DROP TRIGGER IF EXISTS slow_findings ON aux_findings");
    observed = [];
    fetched = [];
    putKeys = [];
    acquired = 0;
    counters.length = 0;
    exporter.reset();
    ({ ws: wsA, project: projA } = await seed("a"));
    ({ ws: wsB, project: projB } = await seed("b"));
  });

  const observe = async (what: string): Promise<void> => {
    const open = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'nominara_app' AND state LIKE 'idle in transaction%'",
    );
    observed.push({ what, idleInTx: Number(open.rows[0]!.n), checkedOut: pool.totalCount - pool.idleCount });
  };

  function deps(extra: Partial<CrawlAuditDeps> = {}): CrawlAuditDeps {
    return {
      now: () => new Date("2026-10-07T00:00:00Z"),
      sleep: async () => undefined,
      renderer: {
        render: async (url) => {
          await observe("render");
          return { html: `<html>rendered ${url}</html>`, finalUrl: url, status: 200 };
        },
      },
      store: async (relative) => {
        await observe("store");
        putKeys.push(relative);
        return `crawl/test/ws/${relative}`;
      },
      fetch: async (url: string, _init?: GuardedFetchInit): Promise<GuardedResponse> => {
        await observe("fetch");
        fetched.push(new URL(url).pathname);
        const body = BODY[new URL(url).pathname];
        if (body === undefined) return { status: 404, headers: {}, body: Buffer.from(""), finalUrl: url };
        return { status: 200, headers: {}, body: Buffer.from(body), finalUrl: url };
      },
      // The queue is never touched: these pages are bare stubs, so the page rules open findings and ask for task generation.
      enqueueTaskGenerate: async () => undefined,
      ...extra,
    };
  }

  const context = (env: Partial<Env> = {}): QueueHandlerContext => ({ pool, env: env as Env });
  const processor = (d: CrawlAuditDeps, env: Partial<Env> = {}) =>
    createJobProcessor(ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => {
        acquired += 1;
        return pool.connect();
      },
      releaseClient: (client) => (client as unknown as { release: () => void }).release(),
      process: createCrawlAuditHandler(context(env), d),
    });
  const signedJob = (ws: string, project: string, auditId = randomUUID()): Job =>
    ({
      data: signQueueJobPayload({ workspaceId: ws, kid: TEST_SIGNING_KEYS.current.kid, projectId: project, auditId, trigger: "onboarding" }, TEST_SIGNING_KEYS.current.key),
    }) as unknown as Job;
  const audits = async (ws?: string) => (await db.query(`SELECT * FROM aux_audits ${ws === undefined ? "" : "WHERE workspace_id = $1"} ORDER BY created_at`, ws === undefined ? [] : [ws])).rows;
  const findings = async () => (await db.query("SELECT rule_code, occurrence_count FROM aux_findings ORDER BY rule_code")).rows;

  it("KAD-06 · no transaction is open and no pooled connection is checked out during any fetch, render or object-store write", async () => {
    await processor(deps())(signedJob(wsA, projA));

    const kinds = new Set(observed.map((o) => o.what));
    expect(kinds).toEqual(new Set(["fetch", "render", "store"])); // not vacuous: every kind of outbound await was observed
    expect(observed.filter((o) => o.what === "fetch").length).toBeGreaterThanOrEqual(7); // 4 site files + 3 pages
    expect(observed.filter((o) => o.what === "render")).toHaveLength(3);
    expect(observed.filter((o) => o.what === "store").length).toBeGreaterThanOrEqual(7); // 3 pages x 2 copies + the manifest
    for (const o of observed) {
      expect(o.idleInTx, `idle in transaction during ${o.what}`).toBe(0);
      expect(o.checkedOut, `pooled client checked out during ${o.what}`).toBe(0);
    }
    expect(pool.totalCount - pool.idleCount).toBe(0); // and nothing leaked afterwards
  });

  it("KAD-06 / STORY-051 AC13 · the page rules are evaluated with no transaction open and no pooled connection checked out, and the findings are written by the short write transaction", async () => {
    engineHook.onEvaluate = () => observe("evaluate");
    try {
      await processor(deps())(signedJob(wsA, projA));
    } finally {
      engineHook.onEvaluate = null;
    }
    const evaluations = observed.filter((o) => o.what === "evaluate");
    expect(evaluations).toHaveLength(3); // once per crawled page (3 pages), every one of them outside a transaction
    for (const o of evaluations) {
      expect(o.idleInTx).toBe(0);
      expect(o.checkedOut).toBe(0);
    }
    // The pages are bare "<html>x</html>" stubs, so the rules find plenty: those findings exist, in the job's workspace only.
    const rows = (await db.query("SELECT DISTINCT workspace_id FROM aux_findings WHERE rule_code NOT IN ('AUX-R-001','AUX-R-002','AUX-R-003','AUX-R-004','AUX-R-007')")).rows;
    expect(rows).toEqual([{ workspace_id: wsA }]);
  });

  it("observability · the fetch phase is a span carrying counts only, the write is counted, and no log line names a workspace or a domain", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      lines.push(typeof message === "string" ? message : JSON.stringify(message));
    });
    try {
      await processor(deps())(signedJob(wsA, projA));
    } finally {
      log.mockRestore();
    }
    const [span] = exporter.getFinishedSpans().filter((x) => x.name === "crawl.audit.fetch");
    expect(span!.attributes).toMatchObject({ "nominara.crawl.kind": "crawled", "nominara.crawl.pages_crawled": 3 });
    expect(Number(span!.attributes["nominara.crawl.requests"])).toBeGreaterThanOrEqual(7);
    expect(counters.filter((c) => c.name === "nominara_aux_crawl_commit_total")).toEqual([{ name: "nominara_aux_crawl_commit_total", labels: { outcome: "written" } }]);
    const line = lines.find((l) => l.includes('"span":"crawl.audit"'))!;
    expect(line).toContain(wsA); // the workspace ID...
    expect(line).not.toContain("W a"); // ...never its name
    expect(line).not.toContain("acme.com"); // and never a customer domain
  });

  it("the audit is still written whole, in the job's workspace, by the short write transaction", async () => {
    await processor(deps())(signedJob(wsA, projA));
    const [a] = await audits();
    expect(a).toMatchObject({ workspace_id: wsA, project_id: projA, status: "completed", pages_crawled: 3, pages_failed: 0, scope: "key_pages" });
    // R1: every delivery stores under its OWN run id, and the committed row names the winner's prefix.
    expect(a.dom_object_prefix).toMatch(new RegExp(`^crawl/test/ws/${a.id}/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/$`));
    expect((await audits(wsB)).length).toBe(0);
  });

  it("NFR-SEC-01 · a job signed for workspace A that names workspace B's project fetches NOTHING and writes nothing (RLS hides the project in prepare)", async () => {
    await processor(deps())(signedJob(wsA, projB));
    expect(fetched).toEqual([]);
    expect(putKeys).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("a tampered job is rejected before any connection is acquired or any request is made", async () => {
    const good = signedJob(wsA, projA);
    const tampered = { data: { payload: { ...(good.data as { payload: object }).payload, workspaceId: wsB }, signature: (good.data as { signature: string }).signature } } as unknown as Job;
    await expect(processor(deps())(tampered)).rejects.toThrow();
    expect(fetched).toEqual([]);
    expect(acquired).toBe(0);
  });

  it("idempotency · a redelivery of a completed audit makes no request at all (decided in prepare) and changes nothing", async () => {
    const auditId = randomUUID();
    await processor(deps())(signedJob(wsA, projA, auditId));
    const before = await findings();
    fetched.length = 0;
    await processor(deps())(signedJob(wsA, projA, auditId));
    expect(fetched).toEqual([]);
    expect(await findings()).toEqual(before);
    expect(await audits()).toHaveLength(1);
  });

  it("idempotency · two deliveries of the SAME job racing through the fetch phase write ONE audit and count each finding once", async () => {
    // robots.txt without any AI rule but a wildcard disallow of a tracked path would add a finding; use a missing llms.txt for a deterministic one
    const body = { ...BODY };
    delete body["/llms.txt"];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrived = 0;
    const gated = deps({
      fetch: async (url) => {
        // both deliveries reach their first fetch (so both have finished `prepare`) before either proceeds
        if (new URL(url).pathname === "/robots.txt") {
          arrived += 1;
          if (arrived === 2) release();
          await gate;
        }
        const hit = body[new URL(url).pathname];
        return hit === undefined ? { status: 404, headers: {}, body: Buffer.from(""), finalUrl: url } : { status: 200, headers: {}, body: Buffer.from(hit), finalUrl: url };
      },
    });
    const job = signedJob(wsA, projA);
    await Promise.all([processor(gated)(job), processor(gated)(job)]);
    expect(arrived).toBe(2); // both really did run the fetch phase: this is the race, not a serialised pair
    // observability: the loser is counted as a duplicate, the winner as written, and each ran its own fetch-phase span
    expect(counters.filter((c) => c.name === "nominara_aux_crawl_commit_total").map((c) => c.labels.outcome).sort()).toEqual(["duplicate", "written"]);
    expect(exporter.getFinishedSpans().filter((x) => x.name === "crawl.audit.fetch")).toHaveLength(2);
    expect(await audits()).toHaveLength(1);
    const rows = await findings();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.occurrence_count, `${r.rule_code} counted once`).toBe(1);
    // S2: each delivery stored a manifest under its own run prefix; exactly one of them is the committed audit's
    const [a] = await audits();
    const manifests = putKeys.filter((k) => k.endsWith("/manifest.json")).map((k) => `crawl/test/ws/${k}`);
    expect(new Set(manifests).size).toBe(2);
    expect(manifests.filter((k) => k.startsWith(a.dom_object_prefix))).toHaveLength(1);
  });

  // A store where the LAST writer of a key wins, as an object store does. Each call to `lww()` shares one backing map.
  const lww = (): { objects: Map<string, Buffer>; store: NonNullable<CrawlAuditDeps["store"]> } => {
    const objects = new Map<string, Buffer>();
    return { objects, store: async (relative, body) => { objects.set(`crawl/test/ws/${relative}`, body); return `crawl/test/ws/${relative}`; } };
  };

  it("R1 · a duplicate delivery that finishes its run AFTER the winner committed cannot overwrite the winner's stored copies or manifest", async () => {
    const { objects, store } = lww();
    const auditId = randomUUID();
    const job = signedJob(wsA, projA, auditId);
    const bodyOf = (tag: string): Record<string, string> => ({ ...BODY, "/": `<html>delivery ${tag}</html>` });
    const serving = (tag: string, gatePage?: Promise<void>): CrawlAuditDeps =>
      deps({
        store,
        fetch: async (url) => {
          const path = new URL(url).pathname;
          if (path === "/" && gatePage !== undefined) await gatePage;
          const hit = bodyOf(tag)[path];
          return hit === undefined ? { status: 404, headers: {}, body: Buffer.from(""), finalUrl: url } : { status: 200, headers: {}, body: Buffer.from(hit), finalUrl: url };
        },
      });
    let releaseLoser!: () => void;
    const loserGate = new Promise<void>((resolve) => (releaseLoser = resolve));
    const winner = processor(serving("winner"))(job);
    const loser = processor(serving("loser", loserGate))(job);
    await winner; // the winner commits while the loser is still inside `run`...
    releaseLoser(); // ...and only then does the loser finish its run, writing its copies and manifest LAST
    await loser;

    const [a] = await audits();
    expect(await audits()).toHaveLength(1);
    const manifest = JSON.parse(objects.get(`${a.dom_object_prefix}manifest.json`)!.toString("utf8")) as { pages: { url: string; raw?: { object_key: string; sha256: string } }[] };
    const home = manifest.pages.find((p) => p.url === "https://acme.com/")!;
    // the manifest at the committed prefix is the WINNER's: it names the winner's bytes, and those bytes are what is stored under it
    expect(home.raw!.sha256).toBe(createHash("sha256").update("<html>delivery winner</html>").digest("hex"));
    expect(home.raw!.object_key.startsWith(a.dom_object_prefix)).toBe(true);
    expect(gunzipSync(objects.get(home.raw!.object_key)!).toString("utf8")).toBe("<html>delivery winner</html>");
    // S2: exactly one manifest lives under the committed prefix; the loser's is an orphan under a prefix of its own
    const manifests = [...objects.keys()].filter((k) => k.endsWith("/manifest.json"));
    expect(manifests).toHaveLength(2);
    expect(manifests.filter((k) => k.startsWith(a.dom_object_prefix))).toHaveLength(1);
  });

  it("S1 · a project soft-deleted while the crawl ran gets NO audit and NO finding written (commit re-checks and locks the project)", async () => {
    const body = { ...BODY };
    delete body["/llms.txt"];
    let deleted = false;
    await processor(
      deps({
        fetch: async (url) => {
          if (!deleted) {
            deleted = true;
            await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projA]);
          }
          const hit = body[new URL(url).pathname];
          return hit === undefined ? { status: 404, headers: {}, body: Buffer.from(""), finalUrl: url } : { status: 200, headers: {}, body: Buffer.from(hit), finalUrl: url };
        },
      }),
    )(signedJob(wsA, projA));
    expect(deleted).toBe(true);
    expect(await audits()).toEqual([]);
    expect(await findings()).toEqual([]);
    expect(counters.filter((c) => c.name === "nominara_aux_crawl_commit_total").map((c) => c.labels.outcome)).toEqual(["project_gone"]);
  });

  it("S1 · two audits of ONE project reconcile one after the other: the second commit redetects the first's finding instead of failing on the fingerprint", async () => {
    const body = { ...BODY };
    delete body["/llms.txt"];
    // A finding insert takes 600 ms, so without a lock the second commit has read "no findings yet" before the first one's lands.
    await db.query(`CREATE OR REPLACE FUNCTION slow_findings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER slow_findings BEFORE INSERT ON aux_findings FOR EACH ROW EXECUTE FUNCTION slow_findings()");
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let arrived = 0;
      const gated = deps({
        fetch: async (url) => {
          if (new URL(url).pathname === "/robots.txt") {
            arrived += 1;
            if (arrived === 2) release();
            await gate;
          }
          const hit = body[new URL(url).pathname];
          return hit === undefined ? { status: 404, headers: {}, body: Buffer.from(""), finalUrl: url } : { status: 200, headers: {}, body: Buffer.from(hit), finalUrl: url };
        },
      });
      await Promise.all([processor(gated)(signedJob(wsA, projA)), processor(gated)(signedJob(wsA, projA))]);
      expect(await audits()).toHaveLength(2);
      const missing = (await db.query("SELECT occurrence_count FROM aux_findings WHERE rule_code = 'AUX-R-004'")).rows;
      expect(missing).toEqual([{ occurrence_count: 2 }]);
    } finally {
      await db.query("DROP TRIGGER slow_findings ON aux_findings");
    }
  });

  it("a run that throws leaves NO audit row (no orphan 'running'), no connection, and the retry completes", async () => {
    const auditId = randomUUID();
    await expect(
      processor(deps({ sleep: async () => { throw new Error("worker is shutting down"); } }))(signedJob(wsA, projA, auditId)),
    ).rejects.toThrow("worker is shutting down");
    expect(await audits()).toEqual([]);
    expect(pool.totalCount - pool.idleCount).toBe(0);

    await processor(deps())(signedJob(wsA, projA, auditId)); // BullMQ's retry
    expect(await audits()).toMatchObject([{ id: auditId, status: "completed" }]);
  });

  it("a write that fails rolls the whole audit back (one atomic commit), and the retry completes with each finding counted once", async () => {
    await db.query(
      `CREATE OR REPLACE FUNCTION poison_findings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'poisoned'; END $$`,
    );
    const body = { ...BODY };
    delete body["/llms.txt"];
    const missingLlms = deps({
      fetch: async (url) => {
        const hit = body[new URL(url).pathname];
        return hit === undefined ? { status: 404, headers: {}, body: Buffer.from(""), finalUrl: url } : { status: 200, headers: {}, body: Buffer.from(hit), finalUrl: url };
      },
    });
    await db.query("CREATE TRIGGER poison_findings BEFORE INSERT ON aux_findings FOR EACH ROW EXECUTE FUNCTION poison_findings()");
    const auditId = randomUUID();
    await expect(processor(missingLlms)(signedJob(wsA, projA, auditId))).rejects.toThrow(/poisoned/);
    expect(await audits()).toEqual([]);
    expect(await findings()).toEqual([]);
    expect(pool.totalCount - pool.idleCount).toBe(0);

    await db.query("DROP TRIGGER poison_findings ON aux_findings");
    await processor(missingLlms)(signedJob(wsA, projA, auditId));
    expect(await audits()).toHaveLength(1);
    for (const r of await findings()) expect(r.occurrence_count).toBe(1);
  });

  it("the default object store is bound to the job's workspace INSIDE the tenant context and still writes with no transaction open", async () => {
    const puts: PutObjectRequest[] = [];
    const port: ObjectStoragePort = {
      put: async (request) => {
        await observe("port_put");
        puts.push(request);
      },
      get: async () => Buffer.alloc(0),
      head: async () => ({ contentLength: 0 }) as never,
      delete: async () => undefined,
      presignGet: async () => "",
    };
    const d = deps();
    const { store: _injected, ...withoutInjectedStore } = d;
    await processor({ ...withoutInjectedStore, storagePort: port }, { STORAGE_BUCKET_RAW: "raw-bucket", STORAGE_BUCKET_REPORTS: "reports-bucket", STORAGE_KEY_ENV: "test", STORAGE_SSE: "AES256" })(
      signedJob(wsA, projA),
    );
    expect(puts.length).toBeGreaterThanOrEqual(7);
    // every key lies in THIS workspace's prefix, taken from the tenant context and never from the payload
    for (const request of puts) expect(request.key.startsWith(`test/${wsA}/crawl/`), request.key).toBe(true);
    for (const o of observed.filter((x) => x.what === "port_put")) {
      expect(o.idleInTx).toBe(0);
      expect(o.checkedOut).toBe(0);
    }
  });
});
