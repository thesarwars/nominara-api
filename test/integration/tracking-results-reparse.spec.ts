import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reparseResponseSchema, resultsListQuerySchema, type ResultsListQuery } from "../../contracts/tracking/index.js";
import {
  ConflictError,
  NotFoundError,
  PreconditionUnmetError,
  RetentionExceededError,
  ValidationFailedError,
} from "../../src/api/errors/domain-errors.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { encodeRawObject, rawObjectRelativeKey } from "../../src/lib/capture/raw-object.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { S3Adapter } from "../../src/lib/storage/s3.adapter.js";
import { resolveStorageConfig } from "../../src/lib/storage/storage-config.js";
import { StorageTenancyError } from "../../src/lib/storage/storage-keys.js";
import type { ObjectStoragePort } from "../../src/lib/storage/storage.port.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import type { DirtyEntry } from "../../src/lib/rollup/dirty-dates.js";
import { ReparseService } from "../../src/modules/tracking/reparse.service.js";
import { rawRetentionCutoff } from "../../src/modules/tracking/raw-retention.js";
import { ResultDocumentService } from "../../src/modules/tracking/result-document.service.js";
import { ResultsListService } from "../../src/modules/tracking/results-list.service.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { currentTenantStore, withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-034 - the remaining read/maintenance ACs: AC7 (the cursor list), AC9 (re-parse with a diff, free) and AC10 (retention
// failure, not an empty result). Run under the shared docker lock.
//
// Every request-path call below runs as `nominara_app` (RLS live) through `withTenantContext`, which is what the
// TenantContextInterceptor does around a handler. The superuser would see every tenant's rows and make the isolation checks vacuous.

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
const exporter = new InMemorySpanExporter();

const ANSWER = "## Best CRMs\n\n1. **HubSpot** - we recommend it for most teams.\n2. Salesforce - deeper reporting, however it has a steep learning curve.\n";
const TAMPERED = "Zoho CRM is the only thing worth buying.";
const KEY_ENV = "inttest";
const DAY = 86_400_000;

describe("STORY-034 · results list, re-parse and retention", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let siblingProjectId: string;
  let otherProjectId: string;
  let promptId: string;
  let competitorId: string;
  let marks: DirtyEntry[];
  let localstack: LocalstackFixture;
  let s3: S3Adapter;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    localstack = await startLocalstack();
    const config = resolveStorageConfig({
      NODE_ENV: "test",
      STORAGE_ENDPOINT: localstack.endpoint,
      STORAGE_BUCKET_RAW: "nominara-raw",
      STORAGE_BUCKET_REPORTS: "nominara-reports",
      STORAGE_ACCESS_KEY_ID: "test",
      STORAGE_SECRET_ACCESS_KEY: "test",
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_SSE: "AES256",
      STORAGE_KEY_ENV: KEY_ENV,
    } as never);
    if (config === null) throw new Error("storage config unexpectedly null");
    s3 = new S3Adapter(config);
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 6 });
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    await localstack?.stop();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, credit_ledger, credit_wallets, workspaces CASCADE");
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    projectId = randomUUID();
    siblingProjectId = randomUUID();
    otherProjectId = randomUUID();
    promptId = randomUUID();
    competitorId = randomUUID();
    marks = [];
    counters.length = 0;
    exporter.reset();
    for (const [id, plan] of [[workspaceId, "growth"], [otherWorkspaceId, "growth"]] as const) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,$3,'UTC')", [id, `w-${randomUUID().slice(0, 8)}`, plan]);
    }
    for (const [id, ws] of [[projectId, workspaceId], [siblingProjectId, workspaceId], [otherProjectId, otherWorkspaceId]] as const) {
      await db.query(
        `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, owned_domains, brand_aliases)
         VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com',ARRAY[]::text[],ARRAY[]::text[])`,
        [id, ws, `p-${randomUUID().slice(0, 8)}`],
      );
    }
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1,$2,$3,'Salesforce','salesforce.com',ARRAY[]::text[],'user')`,
      [competitorId, workspaceId, projectId],
    );
    for (const [ws, project] of [[workspaceId, projectId], [workspaceId, siblingProjectId], [otherWorkspaceId, otherProjectId]] as const) {
      const id = project === projectId ? promptId : randomUUID();
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
         VALUES ($1,$2,$3,'best crm',sha256('best crm'::bytea),'recommendation','consideration',false,'active')`,
        [id, ws, project],
      );
    }
  });

  // ---------------------------------------------------------------- helpers

  const dirtyMarker = (entry: DirtyEntry): Promise<void> => {
    marks.push(entry);
    return Promise.resolve();
  };
  const reparseService = (port: ObjectStoragePort = s3): ReparseService => new ReparseService(dirtyMarker, pool, new TenantObjectStore(port, KEY_ENV));

  async function as<T>(fn: () => Promise<T>, over: { ws?: string; scope?: string[] } = {}): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(
        client,
        { workspaceId: over.ws ?? workspaceId, actorId: randomUUID(), ...(over.scope !== undefined ? { scopeProjectIds: over.scope } : {}) },
        fn,
      );
    } finally {
      client.release();
    }
  }

  /**
   * What the route does: `ReparseGuard` calls `prefetchSource` BEFORE any request transaction exists, then the handler's transaction
   * (the interceptor's `withTenantContext`) runs `reparse` with what the guard read.
   */
  async function reparseViaRoute(id: string, ctx: { ws?: string; scope?: string[]; port?: ObjectStoragePort } = {}) {
    const service = reparseService(ctx.port);
    const source = await service.prefetchSource(
      { workspaceId: ctx.ws ?? workspaceId, actorId: randomUUID(), ...(ctx.scope !== undefined ? { scopeProjectIds: ctx.scope } : {}) },
      id,
    );
    return as(() => service.reparse(id, source), ctx);
  }

  /** Writes an object for a capture (as the capture worker does) and returns its stored key. */
  async function putObject(resultId: string, capturedAt: Date, text: string, extra: Record<string, unknown> = {}): Promise<string> {
    const store = new TenantObjectStore(s3, KEY_ENV);
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
      store.put("raw", rawObjectRelativeKey(capturedAt, resultId), encodeRawObject({ format: "markdown", text, ...extra })),
    );
  }

  /** A port that records every call, so a test can say what was (not) read and when. */
  const spyingPort = (calls: string[], onGet?: () => Promise<void>): ObjectStoragePort => ({
    put: s3.put.bind(s3),
    head: s3.head.bind(s3),
    delete: s3.delete.bind(s3),
    presignGet: s3.presignGet.bind(s3),
    get: async (bucket, key) => {
      calls.push("get");
      await onGet?.();
      return s3.get(bucket, key);
    },
  });

  const query = (over: Record<string, unknown> = {}): ResultsListQuery => resultsListQuerySchema.parse(over);
  const list = (project: string, over: Record<string, unknown> = {}, ctx: { ws?: string; scope?: string[] } = {}) =>
    as(() => new ResultsListService().list(project, query(over)), ctx);

  interface SeedOptions {
    id?: string;
    project?: string;
    ws?: string;
    prompt?: string;
    text?: string;
    capturedAt?: Date;
    status?: string;
    engine?: string;
    errorCode?: string | null;
    runId?: string;
    cacheLayer?: string;
    payloadExtra?: Record<string, unknown>;
    rawObjectKey?: string | null;
  }
  async function seed(opts: SeedOptions = {}): Promise<string> {
    const id = opts.id ?? randomUUID();
    const text = opts.text ?? ANSWER;
    const failed = opts.status === "failed" || opts.status === "blocked";
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version,
          content_hash, response_excerpt, payload, raw_object_key, flags, cache_layer, status, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'api','1.0.0','n0',$8,$9,$10::jsonb,$11,'{}',$12,$13,$14)`,
      [
        id,
        opts.ws ?? workspaceId,
        opts.project ?? projectId,
        opts.runId ?? uuidV7(),
        opts.prompt ?? ((opts.project ?? projectId) === projectId ? promptId : randomUUID()),
        opts.engine ?? "gemini",
        opts.capturedAt ?? new Date(),
        createHash("sha256").update(text, "utf8").digest(),
        failed ? null : text.slice(0, 280),
        failed ? "{}" : JSON.stringify({ format: "markdown", text, ...(opts.payloadExtra ?? {}) }),
        opts.rawObjectKey ?? null,
        opts.cacheLayer ?? "live",
        opts.status ?? "captured",
        opts.errorCode ?? (failed ? "rate_limited" : null),
      ],
    );
    return id;
  }

  async function seedStaleFacts(resultId: string): Promise<void> {
    // What an OLDER parser left behind: the brand only, neutral, no competitor, no position.
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_id,entity_label,matched_alias,
          occurrence_index,char_start,char_end,first_token_index,prominence,sentiment_label,sentiment_score,sentiment_confidence,
          sentiment_method,evidence_start,evidence_end,negative_reasons,render_form,render_attrs,render_score,position_class,answer_form,scoring_version)
       SELECT workspace_id, project_id, id, prompt_id, engine_key, captured_at, 'brand', NULL, 'HubSpot','HubSpot',0,0,7,0,0.1,'neutral',0,0.5,'lexicon',0,7,
              '{}','described','{}',0.1,'neutral_list','narrative','v0'
         FROM answer_captures WHERE id = $1`,
      [resultId],
    );
    await db.query(
      `UPDATE answer_captures SET status='parsed', brand_present=true, brand_rank_position=NULL, sov=1, sentiment_label='neutral', sentiment_score=0,
              citation_count=0, owned_citation_count=0, scoring_version='v0' WHERE id = $1`,
      [resultId],
    );
  }

  const factRows = async (resultId: string) =>
    (await db.query("SELECT entity_type, entity_label, char_start, char_end, sentiment_label FROM mention_facts WHERE result_id = $1 ORDER BY char_start, entity_type", [resultId])).rows;
  const captureRow = async (resultId: string) =>
    (await db.query("SELECT status, brand_present, normalizer_version, scoring_version, citation_count FROM answer_captures WHERE id = $1", [resultId])).rows[0];

  // ------------------------------------------------------- AC7: the cursor list

  it("034-AC7a · pages newest first by cursor with no gap and no repeat, including captures that share a timestamp", async () => {
    const same = new Date(Date.now() - 3600_000);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seed({ capturedAt: i < 3 ? same : new Date(same.getTime() - (i + 1) * 1000) }));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await list(projectId, { limit: "2", ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.result_id));
      expect(page.pagination.limit).toBe(2);
      if (!page.pagination.has_more) {
        expect(page.pagination.cursor_next).toBeNull();
        break;
      }
      cursor = page.pagination.cursor_next!;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it("034-AC7b · an empty project is an empty page with no cursor, not an error", async () => {
    const page = await list(projectId);
    expect(page.items).toEqual([]);
    expect(page.pagination).toMatchObject({ cursor_next: null, has_more: false });
  });

  it("034-AC7c · scoped to the project in the path: a sibling project's captures never appear", async () => {
    const mine = await seed();
    await seed({ project: siblingProjectId });
    expect((await list(projectId)).items.map((i) => i.result_id)).toEqual([mine]);
  });

  it("034-AC7d · another workspace's project is 404 (RLS), never its captures", async () => {
    await seed({ ws: otherWorkspaceId, project: otherProjectId });
    await expect(list(otherProjectId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("034-AC7e · a member scoped to another project is refused with the scope 403, not an empty list", async () => {
    await seed();
    await expect(list(projectId, {}, { scope: [siblingProjectId] })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
  });

  it("034-AC7f · a cell that could not be captured is LISTED with its status and error code, and a null presence (not false)", async () => {
    const failed = await seed({ status: "failed", errorCode: "rate_limited", engine: "perplexity" });
    const page = await list(projectId);
    expect(page.items.find((i) => i.result_id === failed)).toMatchObject({
      status: "failed",
      error_code: "rate_limited",
      brand_present: null,
      response_excerpt: null,
      citation_count: 0,
    });
  });

  it("034-AC7g · filters by engine, status, prompt and run", async () => {
    const run = uuidV7();
    const a = await seed({ engine: "gemini", runId: run });
    await seed({ engine: "perplexity" });
    await seed({ status: "failed", engine: "gemini" });
    expect((await list(projectId, { engine_key: "gemini", status: "captured" })).items.map((i) => i.result_id)).toEqual([a]);
    expect((await list(projectId, { run_id: run })).items.map((i) => i.result_id)).toEqual([a]);
    expect((await list(projectId, { prompt_id: randomUUID() })).items).toEqual([]);
  });

  it("034-AC7h · a cursor issued for another list is a 400, never a silent first page", async () => {
    await seed();
    await expect(list(projectId, { cursor: "bm90LWEtY3Vyc29y" })).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("034-AC7i · returns the 280-character excerpt, not the whole answer", async () => {
    await seed({ text: "x".repeat(2000) });
    const [item] = (await list(projectId)).items;
    expect(item!.response_excerpt).toHaveLength(280);
  });

  // ---------------------------------------------------- AC10: retention failure

  it("034-AC10a · a window that starts before the plan's raw-capture retention is 507 retention_exceeded, not an empty page", async () => {
    await seed();
    const past = new Date(Date.now() - 181 * DAY).toISOString(); // growth keeps 180 days
    await expect(list(projectId, { from: past })).rejects.toBeInstanceOf(RetentionExceededError);
  });

  it("034-AC10b · a window inside retention is served, and one that opens exactly at the boundary is not refused", async () => {
    const id = await seed({ capturedAt: new Date(Date.now() - 10 * DAY) });
    expect((await list(projectId, { from: new Date(Date.now() - 179 * DAY).toISOString() })).items.map((i) => i.result_id)).toEqual([id]);
  });

  it("034-AC10c · with no window the list opens at the retention boundary: a capture past it is not listed", async () => {
    const fresh = await seed({ capturedAt: new Date(Date.now() - 10 * DAY) });
    await seed({ capturedAt: new Date(Date.now() - 200 * DAY) });
    expect((await list(projectId)).items.map((i) => i.result_id)).toEqual([fresh]);
  });

  it("034-AC10f · a window that ENDS before the retention boundary is 507 even with no `from`, not an empty page", async () => {
    await seed({ capturedAt: new Date(Date.now() - 10 * DAY) });
    const before = new Date(Date.now() - 200 * DAY).toISOString(); // growth keeps 180 days
    await expect(list(projectId, { to: before })).rejects.toBeInstanceOf(RetentionExceededError);
    // an upper bound inside the window is still served
    expect((await list(projectId, { to: new Date(Date.now() + DAY).toISOString() })).items).toHaveLength(1);
  });

  it("034-AC10g · run_id of a run whose captures are all past retention is 507, not an empty page; a recent or unknown run is not", async () => {
    const oldRun = uuidV7();
    const recentRun = uuidV7();
    await seed({ runId: oldRun, capturedAt: new Date(Date.now() - 200 * DAY) });
    await seed({ runId: recentRun, capturedAt: new Date(Date.now() - 5 * DAY) });
    await expect(list(projectId, { run_id: oldRun })).rejects.toBeInstanceOf(RetentionExceededError);
    expect((await list(projectId, { run_id: recentRun })).items).toHaveLength(1);
    expect((await list(projectId, { run_id: uuidV7() })).items).toEqual([]); // a run with no captures is "nothing yet", not "expired"
  });

  // Owner decision 100(f) (2026-11-12) replaced the 507 on THIS route only: past the window the document is served with its facts and excerpt, no raw
  // text, and `raw_expired: true`. /raw, /reparse and the list stay 507 (034-AC9j, 034-AC10a/f/g, 181-AC4c/e).
  it("034-AC10d · the result document past retention is served WITHOUT its text and says raw_expired, and inside it is served whole with raw_expired false", async () => {
    const old = await seed({ status: "parsed", capturedAt: new Date(Date.now() - 200 * DAY) });
    const recent = await seed({ status: "parsed", capturedAt: new Date(Date.now() - 5 * DAY) });
    const expired = await as(() => new ResultDocumentService().get(old));
    expect(expired).toMatchObject({ result_id: old, raw_expired: true });
    expect(expired.raw_response.text).toBe("");
    expect(expired.raw_response.excerpt).toBe(ANSWER.slice(0, 280));
    expect(expired.highlight_map).toEqual([]);
    const fresh = await as(() => new ResultDocumentService().get(recent));
    expect(fresh).toMatchObject({ result_id: recent, raw_expired: false });
    expect(fresh.raw_response.text).toContain("HubSpot");
    expect(fresh.raw_response.excerpt).toBeUndefined();
  });

  it("034-AC10d · the boundary: a capture one second inside the window is whole, one second past it is raw_expired (the cutoff the sweep and /raw use)", async () => {
    const cutoff = (await as(() => rawRetentionCutoff(currentTenantStore()!.client, workspaceId)))!;
    expect(cutoff).toBeInstanceOf(Date);
    const inside = await seed({ status: "parsed", capturedAt: new Date(cutoff.getTime() + 5_000) });
    const past = await seed({ status: "parsed", capturedAt: new Date(cutoff.getTime() - 5_000) });
    expect((await as(() => new ResultDocumentService().get(inside))).raw_expired).toBe(false);
    expect((await as(() => new ResultDocumentService().get(past))).raw_expired).toBe(true);
  });

  it("034-AC10d · past the window the FACTS are kept: entities and citations still come back, only the text and its offsets go", async () => {
    const id = await seed({ status: "parsed", capturedAt: new Date(Date.now() - 200 * DAY) });
    await seedStaleFacts(id);
    const doc = await as(() => new ResultDocumentService().get(id));
    expect(doc.raw_expired).toBe(true);
    expect(doc.entities.length).toBeGreaterThan(0);
    expect(doc.metrics.brand_present).toBe(true);
    expect(doc.highlight_map).toEqual([]);
    expect(doc.capture.response_chars).toBe(0);
  });

  it("034-AC10d · an expired document is still tenant-checked: another workspace's capture is 404, never its excerpt", async () => {
    const id = await seed({ ws: otherWorkspaceId, project: otherProjectId, status: "parsed", capturedAt: new Date(Date.now() - 200 * DAY) });
    await expect(as(() => new ResultDocumentService().get(id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("034-AC10d · a cell that was never captured is still 422 past the window (there is no document to expire)", async () => {
    const id = await seed({ status: "failed", capturedAt: new Date(Date.now() - 200 * DAY) });
    await expect(as(() => new ResultDocumentService().get(id))).rejects.toBeInstanceOf(PreconditionUnmetError);
  });

  it("034-AC10e · a capture the retention sweep already expired (payload.raw_expired) is served as raw_expired too, even inside the window", async () => {
    const id = await seed({ status: "parsed", payloadExtra: { raw_expired: true } });
    const doc = await as(() => new ResultDocumentService().get(id));
    expect(doc.raw_expired).toBe(true);
    expect(doc.raw_response.text).toBe("");
  });

  // ---------------------------------------------------------- AC9: re-parse

  it("034-AC9a · re-parses a stored capture, SAVES the facts, and returns the before and after", async () => {
    const id = await seed();
    const result = await as(() => reparseService().reparse(id));

    expect(reparseResponseSchema.safeParse(result).success).toBe(true);
    expect(result.result_id).toBe(id);
    expect(result.before).toMatchObject({ brand_present: null, share_of_voice: null, citation_count: 0, entities: [] });
    expect(result.after.brand_present).toBe(true);
    expect(result.after.entities.map((e) => e.label)).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
    expect(result.changed).toBe(true);
    // SAVED, not a dry run.
    expect((await captureRow(id)).status).toBe("parsed");
    expect((await factRows(id)).map((r) => r.entity_label)).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
  });

  it("034-AC9b · the diff shows what the stale facts got wrong, and the stale rows are REPLACED, not added to", async () => {
    const id = await seed();
    await seedStaleFacts(id);
    const result = await as(() => reparseService().reparse(id));

    expect(result.before.scoring_version).toBe("v0");
    expect(result.before.entities.map((e) => e.label)).toEqual(["HubSpot"]);
    expect(result.after.entities.map((e) => e.label)).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
    expect(result.after.scoring_version).toBe(result.scoring_version);
    expect(result.changed).toBe(true);
    const rows = await factRows(id);
    expect(rows.filter((r) => r.entity_label === "HubSpot")).toHaveLength(1);
  });

  it("034-AC9c · a second re-parse of an unchanged capture changes nothing: changed false, identical snapshots, no duplicate rows", async () => {
    const id = await seed();
    await as(() => reparseService().reparse(id));
    const rowsAfterFirst = await factRows(id);
    const second = await as(() => reparseService().reparse(id));
    expect(second.changed).toBe(false);
    expect(second.after).toEqual(second.before);
    expect(await factRows(id)).toEqual(rowsAfterFirst);
  });

  it("034-AC9d · charges NOTHING: no credit ledger row, no wallet row, before or after", async () => {
    const id = await seed();
    const before = (await db.query("SELECT (SELECT count(*) FROM credit_ledger) AS l, (SELECT count(*) FROM credit_wallets) AS w")).rows[0];
    await as(() => reparseService().reparse(id));
    await as(() => reparseService().reparse(id));
    expect((await db.query("SELECT (SELECT count(*) FROM credit_ledger) AS l, (SELECT count(*) FROM credit_wallets) AS w")).rows[0]).toEqual(before);
    expect(before).toEqual({ l: "0", w: "0" });
  });

  it("034-AC9e · marks the capture's workspace-local date dirty AFTER commit, for a closed day and for today", async () => {
    const closed = new Date(Date.now() - 3 * DAY);
    const idClosed = await seed({ capturedAt: closed });
    const idToday = await seed({ capturedAt: new Date() });
    await as(() => reparseService().reparse(idClosed));
    await as(() => reparseService().reparse(idToday));
    await vi.waitFor(() => expect(marks).toHaveLength(2));
    const day = (d: Date) => d.toISOString().slice(0, 10);
    expect(marks).toEqual([
      { workspaceId, projectId, metricDate: day(closed) },
      { workspaceId, projectId, metricDate: day(new Date()) },
    ]);
  });

  it("034-AC9f · a re-parse whose transaction rolls back writes no facts and marks no date", async () => {
    const id = await seed();
    await expect(
      as(async () => {
        await reparseService().reparse(id);
        throw new Error("something later in the request failed");
      }),
    ).rejects.toThrow("something later");
    expect((await captureRow(id)).status).toBe("captured");
    expect(await factRows(id)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(marks).toEqual([]);
  });

  it("034-AC9g · a member scoped to another project is refused with the scope 403 and nothing is written", async () => {
    const id = await seed();
    await expect(as(() => reparseService().reparse(id), { scope: [siblingProjectId] })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect((await captureRow(id)).status).toBe("captured");
  });

  it("034-AC9h · another workspace's result and an unknown id are 404", async () => {
    const foreign = await seed({ ws: otherWorkspaceId, project: otherProjectId });
    await expect(as(() => reparseService().reparse(foreign))).rejects.toBeInstanceOf(NotFoundError);
    await expect(as(() => reparseService().reparse(randomUUID()))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("034-AC9i · a cell that was not captured, or captured no text, has nothing to re-parse: 422 precondition_unmet", async () => {
    const failed = await seed({ status: "failed" });
    const refusal = await seed({ text: "" });
    await expect(as(() => reparseService().reparse(failed))).rejects.toBeInstanceOf(PreconditionUnmetError);
    await expect(as(() => reparseService().reparse(refusal))).rejects.toBeInstanceOf(PreconditionUnmetError);
    expect(await factRows(failed)).toEqual([]);
  });

  it("034-AC9j · a capture past the plan's raw retention is 507 and its facts are left alone", async () => {
    const id = await seed({ capturedAt: new Date(Date.now() - 200 * DAY) });
    await seedStaleFacts(id);
    await expect(as(() => reparseService().reparse(id))).rejects.toBeInstanceOf(RetentionExceededError);
    expect((await factRows(id)).map((r) => r.entity_label)).toEqual(["HubSpot"]);
  });

  it("034-AC9k · keeps the citation resolutions already recorded (status and resolved_at) and makes NO network call", async () => {
    const url = "https://www.g2.com/categories/crm";
    const resolvedAt = new Date("2026-10-01T10:00:00.000Z");
    const id = await seed({ text: `${ANSWER}\nSee ${url} for details.\n` });
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,slot_index,raw_url,normalized_url,url_hash,domain,path,
          is_owned,is_competitor,source_class,http_status,resolved_at,position_weight)
       SELECT workspace_id, project_id, id, prompt_id, engine_key, captured_at, 0, $2::text, $2::text, sha256(convert_to($2::text, 'UTF8')), 'g2.com','/categories/crm',
              false,false,'review_marketplace',200,$3::timestamptz,1 FROM answer_captures WHERE id = $1`,
      [id, url, resolvedAt],
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = await as(() => reparseService().reparse(id));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.after.citation_count).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
    const [row] = (await db.query("SELECT http_status, resolved_at FROM citation_facts WHERE result_id = $1", [id])).rows;
    expect(row.http_status).toBe(200);
    expect(new Date(row.resolved_at).toISOString()).toBe(resolvedAt.toISOString());
  });

  it("034-AC9l · two re-parses at once leave one coherent fact set (serialised on the capture row)", async () => {
    const id = await seed();
    await Promise.all([as(() => reparseService().reparse(id)), as(() => reparseService().reparse(id))]);
    const rows = await factRows(id);
    expect(rows.filter((r) => r.entity_label === "HubSpot")).toHaveLength(1);
    expect(rows.filter((r) => r.entity_label === "Salesforce")).toHaveLength(1);
  });

  it("034-AC9m · a reused (skipped) row keeps its status: facts are re-derived, the run's accounting is not disturbed", async () => {
    const id = await seed({ status: "skipped", cacheLayer: "l1" });
    await as(() => reparseService().reparse(id));
    expect((await captureRow(id)).status).toBe("skipped");
    expect((await factRows(id)).length).toBeGreaterThan(0);
  });

  // ---- AC9 + tracking-engine.md section 8: the re-parse reads the STORED RAW OBJECT, outside any transaction (round 3, finding 3)

  /** A capture whose object says one thing and whose dual-written payload says another. */
  async function seedDivergent(): Promise<string> {
    const id = randomUUID();
    const capturedAt = new Date();
    const key = await putObject(id, capturedAt, ANSWER);
    await seed({ id, capturedAt, text: TAMPERED, rawObjectKey: key });
    return id;
  }

  it("034-AC9n · parses the stored OBJECT, not the dual-written payload: facts follow the object's text when the two diverge", async () => {
    const id = await seedDivergent();
    await reparseViaRoute(id);

    const labels = (await factRows(id)).map((r) => r.entity_label);
    expect(labels).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
    expect(labels).not.toContain("Zoho CRM");
  });

  it("034-AC9n2 · the object's structured citations are used too, not the payload's", async () => {
    const id = randomUUID();
    const capturedAt = new Date();
    const key = await putObject(id, capturedAt, ANSWER, { structured_citations: [{ url: "https://www.g2.com/categories/crm", slot: 1 }] });
    await seed({ id, capturedAt, rawObjectKey: key });
    const result = await reparseViaRoute(id);
    expect(result.after.citation_count).toBe(1);
  });

  it("034-AC9o · KAD-06: the object is read with NO transaction open and NO pooled client checked out", async () => {
    const id = await seedDivergent();
    const observed: { idleInTx: number; checkedOut: number }[] = [];
    const calls: string[] = [];
    const port = spyingPort(calls, async () => {
      const open = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'nominara_app' AND state LIKE 'idle in transaction%'",
      );
      observed.push({ idleInTx: Number(open.rows[0]!.n), checkedOut: pool.totalCount - pool.idleCount });
    });
    await reparseViaRoute(id, { port });

    expect(calls).toEqual(["get"]); // not vacuous: the read happened, once, and was observed
    expect(observed).toEqual([{ idleInTx: 0, checkedOut: 0 }]);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });

  it("034-AC9p · a LEGACY row (no object) is re-parsed from payload with no storage read at all", async () => {
    const id = await seed();
    const calls: string[] = [];
    const result = await reparseViaRoute(id, { port: spyingPort(calls) });
    expect(calls).toEqual([]);
    expect(result.after.entities.map((e) => e.label)).toEqual(expect.arrayContaining(["HubSpot", "Salesforce"]));
  });

  it("034-AC9q · the row's key moved between the read and the transaction: 409, nothing written", async () => {
    const id = await seedDivergent();
    const service = reparseService();
    const source = await service.prefetchSource({ workspaceId, actorId: randomUUID() }, id);
    await db.query("UPDATE answer_captures SET raw_object_key = raw_object_key || 'x' WHERE id = $1", [id]);
    await expect(as(() => service.reparse(id, source))).rejects.toBeInstanceOf(ConflictError);
    expect(await factRows(id)).toEqual([]);
    expect((await captureRow(id)).status).toBe("captured");
  });

  it("034-AC9r · a caller that bypasses the guard for a row WITH an object is refused: the transaction never reads storage itself", async () => {
    const id = await seedDivergent();
    const calls: string[] = [];
    await expect(as(() => reparseService(spyingPort(calls)).reparse(id))).rejects.toThrow(/prefetched raw object/);
    expect(calls).toEqual([]);
    expect(await factRows(id)).toEqual([]);
  });

  it("034-AC9s · a key pointing at a MISSING object is 422 precondition_unmet, never parsed as an empty answer", async () => {
    const id = randomUUID();
    const capturedAt = new Date();
    const ghost = `${KEY_ENV}/${workspaceId}/${String(capturedAt.getUTCFullYear())}/01/${randomUUID()}.json.gz`;
    await seed({ id, capturedAt, rawObjectKey: ghost });
    await expect(reparseViaRoute(id)).rejects.toBeInstanceOf(PreconditionUnmetError);
    expect(await factRows(id)).toEqual([]);
  });

  it("034-AC9t · a FOREIGN stored key is refused (StorageTenancyError) and nothing is parsed", async () => {
    const id = randomUUID();
    const foreign = `${KEY_ENV}/${otherWorkspaceId}/2026/10/${randomUUID()}.json.gz`;
    await s3.put({ bucket: "raw", key: foreign, body: encodeRawObject({ format: "markdown", text: "other tenant's HubSpot answer" }) });
    await seed({ id, rawObjectKey: foreign });
    await expect(reparseViaRoute(id)).rejects.toBeInstanceOf(StorageTenancyError);
    expect(await factRows(id)).toEqual([]);
  });

  it("034-AC9u · a request that will be refused costs no object read: out-of-scope and past-retention captures never reach storage", async () => {
    const calls: string[] = [];
    const inScope = await seedDivergent();
    await expect(reparseViaRoute(inScope, { port: spyingPort(calls), scope: [siblingProjectId] })).rejects.toBeInstanceOf(ProjectOutOfScopeException);

    const oldId = randomUUID();
    const oldAt = new Date(Date.now() - 200 * DAY);
    await seed({ id: oldId, capturedAt: oldAt, rawObjectKey: await putObject(oldId, oldAt, ANSWER) });
    await expect(reparseViaRoute(oldId, { port: spyingPort(calls) })).rejects.toBeInstanceOf(RetentionExceededError);
    expect(calls).toEqual([]);
  });

  it("034-OBS1 · observability: a span, a counter and a log line per re-parse - IDs and counts only, never an entity label or the answer", async () => {
    const id = await seed();
    const lines: string[] = [];
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      lines.push(typeof message === "string" ? message : JSON.stringify(message));
    });
    try {
      await as(() => reparseService().reparse(id));
    } finally {
      log.mockRestore();
    }
    const [span] = exporter.getFinishedSpans().filter((x) => x.name === "tracking.reparse");
    expect(span!.attributes).toMatchObject({ "nominara.tracking.reparse.changed": true });
    expect(counters).toContainEqual({ name: "nominara_tracking_reparse_total", labels: { outcome: "changed" } });
    const line = lines.find((l) => l.includes("tracking.reparse"))!;
    expect(line).toContain(workspaceId);
    expect(line).toContain(id);
    for (const secret of ["HubSpot", "Salesforce", "recommend"]) expect(line).not.toContain(secret);
  });

  it("034-OBS2 · a refusal past retention is counted by surface, and a failed re-parse marks its span as an error", async () => {
    const id = await seed({ capturedAt: new Date(Date.now() - 200 * DAY) });
    await expect(as(() => reparseService().reparse(id))).rejects.toBeInstanceOf(RetentionExceededError);
    expect(counters).toContainEqual({ name: "nominara_tracking_retention_exceeded_total", labels: { surface: "reparse" } });
    const [span] = exporter.getFinishedSpans().filter((x) => x.name === "tracking.reparse");
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});
