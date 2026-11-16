import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3_CONNECTION_TIMEOUT_MS, S3_REQUEST_TIMEOUT_MS } from "../../../lib/storage/s3.adapter.js";
import type { AuditChainRow } from "../../../lib/crypto/audit-chain.js";
import type { AuditExportOptions, AuditExportRows, AuditExportSink } from "../ports/export-sink.js";

// STORY-020 AC8 - security-and-tenancy.md section 12: "Nightly export to S3 with Object Lock in COMPLIANCE mode, 7-year retention."
// The real counterpart of LocalDirExportSink (which only chmods). It implements the STREAMING port (STORY-144 AC7):
//  - rows are spooled to a LOCAL temp file as they arrive, never collected, so memory is one batch whatever the estate;
//  - NOTHING IS UPLOADED UNTIL THE STREAM HAS ENDED: the source holds a REPEATABLE READ snapshot on the privileged connection
//    while this consumes it, and a network call inside that window would pin xmin across a third party's latency;
//  - a stream that throws leaves no export behind (no upload happened; the spool is removed in `finally`).
// COMPLIANCE mode cannot be shortened or removed by anyone, including the account root, until the retain-until date. The BUCKET must
// have been created with Object Lock enabled (a deploy prerequisite this adapter cannot create); S3 refuses the lock headers otherwise,
// and that refusal fails the export, which is the loud outcome we want.

/** Lines per write to the spool. Bounds this sink's own memory; a throughput choice, not a limit anything depends on. */
const WRITE_BATCH_ROWS = 500;
const DAY_MS = 86_400_000;
const UPLOAD_ATTEMPTS = 3;

export interface S3ObjectLockSinkConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly sse: "AES256" | "aws:kms";
  readonly kmsKeyId?: string;
  /** Leading key segment; defaults to `audit-exports`. */
  readonly keyPrefix?: string;
}

export interface S3ObjectLockSinkOptions {
  /** Base delay between upload attempts (doubled each retry). A test seam. */
  readonly retryDelayMs?: number;
}

function toExportLine(row: AuditChainRow): string {
  return JSON.stringify({ ...row, prev_hash: row.prev_hash.toString("hex"), row_hash: row.row_hash.toString("hex") });
}

export class S3ObjectLockExportSink implements AuditExportSink {
  private readonly client: S3Client;
  private readonly retryDelayMs: number;

  constructor(
    private readonly config: S3ObjectLockSinkConfig,
    options: S3ObjectLockSinkOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.credentials !== undefined ? { credentials: { ...config.credentials } } : {}),
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      // ONE attempt in the SDK: a retried request would re-send a stream that was already consumed. The retry loop below opens a fresh one.
      maxAttempts: 1,
      requestHandler: { requestTimeout: S3_REQUEST_TIMEOUT_MS, connectionTimeout: S3_CONNECTION_TIMEOUT_MS, throwOnRequestTimeout: true },
    });
  }

  async export(rows: AuditExportRows, options: AuditExportOptions): Promise<string> {
    if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) {
      throw new RangeError(`audit export retention must be a positive number of days, got ${String(options.retentionDays)}`);
    }
    const dir = await mkdtemp(join(tmpdir(), "audit-export-spool-"));
    try {
      const dataPath = join(dir, "data.jsonl");
      const spooled = await this.spool(rows, dataPath);

      const now = new Date();
      const retainUntil = new Date(now.getTime() + options.retentionDays * DAY_MS);
      const stamp = now.toISOString().replace(/[:.]/g, "-");
      const base = `${this.config.keyPrefix ?? "audit-exports"}/${now.toISOString().slice(0, 10)}/audit-export-${stamp}`;
      const manifest = Buffer.from(
        JSON.stringify({ rowCount: spooled.rowCount, workspaceIds: [...spooled.workspaceIds], retentionDays: options.retentionDays, lockedUntil: retainUntil.toISOString(), sha256: spooled.sha256Hex }, null, 2),
        "utf8",
      );

      // Data first, manifest second: a manifest never names an object that is not there. If the manifest fails the data object stays (it
      // cannot be deleted under COMPLIANCE anyway) and the failed job's retry writes a complete pair under a new stamp.
      await this.putLocked(`${base}.jsonl`, () => createReadStream(dataPath), spooled.bytes, spooled.sha256Base64, retainUntil);
      const manifestSha = createHash("sha256").update(manifest).digest("base64");
      await this.putLocked(`${base}.manifest.json`, () => manifest, manifest.byteLength, manifestSha, retainUntil, "application/json");
      return `s3://${this.config.bucket}/${base}.jsonl`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async spool(rows: AuditExportRows, path: string): Promise<{ rowCount: number; workspaceIds: Set<string>; bytes: number; sha256Hex: string; sha256Base64: string }> {
    const hash = createHash("sha256");
    const workspaceIds = new Set<string>();
    let rowCount = 0;
    const handle = await open(path, "w");
    try {
      let batch: string[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const text = `${batch.join("\n")}\n`;
        hash.update(text);
        await handle.write(text);
        batch = [];
      };
      for await (const row of rows) {
        batch.push(toExportLine(row));
        rowCount += 1;
        workspaceIds.add(row.workspace_id);
        if (batch.length >= WRITE_BATCH_ROWS) await flush();
      }
      await flush();
    } finally {
      await handle.close();
    }
    const digest = hash.digest();
    return { rowCount, workspaceIds, bytes: (await stat(path)).size, sha256Hex: digest.toString("hex"), sha256Base64: digest.toString("base64") };
  }

  private async putLocked(
    key: string,
    body: () => NodeJS.ReadableStream | Buffer,
    contentLength: number,
    sha256Base64: string,
    retainUntil: Date,
    contentType = "application/x-ndjson",
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            // A FRESH body per attempt: a stream cannot be replayed.
            Body: body() as never,
            ContentLength: contentLength,
            ContentType: contentType,
            ChecksumAlgorithm: "SHA256",
            ChecksumSHA256: sha256Base64,
            ObjectLockMode: "COMPLIANCE",
            ObjectLockRetainUntilDate: retainUntil,
            ServerSideEncryption: this.config.sse,
            ...(this.config.sse === "aws:kms" ? { BucketKeyEnabled: true } : {}),
            ...(this.config.sse === "aws:kms" && this.config.kmsKeyId !== undefined ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
          }),
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < UPLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }
}
