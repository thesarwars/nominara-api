import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Logger } from "@nestjs/common";
import { DegradedError, NotFoundError } from "../../api/errors/domain-errors.js";
import type { StorageConfig } from "./storage-config.js";
import type { KeyListingPort, ObjectHead, ObjectStoragePort, PrefixDeletingPort, PutObjectRequest, StorageBucketName } from "./storage.port.js";

// Group C item 3 - the S3 adapter. One adapter for AWS S3 and LocalStack alike: the difference is `endpoint`,
// `forcePathStyle` and the credentials, all from StorageConfig.
//
// ERROR MAPPING
//   no such key             -> NotFoundError (404)
//   anything else           -> DegradedError (503), with a fixed message. The SDK's own message can carry a request id,
//                              a bucket name or an endpoint, and the credentials are never in scope here, but a fixed
//                              string is the only version that cannot leak by accident. The error NAME is logged.
// KAD-06: the network calls here must run from a worker or after commit, never inside a request-handler transaction;
// TenantObjectStore.bind() exists so the workspace can be captured inside the transaction and used after it. The
// presign is purely local.

const logger = new Logger("s3-adapter");

function isMissing(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return error.name === "NoSuchKey" || error.name === "NotFound" || error.$metadata.httpStatusCode === 404 && error.name !== "NoSuchBucket";
}

/**
 * A bounded request: the SDK's own default is NO timeout, so a stalled connection holds its caller (a worker slot, and for the
 * request-handler paths a pooled connection) until the peer gives up. Per attempt; `maxAttempts` multiplies it.
 */
export const S3_REQUEST_TIMEOUT_MS = 20_000;
export const S3_CONNECTION_TIMEOUT_MS = 3_000;

export class S3Adapter implements ObjectStoragePort, PrefixDeletingPort, KeyListingPort {
  private readonly client: S3Client;

  constructor(
    private readonly config: StorageConfig,
    requestTimeoutMs: number = S3_REQUEST_TIMEOUT_MS,
  ) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.credentials !== undefined ? { credentials: { ...config.credentials } } : {}),
      // S3-compatible stores that predate the newer default integrity checksums reject them; compute one only when required.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      requestHandler: { requestTimeout: requestTimeoutMs, connectionTimeout: S3_CONNECTION_TIMEOUT_MS, throwOnRequestTimeout: true },
    });
  }

  async put(request: PutObjectRequest): Promise<void> {
    await this.send(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName(request.bucket),
          Key: request.key,
          Body: request.body,
          ...(request.contentType !== undefined ? { ContentType: request.contentType } : {}),
          ...(request.metadata !== undefined ? { Metadata: { ...request.metadata } } : {}),
          // Encryption at rest on every write (system-architecture.md section 10: SSE-KMS). Never optional per call.
          ServerSideEncryption: this.config.sse,
          ...(this.config.sse === "aws:kms" ? { BucketKeyEnabled: true } : {}),
          ...(this.config.sse === "aws:kms" && this.config.kmsKeyId !== undefined ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
        }),
      ),
    );
  }

  async get(bucket: StorageBucketName, key: string): Promise<Buffer> {
    const output = await this.send(() => this.client.send(new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: key })));
    if (output.Body === undefined) throw new DegradedError({ message: "object storage is unavailable" });
    return Buffer.from(await output.Body.transformToByteArray());
  }

  async head(bucket: StorageBucketName, key: string): Promise<ObjectHead> {
    const output = await this.send(() => this.client.send(new HeadObjectCommand({ Bucket: this.bucketName(bucket), Key: key })));
    return {
      contentLength: output.ContentLength ?? 0,
      contentType: output.ContentType ?? null,
      etag: output.ETag ?? null,
      serverSideEncryption: output.ServerSideEncryption ?? null,
    };
  }

  async delete(bucket: StorageBucketName, key: string): Promise<void> {
    await this.send(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: key })));
  }

  /**
   * Deletes every version and delete marker under `prefix` (STORY-182's AC1: a purge leaves no recoverable copy in a versioned bucket).
   * Lists versions page by page and deletes each page in batches of at most 1000 (the DeleteObjects limit). A per-object error fails the
   * call: a purge must never be reported complete over objects that remain. Idempotent: a re-run after a partial failure finishes the job.
   */
  async deletePrefix(bucket: StorageBucketName, prefix: string): Promise<number> {
    // Never a whole bucket, and never a partial path segment ("inttest/ws1" would also match "inttest/ws10/...").
    if (prefix.length < 2 || !prefix.endsWith("/")) throw new Error("deletePrefix needs a non-empty prefix ending in /");
    const Bucket = this.bucketName(bucket);
    let removed = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (;;) {
      const page = await this.send(() =>
        this.client.send(new ListObjectVersionsCommand({ Bucket, Prefix: prefix, ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}), ...(versionIdMarker !== undefined ? { VersionIdMarker: versionIdMarker } : {}) })),
      );
      const targets = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((v) => (v.Key === undefined ? [] : [{ Key: v.Key, ...(v.VersionId !== undefined ? { VersionId: v.VersionId } : {}) }]));
      for (let i = 0; i < targets.length; i += 1000) {
        const batch = targets.slice(i, i + 1000);
        const out = await this.send(() => this.client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch, Quiet: true } })));
        if ((out.Errors?.length ?? 0) > 0) {
          logger.error({ span: "storage.s3_error", error: "DeleteObjectsPartial", failed: out.Errors?.length });
          throw new DegradedError({ message: "object storage is unavailable" });
        }
        removed += batch.length;
      }
      if (page.IsTruncated !== true) return removed;
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
  }

  /** STORY-111: the purge journal's read side. A failure is `DegradedError`, never an empty list: a journal that cannot be read must not look empty. */
  async listKeys(bucket: StorageBucketName, prefix: string): Promise<string[]> {
    if (prefix.length < 2) throw new Error("listKeys needs a non-empty prefix");
    const Bucket = this.bucketName(bucket);
    const keys: string[] = [];
    let token: string | undefined;
    for (;;) {
      const page = await this.send(() => this.client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ...(token !== undefined ? { ContinuationToken: token } : {}) })));
      for (const object of page.Contents ?? []) if (object.Key !== undefined) keys.push(object.Key);
      if (page.IsTruncated !== true || page.NextContinuationToken === undefined) return keys;
      token = page.NextContinuationToken;
    }
  }

  /** Deletes every version and delete marker of each exact key. A per-object error fails the call; idempotent (an absent key removes nothing). */
  async deleteKeys(bucket: StorageBucketName, keys: readonly string[]): Promise<number> {
    for (const key of keys) {
      if (key.length < 2 || key.endsWith("/")) throw new Error("deleteKeys needs non-empty object keys that do not end in /");
    }
    const Bucket = this.bucketName(bucket);
    let removed = 0;
    for (const key of new Set(keys)) {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      for (;;) {
        // Prefix = the key lists the key and anything longer; only the exact key is deleted.
        const page = await this.send(() =>
          this.client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key, ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}), ...(versionIdMarker !== undefined ? { VersionIdMarker: versionIdMarker } : {}) })),
        );
        const targets = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((v) => (v.Key === key ? [{ Key: key, ...(v.VersionId !== undefined ? { VersionId: v.VersionId } : {}) }] : []));
        for (let i = 0; i < targets.length; i += 1000) {
          const batch = targets.slice(i, i + 1000);
          const out = await this.send(() => this.client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch, Quiet: true } })));
          if ((out.Errors?.length ?? 0) > 0) {
            logger.error({ span: "storage.s3_error", error: "DeleteObjectsPartial", failed: out.Errors?.length });
            throw new DegradedError({ message: "object storage is unavailable" });
          }
          removed += batch.length;
        }
        if (page.IsTruncated !== true) break;
        keyMarker = page.NextKeyMarker;
        versionIdMarker = page.NextVersionIdMarker;
      }
    }
    return removed;
  }

  async presignGet(bucket: StorageBucketName, key: string, expiresInSeconds: number, downloadFilename?: string): Promise<string> {
    const disposition = downloadFilename === undefined ? undefined : `attachment; filename="${downloadFilename.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: key, ResponseContentDisposition: disposition }), { expiresIn: expiresInSeconds });
  }

  private bucketName(bucket: StorageBucketName): string {
    return this.config.buckets[bucket];
  }

  private async send<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError({ message: "no such object" });
      logger.error({ span: "storage.s3_error", error: error instanceof Error ? error.name : "unknown" });
      throw new DegradedError({ message: "object storage is unavailable" });
    }
  }
}
