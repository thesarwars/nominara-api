import type { Env } from "../../config/env.schema.js";
import { S3Adapter } from "../storage/s3.adapter.js";
import { resolveStorageConfig } from "../storage/storage-config.js";
import type { ObjectStoragePort } from "../storage/storage.port.js";
import { TenantObjectStore } from "../storage/tenant-object-store.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-181 - the raw-capture view of the tenant object store, for the capture workers.
//
// `bind()` MUST BE CALLED INSIDE THE TENANT CONTEXT: it only reads the workspace id from it (no I/O), and the returned object
// carries that workspace for good. There is no workspace parameter anywhere on it, so a caller cannot name another tenant's prefix,
// and a stored key from a row is resolved through `getStored`, which refuses anything outside that prefix (StorageTenancyError).

export interface BoundRawObjects {
  /** Writes the gzip and returns the FULL key to record in `answer_captures.raw_object_key`. */
  put(relative: string, body: Buffer): Promise<string>;
  /** Reads the object a row's `raw_object_key` names. Throws StorageTenancyError for a key outside this workspace. */
  getStored(stored: string): Promise<Buffer>;
  /** Best-effort cleanup of an object whose row was never written. */
  deleteStored(stored: string): Promise<void>;
}

type StorageEnv = Pick<Env, "NODE_ENV"> & Partial<Pick<Env, "STORAGE_ENDPOINT" | "STORAGE_REGION" | "STORAGE_BUCKET_RAW" | "STORAGE_BUCKET_REPORTS" | "STORAGE_ACCESS_KEY_ID" | "STORAGE_SECRET_ACCESS_KEY" | "STORAGE_FORCE_PATH_STYLE" | "STORAGE_SSE" | "STORAGE_KMS_KEY_ID" | "STORAGE_KEY_ENV">>;

export class RawObjectStorageNotConfiguredError extends Error {
  constructor() {
    super("object storage is not configured: the raw capture object cannot be written or read");
    this.name = "RawObjectStorageNotConfiguredError";
  }
}

export interface RawObjectStores {
  /**
   * The bound store, or `undefined` when storage is not configured AND this is not production. In production an unconfigured
   * store throws: a verbatim retained copy that silently was not retained is the failure this layer exists to prevent. Outside
   * production the API and the workers boot without storage (it is optional in the env schema), and a capture then has no object:
   * the legacy payload path, counted so it is visible.
   */
  bindForWrite(): BoundRawObjects | undefined;
  /** The bound store for a row that DOES name an object. Unconfigured is always an error here: the object cannot be read. */
  bindForRead(): BoundRawObjects;
}

export function rawObjectStores(env: StorageEnv, port?: ObjectStoragePort): RawObjectStores {
  const config = resolveStorageConfig(env);
  // One adapter (one SDK client) for the process, built on first use; the BINDING is per job, inside that job's tenant context.
  let adapter: ObjectStoragePort | undefined = port;

  const bind = (): BoundRawObjects => {
    if (config === null) throw new RawObjectStorageNotConfiguredError();
    adapter ??= new S3Adapter(config);
    const bound = new TenantObjectStore(adapter, config.keyEnv).bind();
    return {
      put: (relative, body) => bound.put("raw", relative, body, { contentType: "application/gzip" }),
      getStored: (stored) => bound.getStored("raw", stored),
      deleteStored: (stored) => bound.deleteStored("raw", stored),
    };
  };

  return {
    bindForWrite: () => {
      if (config === null) {
        if (env.NODE_ENV === "production") throw new RawObjectStorageNotConfiguredError();
        incrementCounter("nominara_capture_raw_objects_total", { outcome: "storage_unconfigured" });
        return undefined;
      }
      return bind();
    },
    bindForRead: bind,
  };
}
