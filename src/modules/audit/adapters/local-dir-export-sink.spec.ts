import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENESIS_HASH, type AuditChainRow } from "../../../lib/crypto/audit-chain.js";
import { LocalDirExportSink } from "./local-dir-export-sink.js";

// STORY-020 D-1 / scenario 9 — "run the export -> object locked with the
// configured retention". Real filesystem (no I/O mocking; this IS the I/O
// under test), a throwaway temp dir per test.

function row(overrides: Partial<AuditChainRow> = {}): AuditChainRow {
  return {
    seq: "1",
    workspace_id: "ws-1",
    occurred_at: "2026-08-19T00:00:00.000Z",
    actor_type: "user",
    actor_id: "user-1",
    actor_ip: "127.0.0.1",
    actor_ua: "vitest",
    action: "project.create",
    resource_type: "project",
    resource_id: "project-1",
    before_state: null,
    after_state: { name: "Acme" },
    request_id: "req-1",
    support_grant_id: null,
    severity: "info",
    prev_hash: GENESIS_HASH,
    row_hash: Buffer.from("deadbeef", "hex"),
    ...overrides,
  };
}

describe("STORY-020 · LocalDirExportSink", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audit-export-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("scenario 9 — writes every row to a data file, and a manifest recording the configured retention", async () => {
    const sink = new LocalDirExportSink(dir);
    const rows = [row({ seq: "1" }), row({ seq: "2", workspace_id: "ws-2" })];

    const dataPath = await sink.export(rows, { retentionDays: 2557 });
    const contents = await readFile(dataPath, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).seq).toBe("1");

    const manifestPath = dataPath.replace(/\.jsonl$/, ".manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      rowCount: number;
      workspaceIds: string[];
      retentionDays: number;
      lockedUntil: string;
    };
    expect(manifest.rowCount).toBe(2);
    expect(manifest.workspaceIds.sort()).toEqual(["ws-1", "ws-2"]);
    expect(manifest.retentionDays).toBe(2557);
    expect(new Date(manifest.lockedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the exported data and manifest files read-only", async () => {
    const sink = new LocalDirExportSink(dir);
    const dataPath = await sink.export([row()], { retentionDays: 30 });
    const manifestPath = dataPath.replace(/\.jsonl$/, ".manifest.json");

    const dataStat = await stat(dataPath);
    const manifestStat = await stat(manifestPath);
    expect(dataStat.mode & 0o200).toBe(0);
    expect(manifestStat.mode & 0o200).toBe(0);
  });

  it("writes an empty data file (no crash) when there are no rows to export", async () => {
    const sink = new LocalDirExportSink(dir);
    const dataPath = await sink.export([], { retentionDays: 30 });
    const contents = await readFile(dataPath, "utf8");
    expect(contents).toBe("");
  });

  it("hex-encodes prev_hash/row_hash rather than dumping raw Buffer JSON", async () => {
    const sink = new LocalDirExportSink(dir);
    const dataPath = await sink.export([row({ row_hash: Buffer.from("abcd", "hex") })], { retentionDays: 30 });
    const line = (await readFile(dataPath, "utf8")).trim();
    const parsed = JSON.parse(line) as { row_hash: string };
    expect(parsed.row_hash).toBe("abcd");
  });
});

describe("STORY-144 AC7 · LocalDirExportSink streams", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "audit-export-stream-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function* stream(rows: AuditChainRow[], onPull?: (n: number) => void): AsyncGenerator<AuditChainRow> {
    let n = 0;
    for (const r of rows) {
      n += 1;
      onPull?.(n);
      await Promise.resolve();
      yield r;
    }
  }

  it("an async stream gives byte-identical data and manifest counts to the same rows as an array", async () => {
    const rows = Array.from({ length: 1_203 }, (_, i) => row({ seq: String(i + 1), workspace_id: i % 3 === 0 ? "ws-1" : "ws-2" }));
    const arrayDir = join(dir, "array");
    const streamDir = join(dir, "stream");

    const arrayPath = await new LocalDirExportSink(arrayDir).export(rows, { retentionDays: 30 });
    const streamPath = await new LocalDirExportSink(streamDir).export(stream(rows), { retentionDays: 30 });

    expect(await readFile(streamPath, "utf8")).toBe(await readFile(arrayPath, "utf8"));
    const m = async (path: string) => JSON.parse(await readFile(path.replace(/\.jsonl$/, ".manifest.json"), "utf8")) as { rowCount: number; workspaceIds: string[]; retentionDays: number };
    const streamed = await m(streamPath);
    expect(streamed.rowCount).toBe(1_203);
    expect(streamed.workspaceIds).toEqual((await m(arrayPath)).workspaceIds);
    expect(streamed.workspaceIds.sort()).toEqual(["ws-1", "ws-2"]);
  });

  it("an empty stream writes an empty data file and a zero-row manifest", async () => {
    const path = await new LocalDirExportSink(dir).export(stream([]), { retentionDays: 30 });
    expect(await readFile(path, "utf8")).toBe("");
    const manifest = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".manifest.json"), "utf8")) as { rowCount: number; workspaceIds: string[] };
    expect(manifest.rowCount).toBe(0);
    expect(manifest.workspaceIds).toEqual([]);
  });

  it("a source larger than one write batch is written whole and in order", async () => {
    let pulled = 0;
    const rows = Array.from({ length: 5_000 }, (_, i) => row({ seq: String(i + 1) }));
    const path = await new LocalDirExportSink(dir).export(stream(rows, (n) => (pulled = n)), { retentionDays: 30 });
    expect(pulled).toBe(5_000);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(5_000);
    expect((JSON.parse(lines[4_999]!) as { seq: string }).seq).toBe("5000");
  });

  it("⚠ a stream that fails midway leaves NO read-only export behind, and rethrows the original error", async () => {
    async function* failing(): AsyncGenerator<AuditChainRow> {
      yield row({ seq: "1" });
      await Promise.resolve();
      throw new Error("snapshot lost");
    }
    await expect(new LocalDirExportSink(dir).export(failing(), { retentionDays: 30 })).rejects.toThrow("snapshot lost");
    // A half-written file chmod'd read-only and named like a complete export would be taken for one.
    expect(await readdir(dir)).toEqual([]);
  });
});
