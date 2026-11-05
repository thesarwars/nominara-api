// Group C item 3 — the object-storage port (KAD-08: blobs in object storage, facts in PostgreSQL).
//
// TWO LAYERS, ONE SEAM
//   ObjectStoragePort   the swap point. Bucket + full key in, bytes out. S3Adapter implements it; LocalStack in
//                       development and AWS in production differ only in endpoint and credentials, so nothing above
//                       this line knows which one it is talking to.
//   TenantObjectStore   the only thing a feature should inject. It derives the workspace prefix from the tenant
//                       context and refuses any key that would leave it (tenant-object-store.ts).
// A feature that imports the port directly can name any key in the bucket; that is what the second layer exists to
// prevent, so feature code takes TenantObjectStore.

export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

/** Logical buckets (system-architecture.md section 3): raw captures and crawl snapshots share `raw`; reports have their own. */
export type StorageBucketName = "raw" | "reports";

/** Where in a bucket a workspace's object lives. `crawl` is a prefix inside the raw bucket (section 8: `nominara-raw/crawl/`). */
export type StorageNamespace = "raw" | "crawl" | "reports";

export interface PutObjectRequest {
  readonly bucket: StorageBucketName;
  readonly key: string;
  readonly body: Uint8Array | string;
  readonly contentType?: string;
  /** Written as object metadata. Never put anything secret or personal here. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ObjectHead {
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly etag: string | null;
  /** What the store reports it applied: `AES256`, `aws:kms`, or null when none. */
  readonly serverSideEncryption: string | null;
}

export interface ObjectStoragePort {
  put(request: PutObjectRequest): Promise<void>;
  /** Throws NotFoundError (404) when the object is absent. Reads the whole object into memory: for small blobs only. */
  get(bucket: StorageBucketName, key: string): Promise<Buffer>;
  /** Throws NotFoundError (404) when the object is absent. */
  head(bucket: StorageBucketName, key: string): Promise<ObjectHead>;
  /** Idempotent: deleting an absent object succeeds. */
  delete(bucket: StorageBucketName, key: string): Promise<void>;
  /**
   * A GET URL that stops working after `expiresInSeconds`. Computed locally (no network call), so a request handler may
   * mint one under KAD-06. It does NOT check that the object exists. `downloadFilename` makes the store answer with
   * `Content-Disposition: attachment; filename="..."` (STORY-180: a cross-origin link ignores the `download` attribute).
   */
  presignGet(bucket: StorageBucketName, key: string, expiresInSeconds: number, downloadFilename?: string): Promise<string>;
}
