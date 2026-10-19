import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { verifyChain, type AuditChainRow } from "../../src/lib/crypto/audit-chain.js";
import { LocalDirExportSink } from "../../src/modules/audit/adapters/local-dir-export-sink.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { listAuditedWorkspaceIds, readWorkspaceChain } from "../../src/modules/audit/audit-log-reader.js";
import type { AuditExportOptions, AuditExportSink } from "../../src/modules/audit/ports/export-sink.js";
import { runAuditExport } from "../../src/workers/rollup/audit-export.js";

// STORY-144 AC7 — audit-export.ts must not accumulate the estate. These run the real export over real chains, with the
// privileged client wrapped so what the database was asked, and how much came back at once, can be counted.

const service = new AuditChainService();

describe("STORY-144 AC7 · audit-export streams the estate in chunks", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let dir: string;

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

  beforeEach(async () => {
    await db.query("TRUNCATE audit_log, workspaces CASCADE");
    dir = await mkdtemp(join(tmpdir(), "audit-export-it-"));
    return async () => rm(dir, { recursive: true, force: true });
  });

  async function workspace(): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [id, `w-${randomUUID().slice(0, 8)}`]);
    return id;
  }

  async function append(workspaceId: string, n: number, client: Client = db): Promise<void> {
    await service.append(client, {
      workspaceId,
      actorType: "system",
      actorId: null,
      actorIp: null,
      actorUa: null,
      action: "workspace.updated",
      resourceType: "workspace",
      resourceId: workspaceId,
      beforeState: null,
      afterState: { n },
      requestId: randomUUID(),
      supportGrantId: null,
      severity: "info",
    });
  }

  /** Interleaves appends across tenants so every tenant's `seq` values are scattered. */
  async function estate(counts: number[]): Promise<string[]> {
    const ids = [];
    for (let i = 0; i < counts.length; i += 1) ids.push(await workspace());
    const max = Math.max(...counts);
    for (let n = 0; n < max; n += 1) {
      for (let i = 0; i < counts.length; i += 1) if (n < counts[i]!) await append(ids[i]!, n);
    }
    return ids;
  }

  class CollectingSink implements AuditExportSink {
    rows: AuditChainRow[] = [];
    chunkQueriesWhenRowSeen: number[] = [];
    constructor(private readonly chunkQueries: () => number) {}
    async export(rows: Iterable<AuditChainRow> | AsyncIterable<AuditChainRow>, _options: AuditExportOptions): Promise<string> {
      for await (const row of rows) {
        this.rows.push(row);
        this.chunkQueriesWhenRowSeen.push(this.chunkQueries());
      }
      return "collected";
    }
  }

  function instrumented() {
    const log: string[] = [];
    let maxRowsInOneResult = 0;
    let chunkQueries = 0;
    const client = {
      query: (async (text: unknown, params: unknown) => {
        const sql = String(text);
        log.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
        const isChunk = sql.includes("ORDER BY audit_log.seq ASC") && sql.includes("LIMIT");
        if (isChunk) chunkQueries += 1;
        const result = await db.query(sql, params as unknown[]);
        if (isChunk) maxRowsInOneResult = Math.max(maxRowsInOneResult, result.rowCount ?? 0);
        return result;
      }) as Client["query"],
    } as unknown as Client;
    return { client, log, maxRows: () => maxRowsInOneResult, chunkQueries: () => chunkQueries };
  }

  it("STORY-144 AC7 · no query ever returns more than one chunk, however large a workspace is", async () => {
    await estate([11, 4]);
    const probe = instrumented();
    const sink = new CollectingSink(probe.chunkQueries);

    await runAuditExport(probe.client, sink, { chunkRows: 3 });

    expect(sink.rows).toHaveLength(15);
    expect(probe.maxRows()).toBeLessThanOrEqual(3);
  }, 120_000);

  it("STORY-144 AC7 · the sink is fed while later chunks are still unread (rows in flight are bounded)", async () => {
    await estate([9]);
    const probe = instrumented();
    const sink = new CollectingSink(probe.chunkQueries);

    await runAuditExport(probe.client, sink, { chunkRows: 2 });

    // When the FIRST row reaches the sink exactly one chunk has been read. An implementation that still builds the
    // whole array before calling the sink would show every chunk query already run.
    expect(sink.chunkQueriesWhenRowSeen[0]).toBe(1);
    expect(sink.chunkQueriesWhenRowSeen.at(-1)).toBeGreaterThan(1);
  }, 120_000);

  it("STORY-144 AC7 · the streamed JSONL is byte-identical to what the whole-array export wrote for the same estate", async () => {
    await estate([7, 5, 3]);

    // The old shape: every chain into one array, then the sink.
    const oldRows: AuditChainRow[] = [];
    for (const id of await listAuditedWorkspaceIds(db)) oldRows.push(...(await readWorkspaceChain(db, id)));
    const oldPath = await new LocalDirExportSink(join(dir, "old")).export(oldRows, { retentionDays: 30 });

    const newPath = await runAuditExport(db, new LocalDirExportSink(join(dir, "new")), { retentionDays: 30, chunkRows: 2 });

    expect(await readFile(newPath, "utf8")).toBe(await readFile(oldPath, "utf8"));
    const manifest = async (p: string) => {
      const m = JSON.parse(await readFile(p.replace(/\.jsonl$/, ".manifest.json"), "utf8")) as Record<string, unknown>;
      delete m.lockedUntil;
      return m;
    };
    expect(await manifest(newPath)).toEqual(await manifest(oldPath));
  }, 120_000);

  it("STORY-144 AC7 · every exported chain is complete, in seq order, and verifies, with tenants interleaved in seq", async () => {
    const ids = await estate([6, 6, 2]);
    const probe = instrumented();
    const sink = new CollectingSink(probe.chunkQueries);

    await runAuditExport(probe.client, sink, { chunkRows: 2 });

    for (const id of ids) {
      const mine = sink.rows.filter((r) => r.workspace_id === id);
      expect(mine, `workspace ${id}`).toEqual(await readWorkspaceChain(db, id));
      expect(verifyChain(mine)).toBeNull();
    }
    // No tenant's rows were fetched as part of another's chain.
    expect(sink.rows).toHaveLength(14);
  }, 120_000);

  it("STORY-144 AC7 · one REPEATABLE READ snapshot per workspace chain, closed before the next opens", async () => {
    await estate([3, 3, 3]);
    const probe = instrumented();
    await runAuditExport(probe.client, new CollectingSink(probe.chunkQueries), { chunkRows: 2 });

    const begins = probe.log.filter((l) => l.startsWith("BEGIN ISOLATION LEVEL REPEATABLE"));
    const commits = probe.log.filter((l) => l === "COMMIT");
    expect(begins).toHaveLength(3);
    expect(commits).toHaveLength(3);
    // Strictly alternating: a snapshot is never held across two workspaces.
    const txn = probe.log.filter((l) => l.startsWith("BEGIN") || l === "COMMIT");
    expect(txn).toEqual(Array.from({ length: 3 }).flatMap(() => ["BEGIN ISOLATION LEVEL REPEATABLE", "COMMIT"]));
  }, 120_000);

  it("⚠ STORY-144 AC7 · a row committed to a workspace mid-export is not half-included: each chain is one consistent snapshot", async () => {
    const [ws] = await estate([6]);
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      let appended = false;
      const probe = instrumented();
      const client = {
        query: (async (text: unknown, params: unknown) => {
          // Before the second chunk read, a new row commits on another connection.
          if (!appended && String(text).includes("audit_log.seq > $2")) {
            appended = true;
            await append(ws!, 99, other);
          }
          return (probe.client.query as unknown as (t: unknown, p: unknown) => Promise<unknown>)(text, params);
        }) as Client["query"],
      } as unknown as Client;
      const sink = new CollectingSink(probe.chunkQueries);

      await runAuditExport(client, sink, { chunkRows: 2 });

      expect(appended).toBe(true);
      expect(sink.rows).toHaveLength(6);
      expect(verifyChain(sink.rows)).toBeNull();
    } finally {
      await other.end();
    }
  }, 120_000);

  it("STORY-144 AC7 · a sink that throws mid-stream releases the snapshot and the connection stays usable", async () => {
    await estate([5]);
    const sink: AuditExportSink = {
      async export(rows) {
        for await (const _row of rows) throw new Error("upload failed");
        return "never";
      },
    };
    await expect(runAuditExport(db, sink, { chunkRows: 2 })).rejects.toThrow("upload failed");
    // Not left inside the REPEATABLE READ transaction the failed export opened.
    const level = await db.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
    expect(level.rows[0]?.transaction_isolation).toBe("read committed");
  }, 120_000);

  it("STORY-144 AC7 · an estate with no audit rows exports an empty file", async () => {
    const path = await runAuditExport(db, new LocalDirExportSink(dir), { chunkRows: 2 });
    expect(await readFile(path, "utf8")).toBe("");
  }, 120_000);

  it("STORY-144 AC7 · refuses a chunk size that cannot make progress", async () => {
    await estate([2]);
    await expect(runAuditExport(db, new CollectingSink(() => 0), { chunkRows: 0 })).rejects.toThrow(/positive integer/);
  }, 120_000);
});
