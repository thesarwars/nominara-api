import { Logger } from "@nestjs/common";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { buildObjectLocation, relativeKeyFromStored, StorageKeyError, StorageTenancyError } from "./storage-keys.js";
import type { ObjectHead, ObjectStoragePort, StorageNamespace } from "./storage.port.js";

// Group C item 3 - the tenant layer over the object-storage port.
//
// THE WORKSPACE COMES FROM THE TENANT CONTEXT, NEVER FROM AN ARGUMENT. There is no workspaceId parameter on any method
// here, so a caller cannot name one, and a client-supplied string can only ever be the RELATIVE part of a key (which is
// validated against traversal). Outside a tenant context every unbound call throws before the port is reached: fail closed.
//
// THE INTENDED PATTERN (KAD-06: no network call while a request transaction is open)
//   1. INSIDE the tenant context / transaction: `const bound = store.bind()`. This only READS the workspace id from the
//      context; it does no I/O. Relative-key calls need nothing else.
//   2. AFTER the commit (`afterCommit`) or in a worker with no transaction open: `await bound.put(...)`. The bound store
//      carries the workspace id and key environment captured in step 1, so it works with no context at all, and it
//      cannot be retargeted: it has no workspace parameter and its captured id is frozen.
//   3. Record the returned key in a SECOND short transaction (`raw_object_key`, `object_key`).
// Calling `store.put(...)` directly is the same as `store.bind().put(...)` and so needs the context at call time; it is
// for code that is already inside a tenant context and is not holding a transaction across the await.
//
// Two ways to name an object:
//   relative key   `get("raw", "2026/10/x.json.gz")` - resolved into THIS workspace's prefix.
//   stored key     `getStored("raw", row.raw_object_key)` - the full key a table holds. Refused (StorageTenancyError) unless it
//                  lies inside this workspace's prefix, so a corrupted or forged row cannot read another tenant's blob.
//
// Row Level Security still guards the table that holds the key; this layer is the equivalent for the bucket, which
// Postgres cannot protect.

/** Default lifetime of a presigned URL when the caller states none. Short on purpose. */
export const DEFAULT_PRESIGN_SECONDS = 300;
/** SigV4 allows at most 7 days; the spec's longest link (an oversize scheduled report) is exactly that. */
export const MAX_PRESIGN_SECONDS = 604_800;

export interface PresignOptions {
  readonly expiresInSeconds?: number;
  /** The store answers the GET with `Content-Disposition: attachment` under this name (letters, digits, `.`, `_`, `-` only survive). */
  readonly downloadFilename?: string;
}

export interface PutOptions {
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

const logger = new Logger("object-storage");

/** The key `assertReady` signs. It names no workspace and is never read or written. */
const READINESS_PROBE_KEY = "readiness-probe";

/** A store fixed to ONE workspace at capture time. Obtain it with `TenantObjectStore.bind()` inside the tenant context. */
export class BoundObjectStore {
  constructor(
    private readonly port: ObjectStoragePort,
    private readonly keyEnv: string,
    private readonly workspaceId: string,
  ) {
    Object.freeze(this);
  }

  /** Writes `body` and returns the FULL key to store in the owning table (`raw_object_key`, `object_key`). */
  async put(namespace: StorageNamespace, relative: string, body: Uint8Array | string, options: PutOptions = {}): Promise<string> {
    const workspaceId = this.workspaceId;
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    await this.observe("put", workspaceId, namespace, () =>
      this.port.put({ bucket: location.bucket, key: location.key, body, ...options }),
    );
    return location.key;
  }

  async get(namespace: StorageNamespace, relative: string): Promise<Buffer> {
    const workspaceId = this.workspaceId;
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("get", workspaceId, namespace, () => this.port.get(location.bucket, location.key));
  }

  async head(namespace: StorageNamespace, relative: string): Promise<ObjectHead> {
    const workspaceId = this.workspaceId;
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("head", workspaceId, namespace, () => this.port.head(location.bucket, location.key));
  }

  async delete(namespace: StorageNamespace, relative: string): Promise<void> {
    const workspaceId = this.workspaceId;
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("delete", workspaceId, namespace, () => this.port.delete(location.bucket, location.key));
  }

  async presignGet(namespace: StorageNamespace, relative: string, options: PresignOptions = {}): Promise<string> {
    const workspaceId = this.workspaceId;
    const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_PRESIGN_SECONDS;
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_PRESIGN_SECONDS) {
      throw new StorageKeyError("presign lifetime must be a whole number of seconds from 1 to 604800");
    }
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("presign", workspaceId, namespace, () =>
      options.downloadFilename === undefined
        ? this.port.presignGet(location.bucket, location.key, expiresInSeconds)
        : this.port.presignGet(location.bucket, location.key, expiresInSeconds, options.downloadFilename),
    );
  }

  async getStored(namespace: StorageNamespace, stored: string): Promise<Buffer> {
    return this.get(namespace, this.relativeOf(namespace, stored));
  }

  async headStored(namespace: StorageNamespace, stored: string): Promise<ObjectHead> {
    return this.head(namespace, this.relativeOf(namespace, stored));
  }

  async deleteStored(namespace: StorageNamespace, stored: string): Promise<void> {
    return this.delete(namespace, this.relativeOf(namespace, stored));
  }

  async presignGetStored(namespace: StorageNamespace, stored: string, options: PresignOptions = {}): Promise<string> {
    return this.presignGet(namespace, this.relativeOf(namespace, stored), options);
  }

  private relativeOf(namespace: StorageNamespace, stored: string): string {
    const workspaceId = this.workspaceId;
    return relativeKeyFromStored(this.keyEnv, workspaceId, namespace, stored);
  }

  // One span-shaped log line and one counter per operation. The line carries the workspace ID, the operation, the
  // namespace and the duration - never the key (it embeds nothing secret, but a raw key is an identifier for a
  // customer's data), never a URL (a presigned URL IS a credential), and never credentials or body content.
  private async observe<T>(operation: string, workspaceId: string, namespace: StorageNamespace, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await run();
      incrementCounter("nominara_storage_operations_total", { operation, namespace, outcome: "ok" });
      logger.log({ span: `storage.${operation}`, workspace_id: workspaceId, namespace, outcome: "ok", duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      const outcome = error instanceof Error && error.name === "NotFoundError" ? "not_found" : "error";
      incrementCounter("nominara_storage_operations_total", { operation, namespace, outcome });
      logger.warn({
        span: `storage.${operation}`,
        workspace_id: workspaceId,
        namespace,
        outcome,
        error: error instanceof Error ? error.name : "unknown",
        duration_ms: Date.now() - started,
      });
      throw error;
    }
  }
}

export class TenantObjectStore {
  constructor(
    private readonly port: ObjectStoragePort,
    private readonly keyEnv: string,
  ) {}

  /**
   * Readiness: can this process presign at all? Mints a 1-second URL for a fixed key of NO workspace and discards it, so it needs no
   * tenant context and can run BEFORE a request transaction opens (credential resolution is the only thing that can block). Throws
   * the port's error (503 `degraded` when storage is not configured).
   */
  async assertReady(): Promise<void> {
    await this.port.presignGet("reports", READINESS_PROBE_KEY, 1);
  }

  /** Captures the CURRENT tenant context's workspace. Call it inside the context; use the result anywhere, later. */
  bind(): BoundObjectStore {
    const store = currentTenantStore();
    if (store === undefined) throw new StorageTenancyError("object storage requires an active tenant context");
    return new BoundObjectStore(this.port, this.keyEnv, store.context.workspaceId);
  }

  async put(namespace: StorageNamespace, relative: string, body: Uint8Array | string, options: PutOptions = {}): Promise<string> {
    return this.bind().put(namespace, relative, body, options);
  }
  async get(namespace: StorageNamespace, relative: string): Promise<Buffer> {
    return this.bind().get(namespace, relative);
  }
  async head(namespace: StorageNamespace, relative: string): Promise<ObjectHead> {
    return this.bind().head(namespace, relative);
  }
  async delete(namespace: StorageNamespace, relative: string): Promise<void> {
    return this.bind().delete(namespace, relative);
  }
  async presignGet(namespace: StorageNamespace, relative: string, options: PresignOptions = {}): Promise<string> {
    return this.bind().presignGet(namespace, relative, options);
  }
  async getStored(namespace: StorageNamespace, stored: string): Promise<Buffer> {
    return this.bind().getStored(namespace, stored);
  }
  async headStored(namespace: StorageNamespace, stored: string): Promise<ObjectHead> {
    return this.bind().headStored(namespace, stored);
  }
  async deleteStored(namespace: StorageNamespace, stored: string): Promise<void> {
    return this.bind().deleteStored(namespace, stored);
  }
  async presignGetStored(namespace: StorageNamespace, stored: string, options: PresignOptions = {}): Promise<string> {
    return this.bind().presignGetStored(namespace, stored, options);
  }
}
