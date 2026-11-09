import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { DbModule } from "../../db/db.module.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { CacheModule } from "../../lib/cache/cache.module.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { EntitlementsController } from "./entitlements.controller.js";
import { PublicPlansController } from "./public-plans.controller.js";
import { PublicPlansService } from "./public-plans.service.js";
import { EntitlementsService } from "./entitlements.service.js";

// STORY-022 scaffold, filled in by STORY-069.
//
// Both resolution providers are EXPORTED because EntitlementGuard needs them
// and the guard is registered in ApiModule (APP_GUARD), which already imports
// this module. Registering them there instead would put the entitlement
// machinery in the composition root rather than in the bounded area that owns
// it, and would leave this module's own controller resolving entitlements
// through a second, separately-constructed instance.
//
// Factories rather than plain classes for the same reason RateLimitBuckets
// uses one: both constructors take infrastructure by value (a Cache, a Pool)
// so a test can supply either, and Nest cannot resolve those by type.
// DbModule and CacheModule are imported EXPLICITLY even though both are
// @Global(). A global module is only global once something has loaded it into
// the graph, so this module compiled on its own — as its own spec does — would
// have nothing to resolve CACHE or PG_POOL from. IdentityModule imports
// DbModule for the same reason.
@Module({
  imports: [DbModule, CacheModule],
  controllers: [EntitlementsController, PublicPlansController],
  providers: [
    EntitlementsService,
    PublicPlansService,
    {
      provide: EntitlementResolver,
      useFactory: (cache: Cache, pool: Pool): EntitlementResolver => new EntitlementResolver(cache, pool),
      inject: [CACHE, PG_POOL],
    },
    {
      provide: StructuralUsage,
      useFactory: (pool: Pool): StructuralUsage => new StructuralUsage(pool),
      inject: [PG_POOL],
    },
  ],
  exports: [EntitlementResolver, StructuralUsage],
})
export class EntitlementsModule {}
