import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
