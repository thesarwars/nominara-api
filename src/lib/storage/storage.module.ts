import { Global, Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { S3Adapter } from "./s3.adapter.js";
import { resolveStorageConfig } from "./storage-config.js";
import { OBJECT_STORAGE, type ObjectStoragePort } from "./storage.port.js";
import { TenantObjectStore } from "./tenant-object-store.js";

// Group C item 3 - registration only. With no STORAGE_BUCKET_* configured the port is one that answers 503 `degraded` on
// every call: the API still boots, and storage fails closed rather than quietly writing somewhere else.
function unconfiguredPort(): ObjectStoragePort {
  const refuse = (): never => {
    throw new DegradedError({ message: "object storage is not configured" });
  };
  return { put: async () => refuse(), get: async () => refuse(), head: async () => refuse(), delete: async () => refuse(), presignGet: async () => refuse() };
}

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      useFactory: (): ObjectStoragePort => {
        const config = resolveStorageConfig(loadEnv());
        return config === null ? unconfiguredPort() : new S3Adapter(config);
      },
    },
    {
      provide: TenantObjectStore,
      useFactory: (port: ObjectStoragePort): TenantObjectStore => {
        const config = resolveStorageConfig(loadEnv());
        return new TenantObjectStore(port, config?.keyEnv ?? loadEnv().NODE_ENV);
      },
      inject: [OBJECT_STORAGE],
    },
  ],
  // Only TenantObjectStore is injectable: the raw port can name any key in a bucket, so it stays private to this module.
  exports: [TenantObjectStore],
})
export class StorageModule {}
