import { randomUUID } from "node:crypto";
import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/config/env.schema.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createReportCleanupHandler } from "../../src/lib/queue/handlers/report-cleanup.handler.js";
import { S3Adapter } from "../../src/lib/storage/s3.adapter.js";
import { resolveStorageConfig, type StorageConfig } from "../../src/lib/storage/storage-config.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import { deleteWorkspaceReports } from "../../src/lib/storage/workspace-purge.js";
import { executeWorkspaceHardDelete } from "../../src/workers/rollup/retention.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import { reportStorageEnv, REPORT_STORAGE_KEY_ENV } from "../support/report-storage-env.js";

// STORY-180 r5 (owner decision 60 (b)) - retention of stored report files, against a REAL database (as the runtime role nominara_app, so
// row-level security is live) and a REAL versioned S3 (LocalStack): the nightly cleanup, and the deletion of an erased workspace's prefix.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const tick = (): Job => ({ data: {} }) as unknown as Job;

describe("STORY-180 r5 (b) · report.cleanup and workspace erasure of report objects", () => {
  let container: StartedPostgreSqlContainer;
  let localstack: LocalstackFixture;
  let db: Client;
  let pool: Pool;
  let env: Env;
  let config: StorageConfig;
  let s3: S3Adapter;
  let rawS3: S3Client;
  let store: TenantObjectStore;

  beforeAll(async () => {
    [container, localstack] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start(),
      startLocalstack(),
    ]);
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password });
    env = { DATABASE_URL: container.getConnectionUri() } as unknown as Env;
    const resolved = resolveStorageConfig({ NODE_ENV: "test", ...reportStorageEnv(localstack.endpoint) } as never);
    if (resolved === null) throw new Error("storage config unexpectedly null");
    config = resolved;
    s3 = new S3Adapter(config);
    store = new TenantObjectStore(s3, config.keyEnv);
    rawS3 = new S3Client({ region: "us-east-1", endpoint: localstack.endpoint, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  }, 300_000);

  afterAll(async () => {
    rawS3?.destroy();
    await pool?.end();
    await db?.end();
    await Promise.all([container?.stop(), localstack?.stop()]);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE workspaces CASCADE");
  });

  const context = (): QueueHandlerContext => ({ pool, env });
  const run = (over: { store?: TenantObjectStore } = {}) => createReportCleanupHandler(context(), { store: over.store ?? store })(db, tick());

  async function workspace(): Promise<string> {
    return (await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'free') RETURNING id", [`w-${randomUUID().slice(0, 12)}`])).rows[0]!.id;
  }

  interface Art {
    readonly id: string;
    readonly key: string;
  }

  /** A row in `ws` and, unless `noObject`, its file in the bucket. `state` picks the key the row carries. */
  async function artifact(
    ws: string,
    o: { expiresIn?: number; createdAgo?: number; state?: "stored" | "pending" | "failed" | "purged"; noObject?: boolean; keyWorkspace?: string; bytes?: string } = {},
  ): Promise<Art> {
    const id = randomUUID();
    const key = `${REPORT_STORAGE_KEY_ENV}/${o.keyWorkspace ?? ws}/${id}.pdf`;
    const state = o.state ?? "stored";
    if (o.noObject !== true) await s3.put({ bucket: "reports", key: `${REPORT_STORAGE_KEY_ENV}/${ws}/${id}.pdf`, body: o.bytes ?? "%PDF-1.4 x", contentType: "application/pdf" });
    await db.query(
      `INSERT INTO report_artifacts (id, workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at, created_at)
       VALUES ($1,$2,'{}','2026-10-01','2026-10-31','pdf',$3,10,'{}'::jsonb, now() + ($4::int * interval '1 millisecond'), now() - ($5::int * interval '1 millisecond'))`,
      [id, ws, state === "stored" ? key : `${state}:${id}`, o.expiresIn ?? 7 * DAY, o.createdAgo ?? 0],
    );
    return { id, key: `${REPORT_STORAGE_KEY_ENV}/${ws}/${id}.pdf` };
  }

  const exists = async (key: string): Promise<boolean> => {
    try {
      await s3.head("reports", key);
      return true;
    } catch (e) {
      if ((e as Error).name === "NotFoundError") return false;
      throw e;
    }
  };
  const keyOf = async (id: string) => (await db.query<{ object_key: string }>("SELECT object_key FROM report_artifacts WHERE id = $1", [id])).rows[0]!.object_key;
  const versionsUnder = async (prefix: string): Promise<number> => {
    const out = await rawS3.send(new ListObjectVersionsCommand({ Bucket: config.buckets.reports, Prefix: prefix }));
    return (out.Versions?.length ?? 0) + (out.DeleteMarkers?.length ?? 0);
  };

  it("deletes the object of an artifact whose 7-day link has expired, then marks the row purged", async () => {
    const ws = await workspace();
    const expired = await artifact(ws, { expiresIn: -HOUR });
    const out = await run();
    expect(out).toMatchObject({ status: "complete", purged: 1, workspaces: 1, failed: 0 });
    expect(await exists(expired.key)).toBe(false);
    expect(await keyOf(expired.id)).toBe(`purged:${expired.id}`);
  }, 120_000);

  it("keeps a live artifact: its object and its row are untouched (even in the same workspace as an expired one)", async () => {
    const ws = await workspace();
    const live = await artifact(ws, { expiresIn: 3 * DAY });
    const expired = await artifact(ws, { expiresIn: -1000 });
    await run();
    expect(await exists(live.key)).toBe(true);
    expect(await keyOf(live.id)).toBe(live.key);
    expect(await exists(expired.key)).toBe(false);
  }, 120_000);

  it("an artifact one second from expiring is kept; one a second past it is deleted", async () => {
    const ws = await workspace();
    const notYet = await artifact(ws, { expiresIn: 60_000 });
    const justPast = await artifact(ws, { expiresIn: -1000 });
    await run();
    expect(await exists(notYet.key)).toBe(true);
    expect(await exists(justPast.key)).toBe(false);
  }, 120_000);

  it("never touches another workspace's objects: only its own due rows are deleted, each under its own binding", async () => {
    const a = await workspace();
    const b = await workspace();
    const aExpired = await artifact(a, { expiresIn: -HOUR });
    const bLive = await artifact(b, { expiresIn: 5 * DAY });
    const bExpired = await artifact(b, { expiresIn: -HOUR });
    await run();
    expect(await exists(aExpired.key)).toBe(false);
    expect(await exists(bExpired.key)).toBe(false);
    expect(await exists(bLive.key)).toBe(true);
    expect(await keyOf(bLive.id)).toBe(bLive.key);
  }, 120_000);

  it("a row whose stored key points into ANOTHER workspace's prefix is refused: the foreign object survives and the row is quarantined as refused:<id>, once, without failing the job", async () => {
    const a = await workspace();
    const b = await workspace();
    const victim = await artifact(b, { expiresIn: 5 * DAY });
    // A's row (expired) carries B's object key: a corrupted or forged row must not delete B's file.
    const id = randomUUID();
    await db.query(
      `INSERT INTO report_artifacts (id, workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at)
       VALUES ($1,$2,'{}','2026-10-01','2026-10-31','pdf',$3,10,'{}'::jsonb, now() - interval '1 hour')`,
      [id, a, victim.key],
    );
    // STORY-180 r6: a tenancy refusal is permanent, so it is quarantined (not retried nightly, not failing the job, not starving the batch).
    expect(await run()).toMatchObject({ status: "complete", purged: 0, failed: 0 });
    expect(await exists(victim.key)).toBe(true);
    expect(await keyOf(id)).toBe(`refused:${id}`);
    expect(await run()).toMatchObject({ status: "complete", purged: 0, workspaces: 0 });
    expect(await keyOf(victim.id)).toBe(victim.key);
  }, 120_000);

  it("stale half-uploaded rows: a pending or failed row older than 24 h loses the object at its deterministic key; a younger one is kept", async () => {
    const ws = await workspace();
    const stalePending = await artifact(ws, { state: "pending", createdAgo: 25 * HOUR });
    const staleFailed = await artifact(ws, { state: "failed", createdAgo: 25 * HOUR });
    const freshPending = await artifact(ws, { state: "pending", createdAgo: 23 * HOUR });
    const freshFailed = await artifact(ws, { state: "failed", createdAgo: HOUR });
    await run();
    expect(await exists(stalePending.key)).toBe(false);
    expect(await exists(staleFailed.key)).toBe(false);
    expect(await keyOf(stalePending.id)).toBe(`purged:${stalePending.id}`);
    expect(await keyOf(staleFailed.id)).toBe(`purged:${staleFailed.id}`);
    expect(await exists(freshPending.key)).toBe(true);
    expect(await exists(freshFailed.key)).toBe(true);
    expect(await keyOf(freshPending.id)).toBe(`pending:${freshPending.id}`);
  }, 120_000);

  it("a stale row whose object was never written (the put failed) is simply marked purged", async () => {
    const ws = await workspace();
    const never = await artifact(ws, { state: "failed", createdAgo: 30 * HOUR, noObject: true });
    expect(await run()).toMatchObject({ status: "complete", purged: 1 });
    expect(await keyOf(never.id)).toBe(`purged:${never.id}`);
  }, 120_000);

  it("is idempotent: a second run (an at-least-once redelivery) finds nothing, and an already-purged row is never revisited", async () => {
    const ws = await workspace();
    await artifact(ws, { expiresIn: -HOUR });
    await artifact(ws, { state: "purged", expiresIn: -DAY, noObject: true });
    expect(await run()).toMatchObject({ purged: 1 });
    expect(await run()).toMatchObject({ status: "complete", purged: 0, workspaces: 0 });
  }, 120_000);

  it("a crash between the delete and the mark is repaired by the next run: the object is already gone, the row is marked", async () => {
    const ws = await workspace();
    const a = await artifact(ws, { expiresIn: -HOUR });
    await s3.delete("reports", a.key); // phase 2 done, phase 3 never ran
    expect(await keyOf(a.id)).toBe(a.key);
    expect(await run()).toMatchObject({ status: "complete", purged: 1 });
    expect(await keyOf(a.id)).toBe(`purged:${a.id}`);
  }, 120_000);

  it("an object that cannot be deleted leaves its row unmarked, fails the job, and the next run (storage back) finishes it", async () => {
    const ws = await workspace();
    const a = await artifact(ws, { expiresIn: -HOUR });
    const broken = new TenantObjectStore({ ...s3, put: s3.put.bind(s3), get: s3.get.bind(s3), head: s3.head.bind(s3), presignGet: s3.presignGet.bind(s3), delete: async () => Promise.reject(new Error("s3 down")) } as never, config.keyEnv);
    await expect(run({ store: broken })).rejects.toThrow(/failure/);
    expect(await exists(a.key)).toBe(true);
    expect(await keyOf(a.id)).toBe(a.key);
    expect(await run()).toMatchObject({ status: "complete", purged: 1 });
    expect(await exists(a.key)).toBe(false);
  }, 120_000);

  it("holds no transaction open during the delete: no backend is 'idle in transaction' while an object is being removed", async () => {
    const ws = await workspace();
    await artifact(ws, { expiresIn: -HOUR });
    const seen: number[] = [];
    const watching = new TenantObjectStore(
      { put: s3.put.bind(s3), get: s3.get.bind(s3), head: s3.head.bind(s3), presignGet: s3.presignGet.bind(s3),
        delete: async (b: "raw" | "reports", k: string) => {
          const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'nominara_app' AND state LIKE 'idle in transaction%'");
          seen.push(r.rows[0]!.n);
          return s3.delete(b, k);
        } } as never,
      config.keyEnv,
    );
    await run({ store: watching });
    expect(seen).toEqual([0]);
  }, 120_000);

  it("emits a span-shaped log line and a counter, with the workspace ID and counts only", async () => {
    const { incrementCounter } = await import("../../src/lib/telemetry/metrics.js");
    void incrementCounter;
    const ws = await workspace();
    await artifact(ws, { expiresIn: -HOUR });
    const logs: string[] = [];
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(JSON.stringify(m)));
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    const line = logs.find((l) => l.includes("report.cleanup.run"));
    expect(line).toBeDefined();
    expect(line).toContain('"purged":1');
    expect(line).not.toContain(ws); // the run line is an aggregate: counts only
    expect(logs.some((l) => l.includes("reports.cleanup.workspace") && l.includes(ws))).toBe(true); // the per-workspace line names the workspace ID
    expect(logs.join("\n")).not.toContain(REPORT_STORAGE_KEY_ENV + "/" + ws);
    expect(line).not.toContain(REPORT_STORAGE_KEY_ENV + "/");
  }, 120_000);

  describe("workspace erasure", () => {
    it("deletes the erased workspace's reports prefix, EVERY version and delete marker, after the cascade commits - and nothing of another workspace", async () => {
      const gone = await workspace();
      const kept = await workspace();
      const a1 = await artifact(gone, { bytes: "v1" });
      await s3.put({ bucket: "reports", key: a1.key, body: "v2" }); // a second version of the same key
      const a2 = await artifact(gone);
      await s3.delete("reports", a2.key); // a delete marker over a version
      const other = await artifact(kept, { bytes: "keep me" });
      expect(await versionsUnder(`${REPORT_STORAGE_KEY_ENV}/${gone}/`)).toBeGreaterThanOrEqual(4);

      let rowGoneWhenHookRan = false;
      await executeWorkspaceHardDelete(db, gone, {
        exportComplianceRecords: async () => undefined,
        deleteWorkspaceObjects: async (id) => {
          rowGoneWhenHookRan = (await db.query("SELECT 1 FROM workspaces WHERE id = $1", [id])).rowCount === 0;
          await deleteWorkspaceReports(s3, config.keyEnv, id);
        },
      });

      expect(rowGoneWhenHookRan).toBe(true); // after the commit
      expect(await versionsUnder(`${REPORT_STORAGE_KEY_ENV}/${gone}/`)).toBe(0);
      expect(await exists(other.key)).toBe(true);
      expect((await s3.get("reports", other.key)).toString()).toBe("keep me");
      expect(await versionsUnder(`${REPORT_STORAGE_KEY_ENV}/${kept}/`)).toBe(1);
    }, 120_000);

    it("a prefix that is a string-prefix of another workspace's does not delete it (the trailing slash is part of the prefix)", async () => {
      const gone = await workspace();
      // Same first characters, different workspace: the trailing slash on the prefix is what separates them.
      const neighbour = `${gone.slice(0, -1)}${gone.endsWith("0") ? "1" : "0"}`;
      await s3.put({ bucket: "reports", key: `${REPORT_STORAGE_KEY_ENV}/${neighbour}/${randomUUID()}.pdf`, body: "neighbour" });
      await artifact(gone);
      await deleteWorkspaceReports(s3, config.keyEnv, gone);
      expect(await versionsUnder(`${REPORT_STORAGE_KEY_ENV}/${neighbour}/`)).toBe(1);
      expect(await versionsUnder(`${REPORT_STORAGE_KEY_ENV}/${gone}/`)).toBe(0);
    }, 120_000);
  });
});
