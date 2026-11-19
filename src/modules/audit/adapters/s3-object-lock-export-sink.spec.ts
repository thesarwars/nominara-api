import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, type AuditChainRow } from "../../../lib/crypto/audit-chain.js";
import type { AuditExportIncrement } from "../ports/export-sink.js";
import { S3ObjectLockExportSink } from "./s3-object-lock-export-sink.js";

// STORY-020 AC8 - the Object Lock COMPLIANCE sink. No bucket: what the sink ASKS S3 to do is asserted on the PutObject input
// (the same technique as s3.adapter.spec.ts), and the body is read as the SDK would read it.

function row(seq: string, workspace = "ws-1"): AuditChainRow {
  return {
    seq, workspace_id: workspace, occurred_at: "2026-08-19T00:00:00.000Z", actor_type: "user", actor_id: "user-1", actor_ip: null, actor_ua: null,
    action: "project.create", resource_type: "project", resource_id: "project-1", before_state: null, after_state: { name: "Acme" },
    request_id: "req-1", support_grant_id: null, severity: "info", prev_hash: GENESIS_HASH, row_hash: Buffer.from("deadbeef", "hex"),
  };
}

interface Put { input: Record<string, unknown>; body: string }

const CONFIG = { bucket: "audit-locked", region: "us-east-1", forcePathStyle: false, sse: "aws:kms" as const, kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/abc" };

async function drain(body: unknown): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function captureSends(fail?: (n: number) => Error | undefined): { puts: Put[] } {
  const puts: Put[] = [];
  let n = 0;
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      n += 1;
      const failure = fail?.(n);
      const input = command.input as unknown as Record<string, unknown>;
      const body = await drain(input.Body);
      if (failure !== undefined) throw failure;
      puts.push({ input, body });
    }
    return {};
  }) as never);
  return { puts };
}

const spoolDirs = async (): Promise<string[]> => (await readdir(tmpdir())).filter((name) => name.startsWith("audit-export-spool-"));

afterEach(() => vi.restoreAllMocks());

describe("STORY-020 AC8 - S3ObjectLockExportSink", () => {
  it("scenario 9 - writes the export object under COMPLIANCE mode, retained until now + the configured retention", async () => {
    const { puts } = captureSends();
    const before = Date.now();
    const location = await new S3ObjectLockExportSink(CONFIG).export([row("1"), row("2", "ws-2")], { retentionDays: 2557 });
    const after = Date.now();

    const data = puts.find((p) => String(p.input.Key).endsWith(".jsonl"))!;
    expect(data.input.Bucket).toBe("audit-locked");
    expect(data.input.ObjectLockMode).toBe("COMPLIANCE");
    const until = (data.input.ObjectLockRetainUntilDate as Date).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 2557 * 86_400_000);
    expect(until).toBeLessThanOrEqual(after + 2557 * 86_400_000);
    expect(data.body.trim().split("\n").map((l) => (JSON.parse(l) as { seq: string }).seq)).toEqual(["1", "2"]);
    expect(location).toBe(`s3://audit-locked/${String(data.input.Key)}`);
  });

  it("scenario 9 - the manifest object is locked identically and records the row count, workspaces and retention", async () => {
    const { puts } = captureSends();
    await new S3ObjectLockExportSink(CONFIG).export([row("1"), row("2", "ws-2"), row("3", "ws-2")], { retentionDays: 30 });

    const manifest = puts.find((p) => String(p.input.Key).endsWith(".manifest.json"))!;
    expect(manifest.input.ObjectLockMode).toBe("COMPLIANCE");
    expect(JSON.parse(manifest.body)).toMatchObject({ rowCount: 3, retentionDays: 30 });
    expect((JSON.parse(manifest.body) as { workspaceIds: string[] }).workspaceIds.sort()).toEqual(["ws-1", "ws-2"]);
    const data = puts.find((p) => String(p.input.Key).endsWith(".jsonl"))!;
    expect(manifest.input.ObjectLockRetainUntilDate).toBeInstanceOf(Date);
    expect(String(manifest.input.Key).replace(".manifest.json", ".jsonl")).toBe(data.input.Key);
  });

  it("every write is encrypted at rest and carries a SHA-256 checksum (Object Lock writes require an integrity header)", async () => {
    const { puts } = captureSends();
    await new S3ObjectLockExportSink(CONFIG).export([row("1")], { retentionDays: 1 });
    for (const put of puts) {
      expect(put.input.ServerSideEncryption).toBe("aws:kms");
      expect(put.input.SSEKMSKeyId).toBe(CONFIG.kmsKeyId);
      expect(put.input.ChecksumAlgorithm).toBe("SHA256");
      expect(typeof put.input.ChecksumSHA256).toBe("string");
    }
  });

  it("STORY-144 AC7 - rows are consumed as a stream and the upload starts only after the stream has ended", async () => {
    let ended = false;
    let uploadStartedBeforeEnd = false;
    vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
      if (command instanceof PutObjectCommand) uploadStartedBeforeEnd ||= !ended;
      return {};
    }) as never);
    async function* source(): AsyncGenerator<AuditChainRow> {
      yield row("1");
      await new Promise((r) => setImmediate(r));
      yield row("2");
      ended = true;
    }
    await new S3ObjectLockExportSink(CONFIG).export(source(), { retentionDays: 1 });
    expect(uploadStartedBeforeEnd).toBe(false);
  });

  it("a stream that throws leaves no export behind: nothing is uploaded and the spool file is removed", async () => {
    const { puts } = captureSends();
    const spoolBefore = await spoolDirs();
    async function* broken(): AsyncGenerator<AuditChainRow> {
      yield row("1");
      throw new Error("source failed");
    }
    await expect(new S3ObjectLockExportSink(CONFIG).export(broken(), { retentionDays: 1 })).rejects.toThrow("source failed");
    expect(puts).toHaveLength(0);
    expect(await spoolDirs()).toEqual(spoolBefore);
  });

  it("a failed upload is retried with a fresh body, and the spool file is removed once it has settled", async () => {
    const { puts } = captureSends((n) => (n === 1 ? new Error("connection reset") : undefined));
    const spoolBefore = await spoolDirs();
    await new S3ObjectLockExportSink(CONFIG, { retryDelayMs: 0 }).export([row("1")], { retentionDays: 1 });
    const data = puts.filter((p) => String(p.input.Key).endsWith(".jsonl"));
    expect(data).toHaveLength(1);
    expect(data[0]!.body).toContain('"seq":"1"');
    expect(await spoolDirs()).toEqual(spoolBefore);
  });

  it("an upload that keeps failing fails the export (it is never reported as written) and removes the spool", async () => {
    captureSends(() => new Error("denied"));
    const spoolBefore = await spoolDirs();
    await expect(new S3ObjectLockExportSink(CONFIG, { retryDelayMs: 0 }).export([row("1")], { retentionDays: 1 })).rejects.toThrow("denied");
    expect(await spoolDirs()).toEqual(spoolBefore);
  });

  it("an empty estate still writes a (locked) empty export and manifest with rowCount 0", async () => {
    const { puts } = captureSends();
    await new S3ObjectLockExportSink(CONFIG).export([], { retentionDays: 1 });
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts.find((p) => String(p.input.Key).endsWith(".manifest.json"))!.body)).toMatchObject({ rowCount: 0, workspaceIds: [] });
  });

  it("rejects a non-positive retention instead of writing an unlocked-in-practice object", async () => {
    const { puts } = captureSends();
    await expect(new S3ObjectLockExportSink(CONFIG).export([row("1")], { retentionDays: 0 })).rejects.toThrow(RangeError);
    expect(puts).toHaveLength(0);
  });
});

describe("batch 19 (STORY-020 follow-up) - the incremental manifest", () => {
  const increment = (previous: string | null, recorded: Array<{ dataSha256: string; manifestSha256: string }>): AuditExportIncrement => ({
    previousManifestSha256: previous,
    unrecordedRuns: [],
    chains: new Map([["ws-1", { fromSeq: "1", afterRowHash: "deadbeef", toSeq: "2", toRowHash: "cafe", rowCount: 1, rebased: false }]]),
    beforeCommit: async () => true,
    recordWritten: (written) => recorded.push(written),
  });

  it("the manifest carries the previous manifest's hash and each chain's range, so increments chain verifiably", async () => {
    const { puts } = captureSends();
    const recorded: Array<{ dataSha256: string; manifestSha256: string }> = [];
    await new S3ObjectLockExportSink(CONFIG).export([row("2")], { retentionDays: 30 }, increment("ab".repeat(32), recorded));

    const manifest = puts.find((p) => String(p.input.Key).endsWith(".manifest.json"))!;
    expect(JSON.parse(manifest.body)).toMatchObject({
      incremental: {
        previousManifestSha256: "ab".repeat(32),
        chains: [{ workspaceId: "ws-1", fromSeq: "1", afterRowHash: "deadbeef", toSeq: "2", toRowHash: "cafe", rowCount: 1, rebased: false }],
      },
    });
  });

  it("reports the SHA-256 of the exact manifest and data bytes it wrote, once both objects are written", async () => {
    const { puts } = captureSends();
    const recorded: Array<{ dataSha256: string; manifestSha256: string }> = [];
    await new S3ObjectLockExportSink(CONFIG).export([row("2")], { retentionDays: 30 }, increment(null, recorded));

    expect(recorded).toHaveLength(1);
    const manifest = puts.find((p) => String(p.input.Key).endsWith(".manifest.json"))!;
    const data = puts.find((p) => String(p.input.Key).endsWith(".jsonl"))!;
    expect(recorded[0]!.manifestSha256).toBe(createHash("sha256").update(manifest.body).digest("hex"));
    expect(recorded[0]!.dataSha256).toBe(createHash("sha256").update(data.body).digest("hex"));
    expect(JSON.parse(manifest.body)).toMatchObject({ incremental: { previousManifestSha256: null } });
  });

  it("records nothing when an upload fails, so the watermark cannot move past an object that is not there", async () => {
    captureSends((n) => (n >= 2 ? new Error("manifest upload down") : undefined));
    const recorded: Array<{ dataSha256: string; manifestSha256: string }> = [];
    await expect(
      new S3ObjectLockExportSink(CONFIG, { retryDelayMs: 0 }).export([row("2")], { retentionDays: 30 }, increment(null, recorded)),
    ).rejects.toThrow();
    expect(recorded).toHaveLength(0);
  });

  it("a full (non-incremental) export has no incremental block in its manifest", async () => {
    const { puts } = captureSends();
    await new S3ObjectLockExportSink(CONFIG).export([row("1")], { retentionDays: 30 });
    const manifest = puts.find((p) => String(p.input.Key).endsWith(".manifest.json"))!;
    expect(JSON.parse(manifest.body)).not.toHaveProperty("incremental");
  });

  it("STORY-020: beforeCommit answering false uploads nothing, reports nothing and returns null", async () => {
    const { puts } = captureSends();
    const recorded: Array<{ dataSha256: string; manifestSha256: string }> = [];
    const location = await new S3ObjectLockExportSink(CONFIG).export([row("2")], { retentionDays: 30 }, { ...increment(null, recorded), beforeCommit: async () => false });
    expect(location).toBeNull();
    expect(puts).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("STORY-020: beforeCommit is asked with the exact hashes, before the first upload", async () => {
    const { puts } = captureSends();
    const asked: Array<{ dataSha256: string; manifestSha256: string; putsSoFar: number }> = [];
    await new S3ObjectLockExportSink(CONFIG).export([row("2")], { retentionDays: 30 }, {
      ...increment(null, []),
      beforeCommit: async (planned) => {
        asked.push({ ...planned, putsSoFar: puts.length });
        return true;
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.putsSoFar).toBe(0);
    const manifest = puts.find((p) => String(p.input.Key).endsWith(".manifest.json"))!;
    expect(asked[0]!.manifestSha256).toBe(createHash("sha256").update(manifest.body).digest("hex"));
  });
});
