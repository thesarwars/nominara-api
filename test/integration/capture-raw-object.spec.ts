import { createHash, randomUUID } from "node:crypto";
import { OPEN_ENGINE_GATE } from "../support/open-engine-gate.js";
import { gunzipSync } from "node:zlib";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, RetentionExceededError } from "../../src/api/errors/domain-errors.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { RealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { encodeRawObject, rawObjectRelativeKey } from "../../src/lib/capture/raw-object.js";
import type { SpendMeter } from "../../src/lib/engines/spend-meter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createCaptureExecuteHandler } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { S3Adapter } from "../../src/lib/storage/s3.adapter.js";
import { resolveStorageConfig, type StorageConfig } from "../../src/lib/storage/storage-config.js";
import { StorageTenancyError } from "../../src/lib/storage/storage-keys.js";
import type { ObjectStoragePort, PutObjectRequest } from "../../src/lib/storage/storage.port.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import { RawDownloadService } from "../../src/modules/tracking/raw-download.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import { TEST_SIGNING_KEYS } from "../support/queue-test-harness.js";

// STORY-181 - raw capture objects in object storage, the parser reading them, and the signed raw download.
//
// Run under the shared docker lock: a Postgres AND a LocalStack (S3 only, signature validation on).
//
// BOTH WORKERS ARE PHASED (ADR-0003). `capture.parse` reads the object with no transaction and no pooled connection; `capture.execute`
// makes its vendor call and PUTs the object with none either, then writes the row in a second short transaction. The KAD-06 tests
// below observe Postgres and the pool at the instant of every vendor call, PUT and read, through the REAL job processor.

const ANSWER = "## Best CRMs\n\n1. **HubSpot** - we recommend it for most teams.\n2. Salesforce - deeper reporting.\n";
const TAMPERED = "Zoho CRM is the only thing worth buying.";
const KEY_ENV = "inttest";

/** Called at the instant of every vendor call, so a test can look at Postgres from inside it. */
const vendor = vi.hoisted(() => ({ onCall: undefined as undefined | (() => Promise<void>) }));

vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engines/registry.js")>();
  return {
    ...actual,
    resolveEngine: () => ({
      engineKey: "gemini",
      captureMode: "api",
      adapterVersion: "1.0.0",
      supportsCitations: true,
      concurrencyPerTask: 1,
      healthProbe: () => Promise.resolve({ ok: true, latencyMs: 1 }),
      capture: async (input: { promptText: string }) => {
        await vendor.onCall?.();
        return (
          input.promptText.startsWith("refuse")
            ? { text: "", format: "plaintext", truncated: false, responseTokensEst: 0, latencyMs: 1, costUsd: 0, flags: ["engine_refused_to_answer"] }
            : {
                text: ANSWER,
                format: "markdown",
                truncated: false,
                responseTokensEst: 20,
                latencyMs: 5,
                costUsd: 0,
                structuredCitations: [{ url: "https://example.test/a", slot: 0 }],
                vendorRequestId: "req-1",
              }
        );
      },
    }),
  };
});

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

const ENTRY = QUEUE_TOPOLOGY.find((e) => e.name === "capture.parse")!;
const EXECUTE_ENTRY = QUEUE_TOPOLOGY.find((e) => e.name === "capture.execute")!;
const noopPublisher: RealtimePublisher = { toWorkspace: () => undefined, toProject: () => undefined, memberChanged: () => undefined };
const stubMeter = {
  isCeilingReached: () => Promise.resolve(false),
  recordCost: () => Promise.resolve({ newAlerts: [], totalUsd: 0, ceilingUsd: 100, hardStopped: false }),
} as unknown as SpendMeter;

describe("STORY-181 · raw capture objects", () => {
  let container: StartedPostgreSqlContainer;
  let localstack: LocalstackFixture;
  let config: StorageConfig;
  let s3: S3Adapter;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let promptId: string;
  let runId: string;
  let env: Record<string, string>;
  let observed: { idleInTx: number; checkedOut: number }[];
  const parseJobs: { resultId: string }[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    localstack = await startLocalstack();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 4 });
    env = {
      NODE_ENV: "test",
      STORAGE_ENDPOINT: localstack.endpoint,
      STORAGE_BUCKET_RAW: "nominara-raw",
      STORAGE_BUCKET_REPORTS: "nominara-reports",
      STORAGE_ACCESS_KEY_ID: "test",
      STORAGE_SECRET_ACCESS_KEY: "test",
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_SSE: "AES256",
      STORAGE_KEY_ENV: KEY_ENV,
    };
    const resolved = resolveStorageConfig(env as never);
    if (resolved === null) throw new Error("storage config unexpectedly null");
    config = resolved;
    s3 = new S3Adapter(config);
  }, 360_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    await localstack?.stop();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    runId = uuidV7();
    observed = [];
    vendor.onCall = undefined;
    counters.length = 0;
    parseJobs.length = 0;
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'growth')", [id, `w-${randomUUID().slice(0, 8)}`]);
    }
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, owned_domains, brand_aliases)
       VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com',ARRAY[]::text[],ARRAY[]::text[])`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'best crm',sha256('best crm'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    await db.query(`INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells) VALUES ($1,$2,$3,'scheduled',ARRAY['gemini'],1)`, [
      runId,
      workspaceId,
      projectId,
    ]);
  });

  // ---------------------------------------------------------------- helpers

  const context = (over: Record<string, unknown> = {}): QueueHandlerContext => ({ pool: undefined, env: { ...env, ...over } }) as unknown as QueueHandlerContext;

  function executeJob(text = "best crm"): Job {
    return {
      data: {
        payload: { workspaceId, kid: "k", projectId, runId, promptId, promptText: text, engineKey: "gemini", sampleIndex: 0, adapterVersion: "1.0.0", ttlSeconds: 3600, locale: "en-US", personaHint: null },
      },
    } as unknown as Job;
  }

  function execute(over: { storagePort?: ObjectStoragePort; env?: Record<string, unknown>; text?: string } = {}): Promise<void> {
    const handler = createCaptureExecuteHandler(context(over.env), {
      cache: new InMemoryCacheAdapter(),
      engineGate: OPEN_ENGINE_GATE,
      realtime: noopPublisher,
      enqueueParse: (payload) => {
        parseJobs.push(payload);
        return Promise.resolve();
      },
      spendMeter: stubMeter,
      enqueueRollup: () => Promise.resolve(),
      ...(over.storagePort !== undefined ? { storagePort: over.storagePort } : {}),
    });
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await handler(tx, executeJob(over.text));
    });
  }

  interface CaptureRowShape {
    id: string;
    raw_object_key: string | null;
    captured_at: Date;
    status: string;
    payload: { text?: string; format?: string; structured_citations?: unknown[]; vendor_request_id?: string };
  }
  const captureRows = async (): Promise<CaptureRowShape[]> =>
    (await db.query<CaptureRowShape>("SELECT id, raw_object_key, captured_at, status, payload FROM answer_captures WHERE run_id = $1", [runId])).rows;

  /** A captured row as `capture.execute` writes one, optionally with a raw object already in the bucket. */
  async function seedCapture(opts: { workspace?: string; payloadText?: string; objectText?: string | null; storedKey?: string | null; capturedAt?: Date; status?: string } = {}): Promise<string> {
    const resultId = randomUUID();
    const capturedAt = opts.capturedAt ?? new Date();
    const payloadText = opts.payloadText ?? ANSWER;
    let key: string | null = opts.storedKey ?? null;
    if (opts.objectText !== undefined && opts.objectText !== null) {
      const store = new TenantObjectStore(s3, KEY_ENV);
      key = await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
        store.put("raw", rawObjectRelativeKey(capturedAt, resultId), encodeRawObject({ format: "markdown", text: opts.objectText! })),
      );
    }
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version,
          content_hash, response_excerpt, payload, raw_object_key, flags, cache_layer, status)
       VALUES ($1,$2,$3,$4,$5,'google_ai_mode',$6,'api','1.0.0','n1',$7,$8,$9::jsonb,$10,'{}','live',$11)`,
      [
        resultId,
        opts.workspace ?? workspaceId,
        projectId,
        uuidV7(),
        promptId,
        capturedAt,
        createHash("sha256").update(payloadText, "utf8").digest(),
        payloadText.slice(0, 280),
        JSON.stringify({ format: "markdown", text: payloadText }),
        key,
        opts.status ?? "captured",
      ],
    );
    return resultId;
  }

  const observe = async (): Promise<void> => {
    const open = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'nominara_app' AND state LIKE 'idle in transaction%'",
    );
    observed.push({ idleInTx: Number(open.rows[0]!.n), checkedOut: pool.totalCount - pool.idleCount });
  };

  /** The parse handler through the REAL job processor, as `nominara_app`, so a held transaction or connection is visible. */
  function parse(resultId: string, over: { storagePort?: ObjectStoragePort; force?: boolean } = {}): Promise<unknown> {
    const processor = createJobProcessor(ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as unknown as { release: () => void }).release(),
      process: createCaptureParseHandler({ pool, env } as unknown as QueueHandlerContext, {
        enqueueRollup: () => Promise.resolve(),
        markRollupDirty: () => Promise.resolve(),
        ...(over.storagePort !== undefined ? { storagePort: over.storagePort } : {}),
      }),
    });
    const job = {
      data: signQueueJobPayload(
        { workspaceId, kid: TEST_SIGNING_KEYS.current.kid, resultId, projectId, promptId, engineKey: "google_ai_mode", capturedAt: new Date().toISOString(), force: over.force ?? false },
        TEST_SIGNING_KEYS.current.key,
      ),
    } as unknown as Job;
    return processor(job);
  }

  /** A port that records what Postgres and the pool look like at the instant of every object read. */
  const observingPort = (inner: ObjectStoragePort): ObjectStoragePort => ({
    put: inner.put.bind(inner),
    head: inner.head.bind(inner),
    delete: inner.delete.bind(inner),
    presignGet: inner.presignGet.bind(inner),
    get: async (bucket, key) => {
      await observe();
      return inner.get(bucket, key);
    },
  });

  const facts = async (resultId: string) =>
    (
      await db.query(
        `SELECT entity_type, entity_label, matched_alias, occurrence_index, char_start, char_end, first_token_index, prominence, list_position,
                sentiment_label, sentiment_score, sentiment_confidence, sentiment_method, position_class, answer_form
           FROM mention_facts WHERE result_id = $1 ORDER BY char_start, entity_type`,
        [resultId],
      )
    ).rows;

  // ------------------------------------------------------------ AC1: the write

  it("181-AC1a · a captured cell is gzipped to {env}/{ws}/{yyyy}/{mm}/{id}.json.gz and the row carries raw_object_key", async () => {
    await execute();
    const [row] = await captureRows();
    expect(row!.status).toBe("captured");
    const yyyy = String(row!.captured_at.getUTCFullYear());
    const mm = String(row!.captured_at.getUTCMonth() + 1).padStart(2, "0");
    expect(row!.raw_object_key).toBe(`${KEY_ENV}/${workspaceId}/${yyyy}/${mm}/${row!.id}.json.gz`);

    const bytes = await s3.get("raw", row!.raw_object_key!);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(JSON.parse(gunzipSync(bytes).toString("utf8"))).toEqual({
      format: "markdown",
      text: ANSWER,
      structured_citations: [{ url: "https://example.test/a", slot: 0 }],
      vendor_request_id: "req-1",
    });
  });

  it("181-AC1b · DUAL WRITE: payload keeps the same text, so the document and reuse paths are unchanged", async () => {
    await execute();
    const [row] = await captureRows();
    const object = JSON.parse(gunzipSync(await s3.get("raw", row!.raw_object_key!)).toString("utf8")) as { text: string };
    expect(row!.payload.text).toBe(ANSWER);
    expect(object.text).toBe(row!.payload.text);
  });

  it("181-AC1c · a failed upload fails the step: the job throws (so it retries) and NO row exists", async () => {
    const failing: ObjectStoragePort = {
      put: () => Promise.reject(new Error("s3 is down")),
      get: s3.get.bind(s3),
      head: s3.head.bind(s3),
      delete: s3.delete.bind(s3),
      presignGet: s3.presignGet.bind(s3),
    };
    await expect(execute({ storagePort: failing })).rejects.toThrow("s3 is down");
    expect(await captureRows()).toEqual([]);
    expect(parseJobs).toEqual([]);
  });

  it("181-AC1d · no row points at a missing object: every stored key can be read back", async () => {
    await execute();
    for (const row of await captureRows()) {
      expect(row.raw_object_key).not.toBeNull();
      await expect(s3.head("raw", row.raw_object_key!)).resolves.toMatchObject({ contentLength: expect.any(Number) });
    }
  });

  it("181-AC1e · a refusal is data and its (empty) answer is stored as an object too", async () => {
    await execute({ text: "refuse this" });
    const [row] = await captureRows();
    expect(row!.raw_object_key).not.toBeNull();
    expect((JSON.parse(gunzipSync(await s3.get("raw", row!.raw_object_key!)).toString("utf8")) as { text: string }).text).toBe("");
  });

  it("181-AC1f · a REDELIVERED cell (its row already committed) uploads nothing and writes no second row", async () => {
    await execute();
    const puts: string[] = [];
    const counting: ObjectStoragePort = { put: (r: PutObjectRequest) => (puts.push(r.key), s3.put(r)), get: s3.get.bind(s3), head: s3.head.bind(s3), delete: s3.delete.bind(s3), presignGet: s3.presignGet.bind(s3) };
    await execute({ storagePort: counting });
    expect(puts).toEqual([]);
    expect(await captureRows()).toHaveLength(1);
  });

  it("181-AC1g · storage NOT configured: outside production the cell is captured without an object (the payload fallback); in production it fails closed", async () => {
    const unconfigured = { STORAGE_BUCKET_RAW: undefined, STORAGE_BUCKET_REPORTS: undefined };
    await execute({ env: unconfigured });
    expect((await captureRows())[0]!.raw_object_key).toBeNull();

    // The first cell finished the one-cell run; reopen it so the second attempt is a real capture and not a skipped terminal-run cell.
    await db.query("TRUNCATE answer_captures");
    await db.query("UPDATE capture_runs SET status = 'queued', captured_cells = 0, finished_at = NULL WHERE id = $1", [runId]);
    await expect(execute({ env: { ...unconfigured, NODE_ENV: "production" } })).rejects.toThrow(/object storage is not configured/);
    expect(await captureRows()).toEqual([]);
  });

  // ------------------------------------- ADR-0003: capture.execute is phased (round 3, finding 1)

  /** The execute handler through the REAL job processor, as `nominara_app`, so a held transaction or connection is visible. */
  function executeThroughProcessor(storagePort?: ObjectStoragePort, text = "best crm"): Promise<unknown> {
    const processor = createJobProcessor(EXECUTE_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as unknown as { release: () => void }).release(),
      process: createCaptureExecuteHandler(context(), {
        cache: new InMemoryCacheAdapter(),
        engineGate: OPEN_ENGINE_GATE,
        realtime: noopPublisher,
        enqueueParse: (payload) => {
          parseJobs.push(payload);
          return Promise.resolve();
        },
        spendMeter: stubMeter,
        enqueueRollup: () => Promise.resolve(),
        ...(storagePort !== undefined ? { storagePort } : {}),
      }),
    });
    const job = {
      data: signQueueJobPayload(
        { workspaceId, kid: TEST_SIGNING_KEYS.current.kid, projectId, runId, promptId, promptText: text, engineKey: "gemini", sampleIndex: 0, adapterVersion: "1.0.0", ttlSeconds: 3600, locale: "en-US", personaHint: null },
        TEST_SIGNING_KEYS.current.key,
      ),
    } as unknown as Job;
    return processor(job);
  }

  it("181-AC1h · KAD-06: no transaction is open and no pooled connection is checked out during the vendor call or the raw-object PUT", async () => {
    const what: string[] = [];
    const watched: ObjectStoragePort = {
      put: async (r: PutObjectRequest) => {
        await observe();
        what.push("put");
        return s3.put(r);
      },
      get: s3.get.bind(s3),
      head: s3.head.bind(s3),
      delete: s3.delete.bind(s3),
      presignGet: s3.presignGet.bind(s3),
    };
    vendor.onCall = async () => {
      await observe();
      what.push("vendor");
    };
    await executeThroughProcessor(watched);

    expect(what).toEqual(["vendor", "put"]); // not vacuous: both outbound awaits happened, and were observed
    for (const o of observed) expect(o).toEqual({ idleInTx: 0, checkedOut: 0 });
    expect(pool.totalCount - pool.idleCount).toBe(0);
    const [row] = await captureRows();
    expect(row!.status).toBe("captured");
    expect(row!.raw_object_key).not.toBeNull(); // and the short commit transaction still recorded the key
    expect(parseJobs).toHaveLength(1);
  });

  it("181-AC1i · SCANFIX-D5 survives the phasing: a run the reaper finalised while the vendor was answering takes no captured answer", async () => {
    vendor.onCall = async () => {
      await db.query("UPDATE capture_runs SET status = 'failed', finished_at = now() WHERE id = $1", [runId]);
    };
    await executeThroughProcessor();

    expect(await captureRows()).toEqual([]); // no captured answer on a refunded run
    const run = await db.query<{ status: string; captured_cells: number }>("SELECT status, captured_cells FROM capture_runs WHERE id = $1", [runId]);
    expect(run.rows[0]).toEqual({ status: "failed", captured_cells: 0 });
    expect(parseJobs).toEqual([]);
  });

  it("181-AC1j · a commit that fails after the PUT leaves an orphan object and NO row, and makes no storage call while its transaction is open", async () => {
    await db.query(`CREATE OR REPLACE FUNCTION refuse_capture_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit refused'; END $$`);
    await db.query("CREATE TRIGGER refuse_capture_insert BEFORE INSERT ON answer_captures FOR EACH ROW EXECUTE FUNCTION refuse_capture_insert()");
    const calls: string[] = [];
    const watched: ObjectStoragePort = {
      put: (r: PutObjectRequest) => (calls.push("put"), s3.put(r)),
      get: s3.get.bind(s3),
      head: s3.head.bind(s3),
      delete: (b, k) => (calls.push("delete"), s3.delete(b, k)),
      presignGet: s3.presignGet.bind(s3),
    };
    try {
      await expect(executeThroughProcessor(watched)).rejects.toThrow(/commit refused/);
    } finally {
      await db.query("DROP TRIGGER refuse_capture_insert ON answer_captures");
    }
    expect(await captureRows()).toEqual([]);
    expect(calls).toEqual(["put"]); // the orphan is KNOWN and left: a delete would be a storage call inside the commit transaction
    expect(counters.filter((c) => c.name === "nominara_capture_raw_objects_total").map((c) => c.labels.outcome)).not.toContain("written");
  });

  // --------------------------------------------------- AC2/AC3: the parser read

  it("181-AC2a · the parser reads the OBJECT: facts follow the object's text, not a diverging payload", async () => {
    const resultId = await seedCapture({ payloadText: TAMPERED, objectText: ANSWER });
    await parse(resultId);

    const labels = (await facts(resultId)).map((f) => f.entity_label);
    expect(labels).toContain("HubSpot");
    expect(labels).not.toContain("Zoho CRM");
  });

  it("181-AC2b · GOLDEN: parsing from the object and from the payload yields identical facts for the same answer", async () => {
    const fromObject = await seedCapture({ objectText: ANSWER });
    const fromPayload = await seedCapture({ objectText: null });
    await parse(fromObject);
    await parse(fromPayload);
    const a = await facts(fromObject);
    const b = await facts(fromPayload);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("181-AC3 · LEGACY ROW (raw_object_key NULL) is parsed from payload, with no storage read at all", async () => {
    const reads: string[] = [];
    const spying: ObjectStoragePort = { get: (b, k) => (reads.push(k), s3.get(b, k)), put: s3.put.bind(s3), head: s3.head.bind(s3), delete: s3.delete.bind(s3), presignGet: s3.presignGet.bind(s3) };
    const resultId = await seedCapture({ objectText: null });
    await parse(resultId, { storagePort: spying });
    expect(reads).toEqual([]);
    expect((await facts(resultId)).map((f) => f.entity_label)).toContain("HubSpot");
  });

  it("181-AC2c · KAD-06: no transaction is open and no pooled connection is checked out while the parser reads the object", async () => {
    const resultId = await seedCapture({ objectText: ANSWER });
    await parse(resultId, { storagePort: observingPort(s3) });
    expect(observed).toHaveLength(1); // not vacuous: the read happened and was observed
    expect(observed[0]).toEqual({ idleInTx: 0, checkedOut: 0 });
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });

  it("181-AC2d · a FOREIGN stored key is refused: StorageTenancyError, nothing parsed, a security event logged", async () => {
    const foreignKey = `${KEY_ENV}/${otherWorkspaceId}/2026/10/${randomUUID()}.json.gz`;
    await s3.put({ bucket: "raw", key: foreignKey, body: encodeRawObject({ format: "markdown", text: "other tenant's answer about HubSpot" }) });
    const resultId = await seedCapture({ storedKey: foreignKey });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await expect(parse(resultId)).rejects.toBeInstanceOf(StorageTenancyError);
      expect(warn.mock.calls.some((call) => JSON.stringify(call).includes("raw_object_tenancy_refused"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(await facts(resultId)).toEqual([]);
    expect((await db.query("SELECT status FROM answer_captures WHERE id = $1", [resultId])).rows[0]).toEqual({ status: "captured" });
  });

  it("181-AC2e · a key that points at a MISSING object fails the parse (retried), it is never read as an empty answer", async () => {
    const missing = `${KEY_ENV}/${workspaceId}/2026/10/${randomUUID()}.json.gz`;
    const resultId = await seedCapture({ storedKey: missing });
    await expect(parse(resultId)).rejects.toThrow();
    expect(await facts(resultId)).toEqual([]);
    expect((await db.query("SELECT status FROM answer_captures WHERE id = $1", [resultId])).rows[0]).toEqual({ status: "captured" });
  });

  it("181-AC2f · a CORRUPT object (not gzip JSON) fails the parse", async () => {
    const id = randomUUID();
    const key = `${KEY_ENV}/${workspaceId}/2026/10/${id}.json.gz`;
    await s3.put({ bucket: "raw", key, body: "plain text, not gzip" });
    const resultId = await seedCapture({ storedKey: key });
    await expect(parse(resultId)).rejects.toThrow(/corrupt/);
    expect(await facts(resultId)).toEqual([]);
  });

  // ----------------------------------------------------------- AC4: the download

  /** As `nominara_app`, so RLS is live: the superuser would see every tenant's rows and make the isolation half vacuous. */
  async function download<T>(fn: (service: RawDownloadService) => Promise<T>, ws = workspaceId): Promise<T> {
    const service = new RawDownloadService(new TenantObjectStore(s3, KEY_ENV));
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId: ws, actorId: randomUUID() }, () => fn(service));
    } finally {
      client.release();
    }
  }

  it("181-AC4a · answers with a URL that expires in 60 seconds and serves the stored object", async () => {
    const resultId = await seedCapture({ objectText: ANSWER });
    const { url } = await download((s) => s.signedUrl(resultId));
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect((JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8")) as { text: string }).text).toBe(ANSWER);
  });

  it("181-AC4b · a stored key outside the caller's workspace is refused with StorageTenancyError, and no URL is minted", async () => {
    const foreignKey = `${KEY_ENV}/${otherWorkspaceId}/2026/10/${randomUUID()}.json.gz`;
    const resultId = await seedCapture({ storedKey: foreignKey });
    await expect(download((s) => s.signedUrl(resultId))).rejects.toBeInstanceOf(StorageTenancyError);
  });

  it("181-AC4c · a capture past the plan's raw retention is 507 retention_exceeded, even if the key is still set", async () => {
    // growth keeps raw captures 180 days.
    const old = new Date(Date.now() - 181 * 86_400_000);
    const resultId = await seedCapture({ objectText: ANSWER, capturedAt: old });
    await expect(download((s) => s.signedUrl(resultId))).rejects.toBeInstanceOf(RetentionExceededError);
  });

  it("181-AC4d · a capture just inside retention is served", async () => {
    const recent = new Date(Date.now() - 179 * 86_400_000);
    const resultId = await seedCapture({ objectText: ANSWER, capturedAt: recent });
    await expect(download((s) => s.signedUrl(resultId))).resolves.toMatchObject({ url: expect.any(String) });
  });

  it("181-AC4e · a row the retention sweep expired (key nulled, payload.raw_expired) is 507, not 404", async () => {
    const resultId = await seedCapture({ objectText: null });
    await db.query(`UPDATE answer_captures SET payload = jsonb_set(payload, '{raw_expired}', 'true'::jsonb) WHERE id = $1`, [resultId]);
    await expect(download((s) => s.signedUrl(resultId))).rejects.toBeInstanceOf(RetentionExceededError);
  });

  it("181-AC4g · a reused (L2) row is never pointed at its source's object, whether or not the source has expired", async () => {
    const source = await seedCapture({ objectText: ANSWER, capturedAt: new Date(Date.now() - 400 * 86_400_000) });
    const reused = await seedCapture({ objectText: null });
    await db.query(`UPDATE answer_captures SET cache_layer = 'l2', source_result_id = $2 WHERE id = $1`, [reused, source]);
    await expect(download((s) => s.signedUrl(reused))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("181-AC3b · a LEGACY row with no object is 404 not_found (nothing to redirect to)", async () => {
    const resultId = await seedCapture({ objectText: null });
    await expect(download((s) => s.signedUrl(resultId))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("181-AC4f · an unknown id is 404, and another workspace's result is invisible (RLS)", async () => {
    await expect(download((s) => s.signedUrl(randomUUID()))).rejects.toBeInstanceOf(NotFoundError);
    const resultId = await seedCapture({ objectText: ANSWER });
    await expect(download((s) => s.signedUrl(resultId), otherWorkspaceId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
