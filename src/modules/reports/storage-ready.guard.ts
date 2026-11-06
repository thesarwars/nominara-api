import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_STORAGE_KEY } from "../../api/decorators/require-storage.decorator.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";

// STORY-180 r5 - the export's storage readiness check, as a guard so it runs BEFORE TenantContextInterceptor opens the request
// transaction. With storage not configured the answer is 503 `degraded` before anything is rendered or written. The SDK may resolve
// role credentials over HTTP when a presign needs them; here that happens with no pooled connection held (ADR-0003).
//
// STORY-180 r6: a GLOBAL guard (api.module.ts) registered BEFORE QuotaGuard, keyed on @RequireStorage(). A route-level guard runs after
// every global guard, so QuotaGuard had already reserved a pdf_exports unit when this refused, and nothing ever released it.
@Injectable()
export class StorageReadyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly objects: TenantObjectStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_STORAGE_KEY, [context.getHandler(), context.getClass()]) !== true) return true;
    await this.objects.assertReady();
    return true;
  }
}
