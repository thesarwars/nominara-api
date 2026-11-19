import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { LocalDirExportSink } from "../../src/modules/audit/adapters/local-dir-export-sink.js";
import { AuditChainService, type AppendAuditRowInput } from "../../src/modules/audit/audit-chain.service.js";
import type { AuditExportIncrement, AuditExportOptions, AuditExportRows, AuditExportSink } from "../../src/modules/audit/ports/export-sink.js";
import { runAuditExport } from "../../src/workers/rollup/audit-export.js";

// Batch 19 (STORY-020 follow-up) - the nightly export is incremental. Real Postgres (the watermark table, the chain, the REPEATABLE READ
// snapshot) and the real LocalDirExportSink so the manifests are the real bytes; the hash chain is verified from those bytes, not from a mock.

const WS_A = "bbbbbbbb-0000-0000-0000-000000000001";
const WS_B = "bbbbbbbb-0000-0000-0000-000000000002";

function input(workspaceId: string, action: string): AppendAuditRowInput {
  return {
    workspaceId, actorType: "user", actorId: "22222222-2222-2222-2222-222222222222", actorIp: "127.0.0.1", actorUa: "vitest", action,
    resourceType: "project", resourceId: "33333333-3333-3333-3333-333333333333", beforeState: null, afterState: { n: action }, requestId: "req-1",
    supportGrantId: null, severity: "info",
  };
}

interface Manifest {
  rowCount: number;
  incremental: { previousManifestSha256: string | null; chains: Array<{ workspaceId: string; fromSeq: string; afterRowHash: string | null; toSeq: string; toRowHash: string; rowCount: number; rebased: boolean }> };
}

describe("batch 19 - incremental audit export", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let chain: AuditChainService;
  let dir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    chain = new AuditChainService();
    dir = await mkdtemp(join(tmpdir(), "audit-export-incremental-"));
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function run(): Promise<{ location: string | null; rows: Array<{ workspace_id: string; seq: string; prev_hash: string }>; manifest: Manifest | null; manifestText: string | null }> {
    const sink = new LocalDirExportSink(join(dir, String(Date.now()) + Math.random().toString(16).slice(2)));
    const location = await runAuditExport(db, sink, { incremental: true });
    if (location === null) return { location, rows: [], manifest: null, manifestText: null };
    const rows = (await readFile(location, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { workspace_id: string; seq: string; prev_hash: string });
    const manifestText = await readFile(location.replace(/\.jsonl$/, ".manifest.json"), "utf8");
    return { location, rows, manifest: JSON.parse(manifestText) as Manifest, manifestText };
  }

  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
  let firstManifestText = "";
  let firstHeadA = "";

  it("first run - a chain with no watermark is exported in full, from genesis, and the manifest has no predecessor", async () => {
    await chain.append(db, input(WS_A, "a.1"));
    await chain.append(db, input(WS_A, "a.2"));
    await chain.append(db, input(WS_B, "b.1"));
    const first = await run();
    expect(first.rows.filter((r) => r.workspace_id === WS_A)).toHaveLength(2);
    expect(first.rows.filter((r) => r.workspace_id === WS_B)).toHaveLength(1);
    expect(first.manifest!.incremental.previousManifestSha256).toBeNull();
    const a = first.manifest!.incremental.chains.find((c) => c.workspaceId === WS_A)!;
    expect(a).toMatchObject({ fromSeq: "0", afterRowHash: null, rowCount: 2, rebased: false });
    firstManifestText = first.manifestText!;
    firstHeadA = a.toRowHash;
  });

  it("an increment holds only the rows added since, and the first of them chains onto the last exported row", async () => {
    await chain.append(db, input(WS_A, "a.3"));
    const second = await run();
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.workspace_id).toBe(WS_A);
    // The workspace with no new row is not in the object at all.
    expect(second.manifest!.incremental.chains.map((c) => c.workspaceId)).toEqual([WS_A]);
    const a = second.manifest!.incremental.chains[0]!;
    expect(a.afterRowHash).toBe(firstHeadA);
    expect(second.rows[0]!.prev_hash).toBe(firstHeadA);
    expect(a.rebased).toBe(false);
  });

  it("the manifest links to the previous manifest: previousManifestSha256 is the SHA-256 of the previous run's manifest bytes", async () => {
    await chain.append(db, input(WS_B, "b.2"));
    const third = await run();
    expect(third.manifest!.incremental.previousManifestSha256).not.toBeNull();
    // The previous run is the SECOND one, whose manifest we did not keep; it is not the first.
    expect(third.manifest!.incremental.previousManifestSha256).not.toBe(sha(firstManifestText));
    const stored = await db.query<{ manifest_sha256: Buffer }>("SELECT manifest_sha256 FROM audit_export_watermarks ORDER BY exported_at ASC, id ASC");
    const distinct = [...new Set(stored.rows.map((r) => r.manifest_sha256.toString("hex")))];
    // First run's manifest is recorded as exactly the hash of its bytes, and the third links to the second.
    expect(distinct[0]).toBe(sha(firstManifestText));
    expect(third.manifest!.incremental.previousManifestSha256).toBe(distinct[1]);
    expect(sha(third.manifestText!)).toBe(distinct[2]);
  });

  it("no new rows - no object is written, no watermark row is added, and the next increment still links to the last real manifest", async () => {
    const before = await db.query("SELECT count(*)::int AS n FROM audit_export_watermarks");
    const none = await run();
    expect(none.location).toBeNull();
    const after = await db.query("SELECT count(*)::int AS n FROM audit_export_watermarks");
    expect(after.rows[0]).toEqual(before.rows[0]);

    const latest = await db.query<{ manifest_sha256: Buffer }>("SELECT manifest_sha256 FROM audit_export_watermarks ORDER BY exported_at DESC, id DESC LIMIT 1");
    await chain.append(db, input(WS_A, "a.4"));
    const next = await run();
    expect(next.manifest!.incremental.previousManifestSha256).toBe(latest.rows[0]!.manifest_sha256.toString("hex"));
  });

  it("a sink that never reports what it wrote moves no watermark (a duplicate tomorrow, never a gap) and the run fails", async () => {
    await chain.append(db, input(WS_A, "a.5"));
    const silent: AuditExportSink = {
      async export(rows: AuditExportRows, _options: AuditExportOptions, _increment?: AuditExportIncrement): Promise<string> {
        for await (const _row of rows) void _row;
        return "silent";
      },
    };
    const before = await db.query("SELECT count(*)::int AS n FROM audit_export_watermarks");
    await expect(runAuditExport(db, silent, { incremental: true })).rejects.toThrow(/did not report/);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_export_watermarks")).rows[0]).toEqual(before.rows[0]);
    // The rows are still pending: the next real run exports them.
    const recovered = await run();
    expect(recovered.rows.map((r) => r.workspace_id)).toContain(WS_A);
  });

  it("a chain whose watermark row was rewritten (erasure rechain) is exported again from its start, marked rebased", async () => {
    // Simulates the rewrite by pointing the watermark at a hash the chain no longer holds: the table is append-only, so add a newer watermark.
    const head = await db.query<{ seq: string }>("SELECT max(seq)::text AS seq FROM audit_log WHERE workspace_id = $1", [WS_B]);
    const bogus = Buffer.alloc(32, 7);
    await db.query(
      "INSERT INTO audit_export_watermarks (workspace_id, from_seq, max_seq, row_hash, object_sha256, manifest_sha256) VALUES ($1, 0, $2::int8 + 1000, $3, $3, $3)",
      [WS_B, head.rows[0]!.seq, bogus],
    );
    const rebased = await run();
    const b = rebased.manifest!.incremental.chains.find((c) => c.workspaceId === WS_B)!;
    expect(b.rebased).toBe(true);
    expect(b.fromSeq).toBe("0");
    expect(rebased.rows.filter((r) => r.workspace_id === WS_B).length).toBe(b.rowCount);
    // The rebase's own (lower) watermark supersedes the stale one: the chain is not rebased again, and with nothing new there is no object.
    expect((await run()).location).toBeNull();
  });

  it("the watermark table is owner-only: no runtime role can read or write it, and it cannot be updated or deleted even by its owner", async () => {
    for (const role of ["nominara_app", "nominara_worker", "nominara_report", "nominara_portal"]) {
      const priv = await db.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'audit_export_watermarks', 'SELECT,INSERT,UPDATE,DELETE') AS ok", [role]);
      expect(priv.rows[0]!.ok).toBe(false);
    }
    await expect(db.query("UPDATE audit_export_watermarks SET max_seq = max_seq")).rejects.toThrow();
    await expect(db.query("DELETE FROM audit_export_watermarks")).rejects.toThrow();
  });

  it("the non-incremental path still exports every row every time and records nothing", async () => {
    const before = await db.query("SELECT count(*)::int AS n FROM audit_export_watermarks");
    const sink = new LocalDirExportSink(join(dir, "full"));
    const location = await runAuditExport(db, sink);
    const total = await db.query("SELECT count(*)::int AS n FROM audit_log");
    expect((await readFile(location, "utf8")).trim().split("\n")).toHaveLength(total.rows[0]!.n as number);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_export_watermarks")).rows[0]).toEqual(before.rows[0]);
  });
});
