import { Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CacheModule } from "../../lib/cache/cache.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { MatrixController } from "./matrix.controller.js";
import { MatrixService } from "./matrix.service.js";
import { StorageModule } from "../../lib/storage/storage.module.js";
import { QueueProducerModule } from "../../lib/queue/queue-producer.module.js";
import { QUEUE_PRODUCER_CONNECTION } from "../../lib/queue/queue-producer.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { rollupDirtyKey } from "../../lib/cache/valkey-keys.js";
import { RollupDirtySet } from "../../lib/rollup/dirty-dates.js";
import { RunEstimateService } from "./run-estimate.service.js";
import { RunLifecycleService } from "./run-lifecycle.service.js";
import { RawDownloadService } from "./raw-download.service.js";
import { ReparseGuard } from "./reparse.guard.js";
import { REPARSE_DIRTY_MARKER, ReparseService, type DirtyMarker } from "./reparse.service.js";
import { ResultsListController } from "./results-list.controller.js";
import { ResultsListService } from "./results-list.service.js";
import { ResultDocumentService } from "./result-document.service.js";
import { ResultsController } from "./results.controller.js";
import { RunsController } from "./runs.controller.js";
import { TrackingController } from "./tracking.controller.js";
import { TrackingService } from "./tracking.service.js";

// STORY-034 — the tracking bounded area.
//
// CacheModule is imported explicitly for the reason PromptsModule gives: a
// @Global() module is only global once something has loaded it into the
// graph, and this module compiled on its own — as its own spec does — would
// have nothing to resolve CACHE from. The estimate needs it because the L1
// probe is a cache round trip, and a forecast without L1 would report every
// cell as live.
// QueueProducerModule is what turns a planned run into jobs. The trigger
// plans inside the request's transaction and enqueues after it commits, so
// the producer has to be resolvable from here rather than reached for in a
// worker process that is not running.
// StorageModule is imported for the same reason CacheModule is: it is @Global() but only once something loads it, and the raw
// download (STORY-181) is the first request path to need the TenantObjectStore.
@Module({
  imports: [CacheModule, EntitlementsModule, QueueProducerModule, StorageModule],
  controllers: [TrackingController, RunsController, MatrixController, ResultsController, ResultsListController],
  providers: [
    TrackingService,
    RunEstimateService,
    RunLifecycleService,
    MatrixService,
    ResultDocumentService,
    RawDownloadService,
    ResultsListService,
    ReparseService,
    ReparseGuard,
    {
      // STORY-034 AC9 - a re-parse marks its capture's date dirty on the QUEUE instance (noeviction, persistent), the same set the
      // capture.parse worker writes. The API process holds no other handle on it.
      provide: REPARSE_DIRTY_MARKER,
      useFactory: (redis: Redis): DirtyMarker => {
        const set = new RollupDirtySet(redis, rollupDirtyKey(cacheKeyNamespace()));
        return (entry) => set.mark(entry);
      },
      inject: [QUEUE_PRODUCER_CONNECTION],
    },
  ],
})
export class TrackingModule {}
