import { Logger } from "@nestjs/common";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { buildObjectLocation, relativeKeyFromStored, StorageKeyError, StorageTenancyError } from "./storage-keys.js";
import type { ObjectHead, ObjectStoragePort, StorageNamespace } from "./storage.port.js";

// Group C item 3 - the tenant layer over the object-storage port.
//
// THE WORKSPACE COMES FROM THE TENANT CONTEXT, NEVER FROM AN ARGUMENT. There is no workspaceId parameter on any method
// here, so a caller cannot name one, and a client-supplied string can only ever be the RELATIVE part of a key (which is
// validated against traversal). Outside a tenant context every method throws before the port is reached: fail closed.
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
}

export interface PutOptions {
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

const logger = new Logger("object-storage");

export class TenantObjectStore {
  constructor(
    private readonly port: ObjectStoragePort,
    private readonly keyEnv: string,
  ) {}

  /** Writes `body` and returns the FULL key to store in the owning table (`raw_object_key`, `object_key`). */
  async put(namespace: StorageNamespace, relative: string, body: Uint8Array | string, options: PutOptions = {}): Promise<string> {
    const { workspaceId } = this.requireWorkspace();
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    await this.observe("put", workspaceId, namespace, () =>
      this.port.put({ bucket: location.bucket, key: location.key, body, ...options }),
    );
    return location.key;
  }

  async get(namespace: StorageNamespace, relative: string): Promise<Buffer> {
    const { workspaceId } = this.requireWorkspace();
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("get", workspaceId, namespace, () => this.port.get(location.bucket, location.key));
  }

  async head(namespace: StorageNamespace, relative: string): Promise<ObjectHead> {
    const { workspaceId } = this.requireWorkspace();
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("head", workspaceId, namespace, () => this.port.head(location.bucket, location.key));
  }

  async delete(namespace: StorageNamespace, relative: string): Promise<void> {
    const { workspaceId } = this.requireWorkspace();
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("delete", workspaceId, namespace, () => this.port.delete(location.bucket, location.key));
  }

  async presignGet(namespace: StorageNamespace, relative: string, options: PresignOptions = {}): Promise<string> {
    const { workspaceId } = this.requireWorkspace();
    const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_PRESIGN_SECONDS;
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_PRESIGN_SECONDS) {
      throw new StorageKeyError("presign lifetime must be a whole number of seconds from 1 to 604800");
    }
    const location = buildObjectLocation(this.keyEnv, workspaceId, namespace, relative);
    return this.observe("presign", workspaceId, namespace, () => this.port.presignGet(location.bucket, location.key, expiresInSeconds));
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
    const { workspaceId } = this.requireWorkspace();
    return relativeKeyFromStored(this.keyEnv, workspaceId, namespace, stored);
  }

  private requireWorkspace(): { workspaceId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new StorageTenancyError("object storage requires an active tenant context");
    return { workspaceId: store.context.workspaceId };
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
