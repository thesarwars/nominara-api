import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { runRetentionExportCleanup } from "../../src/lib/billing/retention-export/cleanup.js";
import { buildObjectLocation } from "../../src/lib/storage/storage-keys.js";
import type { ObjectHead, ObjectStoragePort, PutObjectRequest, StorageBucketName } from "../../src/lib/storage/storage.port.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import { RetentionExportService } from "../../src/modules/billing/retention-export.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { collectAfterTransactionTasks } from "../../src/api/after-transaction.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-185 / owner decision 100(j) - the stored zip is deleted when its link expires. Real database, runtime role for the per-workspace phases
// (FORCE RLS), the owner connection for discovery (as report.cleanup does); an in-memory object store that can fail and that records
// whether any transaction was open while it deleted.

const KEY_ENV = "test";

class MemoryPort implements ObjectStoragePort {
  readonly objects = new Map<string, Buffer>();
  deletes: string[] = [];
  failDelete: ((key: string) => boolean) | null = null;
  onDelete: () => Promise<void> = async () => {};
  async put(r: PutObjectRequest): Promise<void> {
    this.objects.set(`${r.bucket}/${r.key}`, Buffer.from(r.body as Uint8Array));
  }
  async get(bucket: StorageBucketName, key: string): Promise<Buffer> {
    const f = this.objects.get(`${bucket}/${key}`);
    if (f === undefined) throw new NotFoundError({ message: "no such object" });
    return f;
  }
  async head(): Promise<ObjectHead> {
    throw new Error("unused");
  }
  async delete(bucket: StorageBucketName, key: string): Promise<void> {
    await this.onDelete();
    if (this.failDelete?.(key)) throw new Error("storage down");
    this.deletes.push(key);
    this.objects.delete(`${bucket}/${key}`); // deleting an absent object succeeds
  }
  async presignGet(_b: StorageBucketName, key: string): Promise<string> {
    return `https://s3.example.test/${key}?sig=${randomUUID()}`;
  }
}

describe("STORY-185 / decision 100(j) · deleting the export zip when its link expires", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let port: MemoryPort;
  let store: TenantObjectStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    const uri = new URL(container.getConnectionUri());
    uri.username = "nominara_app";
    uri.password = password;
    pool = new Pool({ connectionString: uri.toString(), max: 6 });
  }, 300_000);
  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE retention_exports"); // each case starts with nothing due (a refused row is left behind on purpose)
    port = new MemoryPort();
    store = new TenantObjectStore(port, KEY_ENV);
  });

  async function workspace(): Promise<string> {
    return (await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'starter') RETURNING id", [`w-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
  }
  /** A ready export whose zip is in the store. `expiresInMs` negative = expired. */
  async function readyExport(ws: string, expiresInMs: number, opts: { stored?: boolean } = {}): Promise<{ id: string; key: string }> {
    const id = randomUUID();
    const loc = buildObjectLocation(KEY_ENV, ws, "reports", `retention-exports/${id}/run.zip`);
    if (opts.stored !== false) port.objects.set(`${loc.bucket}/${loc.key}`, Buffer.from("zip"));
    await db.query(
      `INSERT INTO retention_exports (id, workspace_id, status, object_key, coverage, ready_at, expires_at)
       VALUES ($1, $2, 'ready', $3, '{"generated_at":"2026-01-01T00:00:00.000Z","purge_not_before":"2026-01-01T00:00:00.000Z","complete":true,"projects":[]}'::jsonb, now(), now() + $4 * interval '1 millisecond')`,
      [id, ws, loc.key, expiresInMs],
    );
    return { id, key: loc.key };
  }
  const row = async (id: string) => (await db.query("SELECT * FROM retention_exports WHERE id = $1", [id])).rows[0]!;
  const has = (key: string): boolean => port.objects.has(`reports/${key}`);
  const run = () => runRetentionExportCleanup(db, pool, store, {});
  const idle = async (): Promise<number> => Number((await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'nominara_app' AND state LIKE 'idle in transaction%'")).rows[0].n);

  it("an expired export's object is deleted and the column stamped; the key is kept", async () => {
    const ws = await workspace();
    const e = await readyExport(ws, -60_000);
    const result = await run();
    expect(has(e.key)).toBe(false);
    expect(port.deletes).toEqual([e.key]);
    const r = await row(e.id);
    expect(r.object_purged_at).not.toBeNull();
    expect(r.object_key).toBe(e.key);
    expect(r.status).toBe("ready");
    expect(result).toMatchObject({ purged: 1, failed: 0 });
  });

  it("a live export is untouched: object kept, column null, nothing deleted", async () => {
    const ws = await workspace();
    const e = await readyExport(ws, 3_600_000);
    await run();
    expect(has(e.key)).toBe(true);
    expect(port.deletes).toEqual([]);
    expect((await row(e.id)).object_purged_at).toBeNull();
  });

  it("a storage error leaves the export for the next run (not stamped); the next run deletes it and stamps", async () => {
    const ws = await workspace();
    const e = await readyExport(ws, -1000);
    port.failDelete = () => true;
    const first = await run();
    expect(first.failed).toBe(1);
    expect((await row(e.id)).object_purged_at).toBeNull();
    expect(has(e.key)).toBe(true);
    port.failDelete = null;
    const second = await run();
    expect(second).toMatchObject({ purged: 1, failed: 0 });
    expect((await row(e.id)).object_purged_at).not.toBeNull();
    expect(has(e.key)).toBe(false);
  });

  it("one failing object does not block the others of the same sweep", async () => {
    const ws = await workspace();
    const bad = await readyExport(ws, -1000);
    const good = await readyExport(ws, -2000);
    port.failDelete = (k) => k === bad.key;
    const result = await run();
    expect(result).toMatchObject({ purged: 1, failed: 1 });
    expect((await row(good.id)).object_purged_at).not.toBeNull();
    expect((await row(bad.id)).object_purged_at).toBeNull();
  });

  it("idempotent: a second run finds nothing due and deletes nothing; an object already gone is tolerated and stamped", async () => {
    const ws = await workspace();
    const gone = await readyExport(ws, -1000, { stored: false });
    const first = await run();
    expect(first).toMatchObject({ purged: 1, failed: 0 });
    expect((await row(gone.id)).object_purged_at).not.toBeNull();
    port.deletes = [];
    const second = await run();
    expect(second).toMatchObject({ purged: 0, failed: 0 });
    expect(port.deletes).toEqual([]);
  });

  it("no other workspace is touched: a live export of B and its object survive A's cleanup, and A's cleanup never names B's key", async () => {
    const a = await workspace();
    const b = await workspace();
    const ea = await readyExport(a, -1000);
    const eb = await readyExport(b, 3_600_000);
    const eb2 = await readyExport(b, -5000); // B's expired one is B's own to clean: it is cleaned in B's context, not A's
    await run();
    expect(has(ea.key)).toBe(false);
    expect(has(eb.key)).toBe(true);
    expect((await row(eb.id)).object_purged_at).toBeNull();
    expect(has(eb2.key)).toBe(false);
    for (const d of port.deletes) expect(d.startsWith(`${KEY_ENV}/${a}/`) || d.startsWith(`${KEY_ENV}/${b}/`)).toBe(true);
  });

  it("a key outside its workspace's prefix is refused, nothing is deleted for it, it is counted refused (not a failure), and the others still clean", async () => {
    const a = await workspace();
    const b = await workspace();
    const bKey = (await readyExport(b, 3_600_000)).key;
    const forged = await readyExport(a, -1000);
    await db.query("UPDATE retention_exports SET object_key = $2 WHERE id = $1", [forged.id, bKey]);
    const fine = await readyExport(a, -2000);
    const result = await run();
    expect(has(bKey), "B's object is never deleted through A's row").toBe(true);
    expect(result).toMatchObject({ refused: 1, purged: 1, failed: 0 });
    expect((await row(forged.id)).object_purged_at).toBeNull();
    expect((await row(fine.id)).object_purged_at).not.toBeNull();
  });

  it("the delete is I/O outside any transaction: no idle-in-transaction backend while the object is deleted", async () => {
    const ws = await workspace();
    await readyExport(ws, -1000);
    const seen: number[] = [];
    port.onDelete = async () => void seen.push(await idle());
    await run();
    expect(seen).toEqual([0]);
  });

  it("after cleanup the download route still answers 404 (neutral) and presigns nothing", async () => {
    const ws = await workspace();
    const e = await readyExport(ws, -1000);
    await run();
    const service = new RetentionExportService(store, "https://api.example.test");
    const client = await pool.connect();
    try {
      const tasks: Array<() => Promise<void>> = [];
      await expect(
        collectAfterTransactionTasks(tasks, () => withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, async () => service.resolve({ id: e.id }, () => undefined))),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(tasks).toHaveLength(0);
      // Even with the expiry pushed back, a purged object is never presigned.
      await db.query("UPDATE retention_exports SET expires_at = now() + interval '1 day' WHERE id = $1", [e.id]);
      await expect(
        collectAfterTransactionTasks(tasks, () => withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, async () => service.resolve({ id: e.id }, () => undefined))),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(tasks).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});
