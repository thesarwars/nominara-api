import { CanActivate, Injectable } from "@nestjs/common";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";

// STORY-180 r5 - the export's storage readiness check, as a guard so it runs BEFORE TenantContextInterceptor opens the request
// transaction. With storage not configured the answer is 503 `degraded` before anything is rendered or written. The SDK may resolve
// role credentials over HTTP when a presign needs them; here that happens with no pooled connection held (ADR-0003).
@Injectable()
export class StorageReadyGuard implements CanActivate {
  constructor(private readonly objects: TenantObjectStore) {}

  async canActivate(): Promise<boolean> {
    await this.objects.assertReady();
    return true;
  }
}
