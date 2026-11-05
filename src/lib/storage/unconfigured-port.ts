import { DegradedError } from "../../api/errors/domain-errors.js";
import type { ObjectStoragePort } from "./storage.port.js";

/** The port used when no STORAGE_BUCKET_* is configured: every call answers 503 `degraded`. Shared by the API module and the worker handlers. */
export function unconfiguredStoragePort(): ObjectStoragePort {
  const refuse = (): never => {
    throw new DegradedError({ message: "object storage is not configured" });
  };
  return { put: async () => refuse(), get: async () => refuse(), head: async () => refuse(), delete: async () => refuse(), presignGet: async () => refuse() };
}
