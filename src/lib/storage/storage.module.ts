import { Global, Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { S3Adapter } from "./s3.adapter.js";
import { resolveStorageConfig } from "./storage-config.js";
import { OBJECT_STORAGE, type ObjectStoragePort } from "./storage.port.js";
import { unconfiguredStoragePort } from "./unconfigured-port.js";
import { TenantObjectStore } from "./tenant-object-store.js";

// Group C item 3 - registration only. With no STORAGE_BUCKET_* configured the port is one that answers 503 `degraded` on
// every call (unconfigured-port.ts): the API still boots, and storage fails closed rather than quietly writing somewhere else.
@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      useFactory: (): ObjectStoragePort => {
        const config = resolveStorageConfig(loadEnv());
        return config === null ? unconfiguredStoragePort() : new S3Adapter(config);
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
